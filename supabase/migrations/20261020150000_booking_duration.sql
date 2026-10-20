-- =============================================================
-- Duração do agendamento por porte do veículo
-- A landing mostra a duração já ajustada (public_services.duration_minutes);
-- o create_booking precisa usar exatamente a mesma conta, senão o fim do
-- agendamento fica menor do que o bloco reservado na agenda.
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

  -- o serviço precisa ser do tenant informado
  select * into v_service from public.services
   where id = p_service_id and tenant_id = v_tenant.id and active;
  if not found then raise exception 'service_not_found'; end if;

  select * into v_vehicle from public.vehicles where id = p_vehicle_id;
  if not found then raise exception 'vehicle_not_found'; end if;

  -- preço e duração sempre vêm do banco, nunca do cliente
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
