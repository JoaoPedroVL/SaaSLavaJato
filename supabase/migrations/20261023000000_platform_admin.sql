-- =============================================================
-- PAINEL MASTER DO SAAS
-- Um administrador da plataforma enxerga todos os lava-jatos.
-- O dono continua com o painel normal, limitado ao próprio tenant.
-- =============================================================

-- -------------------------------------------------------------
-- QUEM É ADMINISTRADOR DA PLATAFORMA
-- -------------------------------------------------------------
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  name       text,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

drop policy if exists platform_admins_self_select on public.platform_admins;
create policy platform_admins_self_select on public.platform_admins
  for select using (user_id = (select auth.uid()));

grant select on public.platform_admins to authenticated;

create or replace function public.is_platform_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.platform_admins
    where user_id = (select auth.uid())
  );
$$;

-- -------------------------------------------------------------
-- DADOS INTERNOS DO TENANT: DONO, COBRANÇA E OBSERVAÇÕES
-- -------------------------------------------------------------
create table if not exists public.tenant_meta (
  tenant_id             uuid primary key references public.tenants(id) on delete cascade,
  owner_name            text,
  owner_email           text,
  owner_phone           text,
  billing_status        text not null default 'pending'
                        check (billing_status in ('paid','pending','trial','cancelled')),
  billing_amount_cents  int check (billing_amount_cents >= 0),
  billing_due_date      date,
  billing_paid_at       timestamptz,
  billing_notes         text,
  internal_notes        text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists tenant_meta_billing_due_idx
  on public.tenant_meta (billing_due_date);

alter table public.tenant_meta enable row level security;

drop policy if exists tenant_meta_platform_all on public.tenant_meta;
create policy tenant_meta_platform_all on public.tenant_meta
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

grant select, insert, update, delete on public.tenant_meta to authenticated;

-- Todo tenant existente ganha uma ficha interna.
insert into public.tenant_meta (tenant_id)
select id from public.tenants
on conflict (tenant_id) do nothing;

-- -------------------------------------------------------------
-- ACESSO TOTAL DO MASTER AOS DADOS DOS TENANTS
-- As políticas do dono continuam valendo; estas são somadas.
-- -------------------------------------------------------------
drop policy if exists tenants_platform_all on public.tenants;
create policy tenants_platform_all on public.tenants
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists memberships_platform_all on public.memberships;
create policy memberships_platform_all on public.memberships
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists services_platform_all on public.services;
create policy services_platform_all on public.services
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists service_prices_platform_all on public.service_prices;
create policy service_prices_platform_all on public.service_prices
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists business_hours_platform_all on public.business_hours;
create policy business_hours_platform_all on public.business_hours
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists customers_platform_all on public.customers;
create policy customers_platform_all on public.customers
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists bookings_platform_all on public.bookings;
create policy bookings_platform_all on public.bookings
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists boxes_platform_all on public.boxes;
create policy boxes_platform_all on public.boxes
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists time_blocks_platform_all on public.time_blocks;
create policy time_blocks_platform_all on public.time_blocks
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists tenant_site_platform_all on public.tenant_site;
create policy tenant_site_platform_all on public.tenant_site
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());

drop policy if exists vehicles_platform_all on public.vehicles;
create policy vehicles_platform_all on public.vehicles
  for all using (public.is_platform_admin())
  with check (public.is_platform_admin());
grant insert, update, delete on public.vehicles to authenticated;
