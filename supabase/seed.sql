-- =============================================================
-- Seed de desenvolvimento
-- Roda com: supabase db reset        (local)
--           supabase db push --include-seed   (remoto)
-- =============================================================

-- catálogo de veículos
insert into public.vehicles (id, name, hint, time_factor, sort_order) values
  ('hatch',  'Hatch',  'Onix, HB20, Polo',        1.00, 1),
  ('sedan',  'Sedan',  'Corolla, Civic, Virtus',  1.10, 2),
  ('suv',    'SUV',    'Compass, Creta, T-Cross', 1.25, 3),
  ('picape', 'Picape', 'Hilux, Ranger, Strada',   1.40, 4)
on conflict (id) do update set
  name = excluded.name, hint = excluded.hint,
  time_factor = excluded.time_factor, sort_order = excluded.sort_order;

-- =============================================================
-- Tenant 1: Caprichoso (o do teste)
-- =============================================================
insert into public.tenants (id, slug, name, timezone, whatsapp, address, map_query) values
  ('11111111-1111-1111-1111-111111111111', 'caprichoso',
   'Caprichoso Estética Automotiva', 'America/Sao_Paulo', '5527999999999',
   'Av. Gov. Jones dos Santos Neves, 1000, Linhares, ES', 'Linhares, ES')
on conflict (id) do update set
  slug = excluded.slug, name = excluded.name, timezone = excluded.timezone,
  whatsapp = excluded.whatsapp, address = excluded.address, map_query = excluded.map_query;

insert into public.services (id, tenant_id, name, description, minutes, sort_order) values
  ('a0000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'Lavagem simples', 'Externa com shampoo neutro, secagem e pneus.', 25, 1),
  ('a0000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'Lavagem completa', 'Externa e interna, secagem, vidros e acabamento.', 40, 2),
  ('a0000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   'Higienização interna', 'Bancos, carpete, teto e painel. Sem cheiro de carro velho.', 120, 3),
  ('a0000000-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111',
   'Polimento técnico', 'Remove riscos leves e devolve o brilho original da pintura.', 180, 4),
  ('a0000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111',
   'Cristalização', 'Proteção que mantém o brilho e facilita a próxima lavagem.', 240, 5)
on conflict (id) do update set
  name = excluded.name, description = excluded.description,
  minutes = excluded.minutes, sort_order = excluded.sort_order;

insert into public.service_prices (tenant_id, service_id, vehicle_id, price_cents) values
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000001', 'hatch',   3500),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000001', 'sedan',   4000),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000001', 'suv',     4500),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000001', 'picape',  5500),

  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000002', 'hatch',   4900),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000002', 'sedan',   5900),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000002', 'suv',     6900),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000002', 'picape',  7900),

  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000003', 'hatch',  14900),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000003', 'sedan',  16900),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000003', 'suv',    19900),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000003', 'picape', 22900),

  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000004', 'hatch',  29900),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000004', 'sedan',  34900),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000004', 'suv',    39900),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000004', 'picape', 44900),

  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000005', 'hatch',  49900),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000005', 'sedan',  57900),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000005', 'suv',    65900),
  ('11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-000000000005', 'picape', 74900)
on conflict (service_id, vehicle_id) do update set
  price_cents = excluded.price_cents;

insert into public.business_hours (tenant_id, weekday, opens_at, closes_at, closed) values
  ('11111111-1111-1111-1111-111111111111', 0, null,    null,    true),
  ('11111111-1111-1111-1111-111111111111', 1, '08:00', '18:00', false),
  ('11111111-1111-1111-1111-111111111111', 2, '08:00', '18:00', false),
  ('11111111-1111-1111-1111-111111111111', 3, '08:00', '18:00', false),
  ('11111111-1111-1111-1111-111111111111', 4, '08:00', '18:00', false),
  ('11111111-1111-1111-1111-111111111111', 5, '08:00', '18:00', false),
  ('11111111-1111-1111-1111-111111111111', 6, '08:00', '13:00', false)
on conflict (tenant_id, weekday) do update set
  opens_at = excluded.opens_at, closes_at = excluded.closes_at, closed = excluded.closed;

-- =============================================================
-- Tenant 2: lava-jato de demonstração (prova que os dados não se misturam)
-- Preços de propósito diferentes dos da Caprichoso.
-- =============================================================
insert into public.tenants (id, slug, name, timezone, whatsapp, address, map_query) values
  ('22222222-2222-2222-2222-222222222222', 'demo-b',
   'Lava-Jato Demo B', 'America/Sao_Paulo', '5527988888888',
   'Rua Exemplo, 200, Linhares, ES', 'Linhares, ES')
on conflict (id) do update set
  name = excluded.name, whatsapp = excluded.whatsapp, address = excluded.address;

insert into public.services (id, tenant_id, name, description, minutes, sort_order) values
  ('b0000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   'Lavagem simples', 'Lavagem externa.', 20, 1),
  ('b0000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
   'Lavagem completa', 'Externa e interna.', 35, 2)
on conflict (id) do update set
  name = excluded.name, description = excluded.description, minutes = excluded.minutes;

insert into public.service_prices (tenant_id, service_id, vehicle_id, price_cents) values
  ('22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001', 'hatch',  3000),
  ('22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000001', 'suv',    4000),
  ('22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000002', 'hatch',  4200),
  ('22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-000000000002', 'suv',    5500)
on conflict (service_id, vehicle_id) do update set
  price_cents = excluded.price_cents;

insert into public.business_hours (tenant_id, weekday, opens_at, closes_at, closed) values
  ('22222222-2222-2222-2222-222222222222', 1, '09:00', '17:00', false),
  ('22222222-2222-2222-2222-222222222222', 2, '09:00', '17:00', false),
  ('22222222-2222-2222-2222-222222222222', 3, '09:00', '17:00', false),
  ('22222222-2222-2222-2222-222222222222', 4, '09:00', '17:00', false),
  ('22222222-2222-2222-2222-222222222222', 5, '09:00', '17:00', false)
on conflict (tenant_id, weekday) do update set
  opens_at = excluded.opens_at, closes_at = excluded.closes_at, closed = excluded.closed;

-- =============================================================
-- Conteúdo inicial do site (o painel "Minha marca" altera apenas a cor;
-- textos e fundo ficam reservados para customização premium)
-- =============================================================
insert into public.tenant_site
  (tenant_id, brand_tagline, hero_title, hero_highlight, hero_subtitle, theme_key)
values
  ('11111111-1111-1111-1111-111111111111',
   'Estética Automotiva', 'Seu carro merece', 'capricho.',
   'Lavagem e estética automotiva em Linhares. Preço na tabela, horário na hora e agendamento em 30 segundos — sem ficar esperando resposta.',
   'sun'),
  ('22222222-2222-2222-2222-222222222222',
   'Lava-jato demonstração', 'Seu carro merece', 'capricho.',
   'Lavagem e estética automotiva com preço na tabela, horário na hora e agendamento em 30 segundos — sem ficar esperando resposta.',
   'sky')
on conflict (tenant_id) do nothing;

-- =============================================================
-- Boxes: todo lava-jato começa com 1 vaga; o dono adiciona mais no painel
-- (o guard permite rodar o seed antes da migração de boxes, se precisar)
-- =============================================================
do $$
begin
  if to_regclass('public.boxes') is not null then
    insert into public.boxes (tenant_id, name, sort_order)
    select t.id, 'Box 1', 1
    from public.tenants t
    where not exists (
      select 1 from public.boxes b where b.tenant_id = t.id and b.active
    );
  end if;
end $$;
