# LavaJato SaaS — v0

SaaS de agenda e agendamento por WhatsApp para lava-jatos.

## Estado atual

- `site/index.html` — landing page (HTML + CSS, sem build)
- `site/app.js` — carrega dados do Supabase, monta a página e conduz o chat
- `site/config.js` — URL, anon key e slug do lava-jato
- `site/admin/` — painel do lava-jato (login, agenda, clientes, resumo, boxes e fechamento)
- `site/master/` — painel do administrador do SaaS (todos os lava-jatos, donos e cobranças)
- `supabase/` — schema do banco (migrações + seed)
- `referencias/` — imagens e HTML usados como base

**Projeto Supabase:** `mcccxsovuouleorxfgnr` (SaaSLavaJato, us-west-2)
**Site publicado:** <https://lopesclean027.netlify.app/>  
**Painel do lava-jato:** <https://lopesclean027.netlify.app/admin/><br>
**Painel master:** <https://lopesclean027.netlify.app/master/>

A landing **já lê e grava no banco**: serviços, preços, durações e horários vêm
das views públicas; o chat consulta `busy_slots` e grava com `create_booking`.

## Rodar o site

```bash
cd site
python3 -m http.server 8080
```

Abra <http://localhost:8080>. Trocar de lava-jato: <http://localhost:8080/?loja=demo-b>.

Painel do lava-jato: <http://localhost:8080/admin/>.<br>
Painel master: <http://localhost:8080/master/>.

> Use o servidor (não `file://`): o chat e o painel fazem `fetch` na API do Supabase.

## Publicar no Netlify

O `netlify.toml` já configura o deploy estático:

- **Publish directory:** `site`
- **Build command:** vazio (não há build)
- **Admin:** `https://SEU-SITE.netlify.app/admin/`
- **Landing:** `https://SEU-SITE.netlify.app/?loja=caprichoso`

Opções:

1. **Netlify conectado ao GitHub:** importe o repositório
   `JoaoPedroVL/SaaSLavaJato`; o `netlify.toml` cuida do resto.
2. **CLI:** `npx netlify-cli deploy --prod --dir=site`
3. **Netlify Drop:** arraste a pasta `site` para <https://app.netlify.com/drop>.

A URL publicada já está configurada em `canonical`, `og:url` e no `image` do
JSON-LD. Se trocar para um domínio próprio, atualize esses três pontos em
`site/index.html`.

## Banco de dados

Um único projeto Supabase, multi-tenant: cada lava-jato é uma linha em
`tenants`, e todas as tabelas têm `tenant_id` protegido por RLS.

```
tenants         lava-jatos (slug, nome, whatsapp, endereço, fuso, logo)
memberships     quem acessa o admin de qual lava-jato
platform_admins quem acessa o painel master (dono do SaaS)
tenant_meta     dados internos: dono, e-mail, telefone, cobrança e observações
tenant_site     marca do site (cor; campos avançados ficam para customização premium)
vehicles       hatch, sedan, suv, picape (catálogo global)
services       serviços de cada lava-jato
service_prices preço e duração por serviço × veículo
business_hours horário de funcionamento
customers      clientes de cada lava-jato
boxes          boxes/vagas de cada lava-jato (o dono adiciona e remove)
bookings       agendamentos (1 box por horário, com constraint anti-sobreposição)
time_blocks    bloqueios de horário (almoço, feriado, imprevisto)
```

### Comandos

```bash
# aplicar as migrações pendentes no projeto remoto
supabase db push

# aplicar um arquivo SQL específico no remoto (sem mexer no histórico)
supabase db query --linked --file supabase/migrations/20261023000000_platform_admin.sql

# ver o que está aplicado no local e no remoto
supabase migration list

# recriar o banco local (precisa do Docker)
supabase start
supabase db reset

# limpar agendamentos de teste (rodar no SQL Editor do Supabase)
# supabase/cleanup-test-data.sql
```

### Chaves

Copie `.env.example` para `.env.local` e preencha. O `.env.local` já está
criado e **não vai para o git**.

