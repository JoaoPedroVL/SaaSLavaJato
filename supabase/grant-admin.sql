-- =============================================================
-- Libera o acesso ao painel.
-- Rode no SQL Editor do Supabase DEPOIS de criar o usuário em
-- Authentication > Users (marque "Auto Confirm User").
--
-- Por padrão libera o usuário MAIS RECENTE criado, como 'owner'
-- do lava-jato 'caprichoso'. Não precisa trocar nada.
--
-- role: 'owner' ou 'staff' (hoje os dois enxergam a mesma coisa;
-- a distinção fica pronta para quando houver permissões diferentes).
-- =============================================================
insert into public.memberships (user_id, tenant_id, role)
select u.id, t.id, 'owner'
from auth.users u
cross join public.tenants t
where t.slug = 'caprichoso'
  and u.id = (select id from auth.users order by created_at desc limit 1)
on conflict (user_id, tenant_id) do nothing;

-- Conferir o vínculo criado:
-- select u.email, t.name, m.role
-- from public.memberships m
-- join auth.users u on u.id = m.user_id
-- join public.tenants t on t.id = m.tenant_id;

-- =============================================================
-- Alternativa: liberar por e-mail (troque o e-mail antes de rodar)
-- =============================================================
-- insert into public.memberships (user_id, tenant_id, role)
-- select u.id, t.id, 'owner'
-- from auth.users u
-- cross join public.tenants t
-- where u.email = 'dono@caprichoso.com'
--   and t.slug = 'caprichoso'
-- on conflict (user_id, tenant_id) do nothing;
