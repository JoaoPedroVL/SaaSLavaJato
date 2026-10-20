# LavaJato SaaS — v0

SaaS de agenda e agendamento por WhatsApp para lava-jatos.

## Estado atual

- `site/index.html` — landing page (HTML + CSS, sem build)
- `site/app.js` — carrega dados do Supabase, monta a página e conduz o chat
- `site/config.js` — URL, anon key e slug do lava-jato
- `supabase/` — schema do banco (migrações + seed)
- `referencias/` — imagens e HTML usados como base

**Projeto Supabase:** `mcccxsovuouleorxfgnr` (SaaSLavaJato, us-west-2)
**Site publicado:** ainda não

A landing **já lê e grava no banco**: serviços, preços, durações e horários vêm
das views públicas; o chat consulta `busy_slots` e grava com `create_booking`.

## Rodar o site

```bash
cd site
python3 -m http.server 8080
```

Abra <http://localhost:8080>. Trocar de lava-jato: <http://localhost:8080/?loja=demo-b>.

> Use o servidor (não `file://`): o chat faz `fetch` na API do Supabase.

## Banco de dados

Um único projeto Supabase, multi-tenant: cada lava-jato é uma linha em
`tenants`, e todas as tabelas têm `tenant_id` protegido por RLS.

```
tenants        lava-jatos (slug, nome, whatsapp, endereço, fuso)
memberships    quem acessa o admin de qual lava-jato
vehicles       hatch, sedan, suv, picape (catálogo global)
services       serviços de cada lava-jato
service_prices preço e duração por serviço × veículo
business_hours horário de funcionamento
customers      clientes de cada lava-jato
bookings       agendamentos (com constraint anti-sobreposição)
```

### Comandos

```bash
# aplicar migrações + seed no projeto remoto
supabase db push --include-seed

# recriar o banco local (precisa do Docker)
supabase start
supabase db reset
```

### Chaves

Copie `.env.example` para `.env.local` e preencha. O `.env.local` já está
criado e **não vai para o git**.

- `SUPABASE_ANON_KEY` — pública, pode ir para o navegador
- `SUPABASE_SERVICE_ROLE_KEY` — **nunca** no navegador

### Dar acesso ao admin para alguém

1. Crie o usuário em Authentication > Users
2. Copie o UUID do usuário e rode no SQL Editor:

```sql
insert into public.memberships (user_id, tenant_id, role)
values (
  '<uuid-do-usuario>',
  (select id from public.tenants where slug = 'caprichoso'),
  'owner'
);
```

### O que já está protegido

- RLS ligado em todas as tabelas: um lava-jato não enxerga dado do outro
- `create_booking()` recalcula o preço no servidor (nunca confia no cliente)
- `EXCLUDE` constraint impede dois agendamentos no mesmo horário
- `create_booking()` valida serviço do próprio tenant e horário de funcionamento
- Leitura pública só pelas views `public_tenants`, `public_services` e `public_hours`

## O que a página já faz

- Lê do banco: nome, WhatsApp, endereço, mapa, horário, serviços, preços e durações
- Seletor de porte do veículo (hatch, sedan, SUV, picape) — preço e tempo por categoria,
  escolha salva no `localStorage`
- Tabela de serviços que se atualiza conforme o veículo
- Chat: veículo → serviço → dia → horário → nome → WhatsApp → confirmação
- Horários livres calculados de verdade (`busy_slots` + horário de funcionamento)
- Grava o agendamento (`create_booking`), mostra o código, gera arquivo `.ics`
  para o calendário e link de WhatsApp com o código
- Trata `slot_taken` (horário acabou de ser pego), `outside_hours` e `past_slot`
- Status "aberto agora" no fuso do lava-jato
- Slider antes/depois, prova social, FAQ, mapa, SEO local, barra fixa no celular
- Se o banco não responder, a página continua de pé e oferece o WhatsApp

## O que ainda é fixo (por lava-jato)

Está em `site/index.html` / `site/app.js`, porque é identidade visual e conteúdo
editorial — não muda por preço:

- Logo, nome no topo, cidade no hero, fotos e textos
- `CONTENT.reviews` e `CONTENT.faq` em `site/app.js`
- JSON-LD do `<head>` (para multi-tenant de verdade precisa ser renderizado no servidor)

O número de WhatsApp, endereço e horários **não** são fixos: vêm da tabela `tenants`
e de `business_hours`.

## Próximos passos

1. ~~Receber fotos reais em `site/assets/`~~ ✅ (antes.jpg / depois.jpg)
2. Trocar o WhatsApp e os preços reais no banco (seed ou admin)
3. Admin: agenda, clientes, dashboard com funil e previsão de faturamento
4. WhatsApp: confirmação e lembretes automáticos
5. Rotas por lava-jato (`/caprichoso`) em vez de `?loja=`
6. Tela de gerenciar agendamento (remarcar/cancelar pelo código)