- `SUPABASE_ANON_KEY` — pública, pode ir para o navegador
- `SUPABASE_SERVICE_ROLE_KEY` — **nunca** no navegador

### Dar acesso ao painel para alguém

1. Authentication > Users > **Add user** (marque **Auto Confirm User**)
2. Rode `supabase/grant-admin.sql` no SQL Editor — ele libera o usuário
   criado por último como `owner` do `caprichoso`
3. Entre em `/admin` com o e-mail e a senha criados.

Não existe cadastro público no painel: sem uma linha em `memberships`, o login
até funciona, mas nenhum dado aparece.

### Liberar o painel master

O master é separado do dono do lava-jato. Ele enxerga **todos** os tenants e
pode abrir o painel de qualquer um para ajustar marca, serviços, horários,
agenda e clientes. O dono continua com o painel normal, limitado ao próprio
lava-jato.

1. Crie o usuário em **Authentication > Users** (marque **Auto Confirm User**).
2. Edite o e-mail em `supabase/grant-platform-admin.sql`.
3. Rode o arquivo no **SQL Editor** do Supabase.
4. Entre em `/master/` com esse e-mail e senha.

O e-mail `joaoadmin@gmail.com` já está liberado como administrador da
plataforma. Para conferir:

```sql
select u.email, a.name, a.created_at
from public.platform_admins a
join auth.users u on u.id = a.user_id;
```

### Criar um lava-jato novo pelo master

1. Entre em `/master/` e clique em **+ Novo lava-jato**.
2. Preencha nome, slug, WhatsApp, endereço e os dados do dono.
3. Defina valor, vencimento e status da cobrança (pode deixar em branco).
4. Salve. O master cria o tenant, a ficha interna, a configuração inicial do
   site, o horário padrão (seg–sex 08–18, sábado 08–13) e o **Box 1**.
5. Abra **Abrir painel** e cadastre os serviços e preços em **Ajustes**. Sem
   serviços, a landing do novo lava-jato não mostra a tabela de preços.
6. Crie o login do dono em **Authentication > Users** e clique em **Editar** no
   master → **Copiar SQL de acesso**. Cole o SQL no SQL Editor do Supabase: ele
   liga o e-mail do dono ao tenant pelo slug.

O login do dono ainda é manual nesta versão. A criação automática por convite
fica para a fase 2 (Edge Function com `service_role`).

### Cobrança no master

O master guarda o status atual da fatura em `tenant_meta`:

- valor mensal (`billing_amount_cents`);
- vencimento (`billing_due_date`);
- status: **Pago**, **Pendente**, **Em teste** ou **Cancelado**;
- observação e anotações internas.

O status **Atrasado** aparece automaticamente quando está pendente e o
vencimento já passou. Nada é bloqueado sozinho: o master pode sinalizar e
decidir quando usar **Site ativo** (suspender a landing) no cadastro do
lava-jato. O acesso do dono ao `/admin/` continua funcionando mesmo com o site
suspenso.

### Aplicar a migração do painel master

A migração `supabase/migrations/20261023000000_platform_admin.sql` cria:

- `platform_admins` e a função `is_platform_admin()`;
- `tenant_meta` (dono e cobrança);
- políticas de RLS que dão ao master acesso de leitura/escrita aos dados de
  todos os tenants, sem afrouxar o isolamento dos donos.

Já aplicada neste projeto. Para aplicar em outro ambiente:

```bash
supabase db query --linked --file supabase/migrations/20261023000000_platform_admin.sql
```

### Aplicar a migração de boxes (obrigatório para o painel novo)

O painel novo usa `boxes` e `time_blocks`. Enquanto a migração
`supabase/migrations/20261021180000_boxes_and_blocks.sql` não rodar, a agenda
vai falhar ao carregar (a consulta inclui `box_id`).

1. Abra o arquivo `supabase/migrations/20261021180000_boxes_and_blocks.sql`
2. Copie **o conteúdo** (não o caminho do arquivo)
3. Cole no **SQL Editor** do Supabase e clique em **Run**
4. Recarregue `/admin/`

