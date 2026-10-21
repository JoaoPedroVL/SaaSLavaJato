-- =============================================================
-- Serviços editáveis pelo dono
--
-- O dono passa a cadastrar/editar serviços e preços pelo painel.
-- `services` e `service_prices` já existem; aqui só acrescentamos
-- a categoria (opcional) e endurecemos a proteção dos preços.
-- =============================================================
set search_path = public, extensions;

alter table public.services
  add column if not exists category text;

-- A view pública passa a expor a categoria do serviço (no fim da lista,
-- que é o que o create or replace view permite) e só aceita preço do
-- mesmo tenant do serviço.
create or replace view public.public_services as
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
    s.sort_order,
    s.category
  from public.services s
  join public.tenants t on t.id = s.tenant_id
  join public.service_prices sp
    on sp.service_id = s.id and sp.tenant_id = s.tenant_id
  join public.vehicles v on v.id = sp.vehicle_id
  where s.active and t.active;

grant select on public.public_services to anon, authenticated;

-- Um membro só pode mexer em preço de serviço do próprio lava-jato.
-- (O tenant_id sozinho não garantia que o service_id era do mesmo tenant.)
drop policy if exists service_prices_member_all on public.service_prices;
create policy service_prices_member_all on public.service_prices
  for all
  using (
    public.is_member(tenant_id)
    and exists (
      select 1
      from public.services s
      where s.id = service_prices.service_id
        and s.tenant_id = service_prices.tenant_id
    )
  )
  with check (
    public.is_member(tenant_id)
    and exists (
      select 1
      from public.services s
      where s.id = service_prices.service_id
        and s.tenant_id = service_prices.tenant_id
    )
  );
