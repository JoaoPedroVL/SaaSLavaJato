-- =============================================================
-- Libera o acesso ao painel para um usuário já criado.
-- Rode no SQL Editor do Supabase depois de criar o usuário em
-- Authentication > Users (marque "Auto Confirm User").
--
-- 1. Troque o e-mail abaixo pelo e-mail do dono do lava-jato.
-- 2. Troque o slug se não for o 'caprichoso'.
--
-- role: 'owner' ou 'staff' (hoje os dois enxergam a mesma coisa;
-- a distinção fica pronta para quando houver permissões diferentes).
-- =============================================================
insert into public.memberships (user_id, tenant_id, role)
select u.id, t.id, 'owner'
from auth.users u
cross join public.tenants t
where u.email = 'dono@caprichoso.com'
  and t.slug = 'caprichoso'
on conflict (user_id, tenant_id) do nothing;
