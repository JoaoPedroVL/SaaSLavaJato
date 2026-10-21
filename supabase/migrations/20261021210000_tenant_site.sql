-- =============================================================
-- MARCA DO SITE POR LAVA-JATO
-- A interface padrão expõe apenas logo e cor de destaque. Os
-- campos editoriais abaixo (textos, fundo e seções) ficam
-- reservados para customização premium e não aparecem no painel.
-- =============================================================

create table public.tenant_site (
  tenant_id      uuid primary key references public.tenants(id) on delete cascade,
  brand_tagline  text not null default 'Estética Automotiva'
                 check (char_length(brand_tagline) between 1 and 40),
  hero_title     text not null default 'Seu carro merece'
                 check (char_length(hero_title) between 1 and 90),
  hero_highlight text not null default 'capricho.'
                 check (char_length(hero_highlight) <= 40),
  hero_subtitle  text not null default 'Lavagem e estética automotiva com preço na tabela, horário na hora e agendamento em 30 segundos — sem ficar esperando resposta.'
                 check (char_length(hero_subtitle) between 1 and 240),
  hero_image_url text,
  hero_image_fit text not null default 'cover'
                 check (hero_image_fit in ('cover', 'contain')),
  theme_key      text not null default 'sun'
                 check (theme_key in ('sun', 'sky', 'mint', 'coral')),
  show_stats     boolean not null default true,
  show_gallery   boolean not null default true,
  show_reviews   boolean not null default true,
  show_faq       boolean not null default true,
  updated_at     timestamptz not null default now()
);

alter table public.tenant_site enable row level security;

create policy tenant_site_member_all on public.tenant_site
  for all using (public.is_member(tenant_id))
  with check (public.is_member(tenant_id));

grant select, insert, update, delete on public.tenant_site to authenticated;

-- Cada lava-jato existente ganha uma configuração inicial.
insert into public.tenant_site (tenant_id)
select id from public.tenants
on conflict (tenant_id) do nothing;

-- A landing lê só o conteúdo seguro. O logo continua em public_tenants.
create or replace view public.public_site as
  select
    t.slug as tenant_slug,
    coalesce(s.brand_tagline, 'Estética Automotiva') as brand_tagline,
    coalesce(s.hero_title, 'Seu carro merece') as hero_title,
    coalesce(s.hero_highlight, 'capricho.') as hero_highlight,
    coalesce(s.hero_subtitle, 'Lavagem e estética automotiva com preço na tabela, horário na hora e agendamento em 30 segundos — sem ficar esperando resposta.') as hero_subtitle,
    s.hero_image_url,
    coalesce(s.hero_image_fit, 'cover') as hero_image_fit,
    coalesce(s.theme_key, 'sun') as theme_key,
    coalesce(s.show_stats, true) as show_stats,
    coalesce(s.show_gallery, true) as show_gallery,
    coalesce(s.show_reviews, true) as show_reviews,
    coalesce(s.show_faq, true) as show_faq,
    s.updated_at
  from public.tenants t
  left join public.tenant_site s on s.tenant_id = t.id
  where t.active;

grant select on public.public_site to anon, authenticated;

-- =============================================================
-- LOGO NO SUPABASE STORAGE
-- Bucket público para leitura; escrita só pelo membro do tenant.
-- Caminho: tenant-assets/<tenant_id>/logo-<timestamp>.<ext>
-- =============================================================
create or replace function public.can_manage_tenant_asset(p_name text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.user_id = (select auth.uid())
      and m.tenant_id::text = (storage.foldername(p_name))[1]
  );
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tenant-assets', 'tenant-assets', true, 5242880,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists tenant_assets_public_read on storage.objects;
create policy tenant_assets_public_read on storage.objects
  for select using (bucket_id = 'tenant-assets');

drop policy if exists tenant_assets_member_insert on storage.objects;
create policy tenant_assets_member_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'tenant-assets'
    and public.can_manage_tenant_asset(name)
  );

drop policy if exists tenant_assets_member_update on storage.objects;
create policy tenant_assets_member_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'tenant-assets'
    and public.can_manage_tenant_asset(name)
  )
  with check (
    bucket_id = 'tenant-assets'
    and public.can_manage_tenant_asset(name)
  );

drop policy if exists tenant_assets_member_delete on storage.objects;
create policy tenant_assets_member_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'tenant-assets'
    and public.can_manage_tenant_asset(name)
  );
