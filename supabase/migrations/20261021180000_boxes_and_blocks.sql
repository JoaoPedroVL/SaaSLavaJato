-- =============================================================
-- Boxes (vagas) + bloqueios de horário
--
-- Antes: 1 agendamento por horário no lava-jato inteiro.
-- Agora: o dono cria/remove boxes; cada box atende 1 carro por vez.
-- O agendamento público escolhe automaticamente um box livre.
-- =============================================================
set search_path = public, extensions;

-- -------------------------------------------------------------
-- BOXES — cada lava-jato começa com 1 e o dono adiciona mais
-- -------------------------------------------------------------
create table if not exists public.boxes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null check (length(trim(name)) > 0),
  sort_order int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists boxes_tenant_idx
  on public.boxes (tenant_id, sort_order) where active;

-- o nome só precisa ser único entre os boxes ativos; ao remover, o dono
-- pode criar outro box com o mesmo nome depois
alter table public.boxes drop constraint if exists boxes_tenant_id_name_key;
create unique index if not exists boxes_tenant_name_active_idx
  on public.boxes (tenant_id, name) where active;

alter table public.boxes enable row level security;
drop policy if exists boxes_member_all on public.boxes;
create policy boxes_member_all on public.boxes
  for all using (public.is_member(tenant_id)) with check (public.is_member(tenant_id));

grant select, insert, update, delete on public.boxes to authenticated;

-- todo lava-jato que ainda não tem box ganha o Box 1
insert into public.boxes (tenant_id, name, sort_order)
select t.id, 'Box 1', 1
from public.tenants t
where not exists (
  select 1 from public.boxes b where b.tenant_id = t.id and b.active
);

-- -------------------------------------------------------------
-- BOOKINGS.box_id — agendamento passa a ocupar um box
-- -------------------------------------------------------------
alter table public.bookings add column if not exists box_id uuid;

-- agendamentos antigos ficam no primeiro box do lava-jato
update public.bookings b
set box_id = x.id
from (
  select distinct on (tenant_id) id, tenant_id
  from public.boxes
  where active
  order by tenant_id, sort_order, name
) x
where b.box_id is null and b.tenant_id = x.tenant_id;

alter table public.bookings alter column box_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'bookings_box_fk'
       and conrelid = 'public.bookings'::regclass
  ) then
    alter table public.bookings
      add constraint bookings_box_fk foreign key (box_id)
      references public.boxes(id) on delete restrict;
  end if;
end $$;

create index if not exists bookings_box_start_idx
  on public.bookings (tenant_id, box_id, starts_at);

-- a proteção contra dois carros no mesmo box ao mesmo tempo
alter table public.bookings drop constraint if exists bookings_no_overlap;
alter table public.bookings
  add constraint bookings_no_overlap
  exclude using gist (
    tenant_id with =,
    box_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('pending','confirmed','done'));

