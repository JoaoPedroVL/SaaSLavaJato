-- =============================================================
-- Limpeza dos agendamentos de teste feitos durante o desenvolvimento.
-- Rode no SQL Editor do Supabase (não é migração: não roda sozinho).
-- Seguro: só apaga clientes/agendamentos com "teste" no nome ou
-- telefones do tipo 27 99999-xxxx usados nos testes.
-- =============================================================
delete from public.bookings b
using public.customers c
where c.id = b.customer_id
  and (c.name ilike '%teste%' or c.phone like '2799999%');

delete from public.customers
where name ilike '%teste%' or phone like '2799999%';
