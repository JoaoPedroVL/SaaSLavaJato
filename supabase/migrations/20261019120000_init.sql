-- =============================================================
-- LavaJato SaaS — schema inicial (multi-tenant)
-- Um único banco, todos os lava-jatos separados por tenant_id + RLS.
-- =============================================================

set search_path = public, extensions;

create extension if not exists btree_gist with schema extensions;

-- -------------------------------------------------------------
-- TENANTS (cada lava-jato é um tenant)
-- -------------------------------------------------------------
create table public.tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name        text not null,
  timezone    text not null default 'America/Sao_Paulo',
  whatsapp    text,
  address     text,
  map_query   text,
  logo_url    text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- -------------------------------------------------------------
-- QUEM ACESSA O ADMIN
-- -------------------------------------------------------------
create table public.memberships (
  user_id    uuid not null references auth.users(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  role       text not null default 'owner' check (role in ('owner','staff')),
  created_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);

-- -------------------------------------------------------------
-- VEÍCULOS (catálogo global)
-- -------------------------------------------------------------
create table public.vehicles (
  id          text primary key,
  name        text not null,
  hint        text,
  time_factor numeric(4,2) not null default 1 check (time_factor > 0),
  sort_order  int not null default 0
);

-- -------------------------------------------------------------
-- SERVIÇOS E PREÇOS
-- -------------------------------------------------------------
create table public.services (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  description text,
  minutes     int not null check (minutes > 0),
  sort_order  int not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create index services_tenant_idx on public.services (tenant_id);

create table public.service_prices (
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  service_id       uuid not null references public.services(id) on delete cascade,
  vehicle_id       text not null references public.vehicles(id),
  price_cents      int not null check (price_cents > 0),
  minutes_override int check (minutes_override > 0),
  primary key (service_id, vehicle_id)
);

-- -------------------------------------------------------------
-- HORÁRIO DE FUNCIONAMENTO (0 = domingo ... 6 = sábado)
-- -------------------------------------------------------------
create table public.business_hours (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  weekday   smallint not null check (weekday between 0 and 6),
  opens_at  time,
  closes_at time,
  closed    boolean not null default false,
  primary key (tenant_id, weekday),
  check (closed or (opens_at is not null and closes_at is not null and closes_at > opens_at))
);

-- -------------------------------------------------------------
-- CLIENTES
-- -------------------------------------------------------------
create table public.customers (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  phone      text,
  plate      text,
  notes      text,
  created_at timestamptz not null default now()
);
create index customers_tenant_phone_idx on public.customers (tenant_id, phone);

-- -------------------------------------------------------------
-- AGENDAMENTOS
-- -------------------------------------------------------------
create table public.bookings (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique
              default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  service_id  uuid not null references public.services(id),
  vehicle_id  text not null references public.vehicles(id),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  price_cents int not null check (price_cents >= 0),
  status      text not null default 'confirmed'
              check (status in ('pending','confirmed','done','cancelled','no_show')),
  notes       text,
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index bookings_tenant_start_idx on public.bookings (tenant_id, starts_at);

-- O banco recusa fisicamente dois agendamentos sobrepostos no mesmo lava-jato.
-- É a proteção contra duas pessoas clicando no mesmo horário ao mesmo tempo.
alter table public.bookings
  add constraint bookings_no_overlap
  exclude using gist (
    tenant_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('pending','confirmed','done'));

-- =============================================================
-- RLS — isolamento entre lava-jatos
-- =============================================================
create or replace function public.is_member(p_tenant uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.user_id = (select auth.uid())
      and m.tenant_id = p_tenant
  );
$$;

alter table public.tenants        enable row level security;
alter table public.memberships    enable row level security;
alter table public.vehicles       enable row level security;
alter table public.services       enable row level security;
alter table public.service_prices enable row level security;
alter table public.business_hours enable row level security;
alter table public.customers      enable row level security;
alter table public.bookings       enable row level security;

-- o usuário só vê/edita o próprio lava-jato
create policy tenants_member_select on public.tenants
  for select using (public.is_member(id));
create policy tenants_member_update on public.tenants
  for update using (public.is_member(id)) with check (public.is_member(id));

-- o usuário só vê os próprios vínculos
create policy memberships_self_select on public.memberships
  for select using (user_id = (select auth.uid()));

-- catálogo de veículos é público (leitura)
create policy vehicles_public_read on public.vehicles
  for select using (true);

-- tabelas do tenant: tudo passa pelo is_member
create policy services_member_all on public.services
  for all using (public.is_member(tenant_id)) with check (public.is_member(tenant_id));

create policy service_prices_member_all on public.service_prices
  for all using (public.is_member(tenant_id)) with check (public.is_member(tenant_id));

create policy business_hours_member_all on public.business_hours
  for all using (public.is_member(tenant_id)) with check (public.is_member(tenant_id));

create policy customers_member_all on public.customers
  for all using (public.is_member(tenant_id)) with check (public.is_member(tenant_id));

create policy bookings_member_all on public.bookings
  for all using (public.is_member(tenant_id)) with check (public.is_member(tenant_id));

-- =============================================================
-- LEITURA PÚBLICA (landing page)
-- Views rodam como o dono (postgres) e expõem só colunas seguras.
-- =============================================================
create view public.public_tenants as
  select slug, name, whatsapp, address, map_query, timezone, logo_url
  from public.tenants
  where active;

create view public.public_services as
  select
    t.slug          as tenant_slug,
    s.id            as service_id,
    s.name,
    s.description,
    s.minutes,
    sp.vehicle_id,
    sp.price_cents,
    coalesce(
      sp.minutes_override,
      case when s.minutes * v.time_factor >= 60
           then round(s.minutes * v.time_factor / 15) * 15
           else round(s.minutes * v.time_factor / 5) * 5
      end
    )::int as duration_minutes,
    s.sort_order
  from public.services s
  join public.tenants t on t.id = s.tenant_id
  join public.service_prices sp on sp.service_id = s.id
  join public.vehicles v on v.id = sp.vehicle_id
  where s.active and t.active;

create view public.public_hours as
  select t.slug as tenant_slug, h.weekday, h.opens_at, h.closes_at, h.closed
  from public.business_hours h
  join public.tenants t on t.id = h.tenant_id
  where t.active;

grant usage on schema public to anon, authenticated;
grant select on public.public_tenants, public.public_services, public.public_hours to anon, authenticated;

-- tabelas do admin: o RLS continua filtrando por tenant
grant select, insert, update, delete on
  public.tenants, public.services, public.service_prices,
  public.business_hours, public.customers, public.bookings
to authenticated;
grant select on public.memberships to authenticated;
grant select on public.vehicles to anon, authenticated;

-- =============================================================
-- AGENDAMENTO PÚBLICO (chamado pela landing)
-- Recalcula preço no servidor e usa a constraint acima como rede de segurança.
-- =============================================================
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
begin
  if coalesce(trim(p_name), '') = '' then
    raise exception 'name_required';
  end if;

  select * into v_tenant from public.tenants
   where slug = p_slug and active;
  if not found then raise exception 'tenant_not_found'; end if;

  -- o serviço precisa ser do tenant informado (não dá pra agendar no serviço de outro)
  select * into v_service from public.services
   where id = p_service_id and tenant_id = v_tenant.id and active;
  if not found then raise exception 'service_not_found'; end if;

  select * into v_vehicle from public.vehicles where id = p_vehicle_id;
  if not found then raise exception 'vehicle_not_found'; end if;

  -- preço sempre vem do banco, nunca do cliente
  select sp.price_cents, coalesce(sp.minutes_override, v_service.minutes)
    into v_price, v_minutes
    from public.service_prices sp
   where sp.service_id = v_service.id
     and sp.vehicle_id = v_vehicle.id;

  if v_price is null then raise exception 'price_not_found'; end if;

  if p_starts_at < now() then raise exception 'past_slot'; end if;

  v_end   := p_starts_at + make_interval(mins => v_minutes);
  v_local := p_starts_at at time zone v_tenant.timezone;

  -- precisa estar dentro do horário de funcionamento
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

  -- reaproveita o cliente pelo telefone dentro do mesmo lava-jato
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
    (tenant_id, customer_id, service_id, vehicle_id, starts_at, ends_at, price_cents)
  values
    (v_tenant.id, v_customer, v_service.id, v_vehicle.id, p_starts_at, v_end, v_price)
  returning * into v_booking;

  return jsonb_build_object(
    'code',        v_booking.code,
    'starts_at',   v_booking.starts_at,
    'ends_at',     v_booking.ends_at,
    'price_cents', v_booking.price_cents,
    'service',     v_service.name,
    'vehicle',     v_vehicle.name
  );

exception
  when exclusion_violation then
    raise exception 'slot_taken';
end;
$$;

grant execute on function public.create_booking(text, uuid, text, timestamptz, text, text)
  to anon, authenticated;

-- =============================================================
-- AGENDAMENTOS OCUPADOS (para a landing mostrar só horário livre)
-- =============================================================
create or replace function public.busy_slots(p_slug text, p_day date)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql stable security definer
set search_path = public
as $$
  select b.starts_at, b.ends_at
  from public.bookings b
  join public.tenants t on t.id = b.tenant_id
  where t.slug = p_slug
    and t.active
    and b.status in ('pending','confirmed','done')
    and b.starts_at >= (p_day::timestamp at time zone t.timezone)
    and b.starts_at <  ((p_day + 1)::timestamp at time zone t.timezone);
$$;

grant execute on function public.busy_slots(text, date) to anon, authenticated;