-- -------------------------------------------------------------
-- BLOQUEIOS — almoço, feriado, imprevisto
-- Valem para todos os boxes do lava-jato.
-- -------------------------------------------------------------
create table if not exists public.time_blocks (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  reason     text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists time_blocks_tenant_idx
  on public.time_blocks (tenant_id, starts_at);

alter table public.time_blocks enable row level security;
drop policy if exists time_blocks_member_all on public.time_blocks;
create policy time_blocks_member_all on public.time_blocks
  for all using (public.is_member(tenant_id)) with check (public.is_member(tenant_id));

grant select, insert, update, delete on public.time_blocks to authenticated;

-- -------------------------------------------------------------
-- create_booking: escolhe um box livre e respeita bloqueios
-- -------------------------------------------------------------
create or replace function public.create_booking(
  p_slug       text,
  p_service_id uuid,
  p_vehicle_id text,
  p_starts_at  timestamptz,
  p_name       text,
  p_phone      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant    public.tenants;
  v_service   public.services;
  v_vehicle   public.vehicles;
  v_price     int;
  v_minutes   int;
  v_end       timestamptz;
  v_booking   public.bookings;
  v_customer  uuid;
  v_local     timestamp;
  v_box       uuid;
  v_box_name  text;
begin
  if coalesce(trim(p_name), '') = '' then
    raise exception 'name_required';
  end if;

  select * into v_tenant from public.tenants
   where slug = p_slug and active;
  if not found then raise exception 'tenant_not_found'; end if;

  select * into v_service from public.services
   where id = p_service_id and tenant_id = v_tenant.id and active;
  if not found then raise exception 'service_not_found'; end if;

  select * into v_vehicle from public.vehicles where id = p_vehicle_id;
  if not found then raise exception 'vehicle_not_found'; end if;

  select
    sp.price_cents,
    coalesce(
      sp.minutes_override,
      case when v_service.minutes * v_vehicle.time_factor >= 60
           then round(v_service.minutes * v_vehicle.time_factor / 15) * 15
           else round(v_service.minutes * v_vehicle.time_factor / 5) * 5
      end
    )
  into v_price, v_minutes
  from public.service_prices sp
  where sp.service_id = v_service.id
    and sp.vehicle_id = v_vehicle.id;

  if v_price is null then raise exception 'price_not_found'; end if;

  if p_starts_at < now() then raise exception 'past_slot'; end if;

  v_end   := p_starts_at + make_interval(mins => v_minutes);
  v_local := p_starts_at at time zone v_tenant.timezone;

  if not exists (
    select 1 from public.business_hours h
     where h.tenant_id = v_tenant.id
       and h.weekday = extract(dow from v_local)::int
       and not h.closed
       and v_local::time >= h.opens_at
       and (v_local + make_interval(mins => v_minutes))::time <= h.closes_at
  ) then
    raise exception 'outside_hours';
  end if;

  -- primeiro box ativo sem agendamento e sem bloqueio nesse intervalo
  select b.id, b.name into v_box, v_box_name
  from public.boxes b
  where b.tenant_id = v_tenant.id and b.active
    and not exists (
      select 1 from public.bookings x
       where x.tenant_id = v_tenant.id
         and x.box_id = b.id
         and x.status in ('pending','confirmed','done')
         and tstzrange(x.starts_at, x.ends_at, '[)')
             && tstzrange(p_starts_at, v_end, '[)')
    )
    and not exists (
      select 1 from public.time_blocks tb
       where tb.tenant_id = v_tenant.id
         and tstzrange(tb.starts_at, tb.ends_at, '[)')
             && tstzrange(p_starts_at, v_end, '[)')
    )
  order by b.sort_order, b.name
  limit 1;

  if v_box is null then raise exception 'slot_taken'; end if;

  if p_phone is not null and length(trim(p_phone)) > 0 then
    select id into v_customer from public.customers
     where tenant_id = v_tenant.id and phone = trim(p_phone)
     limit 1;
  end if;

  if v_customer is null then
    insert into public.customers (tenant_id, name, phone)
    values (v_tenant.id, trim(p_name), nullif(trim(p_phone), ''))
    returning id into v_customer;
  end if;

  insert into public.bookings
    (tenant_id, customer_id, service_id, vehicle_id, box_id,
     starts_at, ends_at, price_cents)
  values
    (v_tenant.id, v_customer, v_service.id, v_vehicle.id, v_box,
     p_starts_at, v_end, v_price)
  returning * into v_booking;

  return jsonb_build_object(
    'code',        v_booking.code,
    'starts_at',   v_booking.starts_at,
    'ends_at',     v_booking.ends_at,
    'price_cents', v_booking.price_cents,
    'service',     v_service.name,
    'vehicle',     v_vehicle.name,
    'box',         v_box_name
  );

exception
  when exclusion_violation then
    raise exception 'slot_taken';
end;
$$;

grant execute on function public.create_booking(text, uuid, text, timestamptz, text, text)
  to anon, authenticated;

-- -------------------------------------------------------------
-- busy_slots: só devolve o horário quando TODOS os boxes estão ocupados
-- (a landing usa isso para esconder horário indisponível)
-- -------------------------------------------------------------
create or replace function public.busy_slots(p_slug text, p_day date)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql stable security definer
set search_path = public
as $$
  with t as (
    select * from public.tenants where slug = p_slug and active
  ),
  cap as (
    select count(*)::int as n
    from public.boxes b
    join t on t.id = b.tenant_id
    where b.active
  ),
  day as (
    select (p_day::timestamp at time zone t.timezone) as s,
           ((p_day + 1)::timestamp at time zone t.timezone) as e
    from t
  ),
  iv as (
    select b.starts_at as s, b.ends_at as e, 1 as weight
    from public.bookings b
    join t on t.id = b.tenant_id
    join public.boxes bx on bx.id = b.box_id and bx.active
    where b.status in ('pending','confirmed','done')
      and b.starts_at < (select e from day)
      and b.ends_at   > (select s from day)
    union all
    select tb.starts_at, tb.ends_at, (select n from cap)
    from public.time_blocks tb
    join t on t.id = tb.tenant_id
    where tb.starts_at < (select e from day)
      and tb.ends_at   > (select s from day)
  ),
  pts as (
    select s as p from iv
    union
    select e from iv
  ),
  seg as (
    select p as s, lead(p) over (order by p) as e from pts
  )
  select seg.s, seg.e
  from seg
  cross join cap
  where seg.e is not null
    and (
      select coalesce(sum(iv.weight), 0)
      from iv
      where iv.s < seg.e and iv.e > seg.s
    ) >= cap.n;
$$;

grant execute on function public.busy_slots(text, date) to anon, authenticated;
