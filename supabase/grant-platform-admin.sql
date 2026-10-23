-- =============================================================
-- Libera o PAINEL MASTER para um usuário.
--
-- 1. Crie o usuário em Authentication > Users
--    (marque "Auto Confirm User").
-- 2. Troque o e-mail abaixo pelo e-mail desse usuário.
-- 3. Rode no SQL Editor do Supabase.
-- =============================================================

insert into public.platform_admins (user_id, name)
select
  u.id,
  coalesce(nullif(u.raw_user_meta_data->>'name', ''), u.email)
from auth.users u
where u.email = 'seu-email@exemplo.com'
on conflict (user_id) do update set name = excluded.name;

-- Conferir:
-- select u.email, a.name, a.created_at
-- from public.platform_admins a
-- join auth.users u on u.id = a.user_id;