Ela cria o Box 1 para cada lava-jato, joga os agendamentos antigos no Box 1 e
passa a proteção de sobreposição para `(tenant_id, box_id, horário)`.

### Aplicar a migração de serviços (recomendada)

A migração `supabase/migrations/20261021200000_service_editor.sql` cria a
categoria opcional do serviço, atualiza a view pública e fecha uma brecha de RLS
em `service_prices`.

O editor de serviços **funciona sem ela** (a categoria fica escondida e o painel
cai no modo compatível), mas rode para liberar categoria no site e a proteção
nova:

1. Abra o arquivo `supabase/migrations/20261021200000_service_editor.sql`
2. Copie **o conteúdo** (não o caminho do arquivo)
3. Cole no **SQL Editor** do Supabase e clique em **Run**
4. Recarregue `/admin/`

### Aplicar a migração da marca (recomendada)

A migração `supabase/migrations/20261021210000_tenant_site.sql` cria:

- `tenant_site` (cor de destaque e frase de abertura; a base também guarda
  campos avançados que ficam reservados para customização premium);
- a view pública `public_site`, que a landing lê;
- o bucket público `tenant-assets` no Storage e as políticas de upload/remoção
  por lava-jato.

Sem ela, a landing e o resto do painel continuam funcionando; a aba **Minha
marca** mostra um aviso e o upload de logo/cor fica indisponível. Nome e
endereço continuam editáveis.

1. Abra o arquivo `supabase/migrations/20261021210000_tenant_site.sql`
2. Copie **o conteúdo** (não o caminho do arquivo)
3. Cole no **SQL Editor** do Supabase e clique em **Run**
4. Recarregue `/admin/` e abra **Minha marca**

### O que já está protegido

- RLS ligado em todas as tabelas: um lava-jato não enxerga dado do outro
- Um preço só pode apontar para serviço do mesmo lava-jato
- `create_booking()` recalcula o preço no servidor (nunca confia no cliente)
- `EXCLUDE` constraint impede dois agendamentos no mesmo box/horário
- `create_booking()` escolhe automaticamente um box livre, respeita bloqueios e
  valida serviço do próprio tenant e horário de funcionamento
- Leitura pública só pelas views `public_tenants`, `public_services`, `public_hours` e `public_site`
- Upload de logo só pelo membro do lava-jato, em uma pasta com o `tenant_id`
- `platform_admins` só mostra o próprio vínculo; `tenant_meta` é exclusivo do master
- O master ganha acesso aos dados de todos os tenants via `is_platform_admin()`;
  o dono continua restrito ao `tenant_id` do seu `membership`

## O que a página já faz

- Lê do banco: nome, WhatsApp, endereço, mapa, horário, serviços, preços e durações
- Seletor de porte do veículo (hatch, sedan, SUV, picape) — só aparece o porte
  que tem pelo menos um serviço/preço ativo; preço e tempo por categoria,
  escolha salva no `localStorage`
- Tabela de serviços que se atualiza conforme o veículo, com categoria opcional
- Chat: veículo → serviço → dia → horário → nome → WhatsApp → confirmação
- Horários livres calculados de verdade (`busy_slots` + horário de funcionamento)
- Grava o agendamento (`create_booking`), mostra o código, gera arquivo `.ics`
  para o calendário e link de WhatsApp com a confirmação completa (envio manual)
- Trata `slot_taken` (horário acabou de ser pego), `outside_hours` e `past_slot`
- Status "aberto agora" no fuso do lava-jato
- Slider antes/depois, FAQ, mapa, SEO local, barra fixa no celular
- Se o banco não responder, a página continua de pé e oferece o WhatsApp

## O que o painel já faz

- Login por e-mail e senha (Supabase Auth); cada usuário vê só o lava-jato do
  qual é membro, via RLS
- Agenda do dia: horário, cliente, WhatsApp, veículo, serviço, box, código e valor
- Ações por agendamento: confirmar, concluir, marcar falta, cancelar, reabrir e remarcar
- **Novo agendamento / encaixe**: nome, WhatsApp, serviço, veículo, dia, hora, box
  (automático ou escolhido) e observação; o preço e a duração saem da tabela
