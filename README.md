# LavaJato SaaS — v0

SaaS de agenda e agendamento por WhatsApp para lava-jatos.

## Estado atual

- `site/index.html` — landing page completa (arquivo único, sem build)
- `supabase/` — schema do banco (migrações + seed)
- `referencias/` — imagens e HTML usados como base

**Projeto Supabase:** `mcccxsovuouleorxfgnr` (SaaSLavaJato, us-west-2)
**Site publicado:** ainda não

## Rodar o site

```bash
cd site
python3 -m http.server 8080
```

Abra <http://localhost:8080>.

Ou simplesmente abra `site/index.html` no navegador.

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

- Seletor de porte do veículo (hatch, sedan, SUV, picape) com preço e tempo por categoria
- Tabela de serviços que se atualiza conforme o veículo
- Chat de agendamento (veículo → serviço → dia → horário → nome → confirmação)
- Slider antes/depois
- Prova social, FAQ, mapa, horário de funcionamento com status "aberto agora"
- SEO local (JSON-LD), Open Graph, favicon
- Barra fixa de CTA no celular

## O que é simulado (e onde plugar depois)

Tudo que é dado do negócio está no objeto `SITE`, no fim do `index.html`:

- `vehicles` — categorias de carro e o fator de tempo de cada uma
- `services[].prices` — preço de cada serviço por categoria (`hatch`, `sedan`, `suv`, `picape`)
- `hours` — tabela `business_hours`
- `reviews` — avaliações reais (hoje são exemplos)
- disponibilidade de horários — função `busy()` e `slotsFor()`; trocar pela API
- confirmação — hoje abre o WhatsApp com a mensagem pronta; depois vira
  `POST /api/bookings`

## Próximos passos

1. ~~Receber fotos reais em `site/assets/`~~ ✅ (antes.jpg / depois.jpg)
2. Trocar o número de WhatsApp em `SITE.whatsapp`
3. Substituir os dados do JSON-LD e do `SITE` pelos reais
4. Ligar a landing no Supabase (views + `create_booking`)
5. Backend/admin: agenda, clientes, dashboard
6. WhatsApp: lembretes e confirmação