- **Bloquear horário**: intervalo + motivo (almoço, feriado...), visível na agenda
  e respeitado pela página do cliente
- **Minha marca**: edita o nome que aparece no topo do site e no painel, o
  endereço usado no contato/mapa, a frase de abertura do topo, envia e remove a
  logo e escolhe uma paleta de destaque. A última palavra da frase recebe a cor
  de destaque. O layout, os demais textos, as seções e o fundo do topo são
  padronizados — a página é do produto, a marca é do lava-jato.
- **Ajustes**: o dono cadastra, edita, arquiva e reativa serviços; define preço
  e duração por tipo de carro (hatch, sedan, SUV, picape), categoria opcional e
  ordem; adiciona, renomeia e remove boxes; edita o WhatsApp e os horários de
  funcionamento do lava-jato
- **Fechar caixa**: monta o relatório do dia (concluídos, confirmados, pendentes,
  faltas, previsto, serviços) e abre o WhatsApp do dono com o texto pronto
- Clientes: busca por nome/telefone, visitas concluídas, último atendimento,
  total gasto, histórico e edição/exclusão do contato
- Resumo por período (hoje/semana/mês): agendamentos, faturamento previsto e
  realizado, ticket médio, ocupação, serviços mais vendidos e próximos horários
- Agenda se atualiza sozinha a cada minuto e funciona no celular
- Se o usuário tiver vínculo com mais de um lava-jato, aparece o seletor

## O que o painel master já faz

- Login separado em `/master/`, só para quem está em `platform_admins`
- Lista todos os lava-jatos com nome, slug, dono, telefone, e-mail, site ativo
  e status da cobrança
- Busca por lava-jato, dono, e-mail ou telefone e filtro por status
- Cria lava-jato com configuração inicial, horário padrão e Box 1
- Edita dados do estabelecimento, do dono e da cobrança
- Marca fatura como paga/pendente em um clique
- Abre o painel completo de qualquer lava-jato em modo master (agenda,
  clientes, resumo, marca, serviços, preços, boxes e horários)
- Copia o SQL que liga o login do dono ao tenant
- Suspende/reativa a landing pública sem bloquear o acesso do dono
- O status **Atrasado** é calculado pelo vencimento; o bloqueio é sempre manual

## O que é padronizado no plano

Para manter o produto simples, repetível e com suporte viável, o plano padrão
não expõe edição de página:

- demais textos do hero, fundo do topo, ordem e visibilidade das seções;
- avaliações, FAQ e fotos do antes/depois;
- layout, fontes, componentes e animações;
- JSON-LD do `<head>` (para multi-tenant de verdade precisa ser renderizado no servidor).

O dono edita apenas **identidade e operação**: nome do site, logo, cor de
destaque, frase de abertura, endereço, WhatsApp, horários, serviços e preços.
Página sob medida é um projeto separado, não autoatendimento.

O nome, WhatsApp, endereço, horários, logo, frase de abertura e cor **não** são
fixos: vêm de `tenants`, `business_hours` e `tenant_site`.

## Próximos passos

1. ~~Receber fotos reais em `site/assets/`~~ ✅ (antes.jpg / depois.jpg)
2. Trocar o WhatsApp e os preços reais no banco (seed ou admin)
3. ~~Admin: agenda, clientes, resumo~~ ✅
4. ~~Admin: encaixe, boxes, bloquear horário, remarcar e fechar caixa~~ ✅
5. ~~Admin: serviços, preços e duração por tipo de carro~~ ✅
6. ~~Admin: endereço e horários de funcionamento~~ ✅
7. Forma de pagamento no fechamento (dinheiro/Pix/cartão) e caixa por dia
8. Fotos reais (antes/depois), avaliações e FAQ no cadastro do lava-jato
9. Domínio/subdomínio por lava-jato e SEO renderizado no servidor
10. WhatsApp: confirmação e lembretes automáticos
11. Tela de gerenciar agendamento (remarcar/cancelar pelo código)
12. Anti-spam no `create_booking`, aviso de LGPD e relatórios de faltas/retenção
