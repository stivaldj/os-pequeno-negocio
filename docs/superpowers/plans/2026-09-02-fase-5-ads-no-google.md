# Plano — Fase 5: Ads no Google — Página de Captura, Sobra por Real e Agente de Anúncios em nível 1

Issue: #23. Spec: `docs/spec/0003-relatorio-das-8h.md` ("O dinheiro", "O Agente de Anúncios"). ADRs: 0016 (Página de Captura e Código de Clique), 0017 (Venda Confirmada), 0018 (níveis de autonomia).

**Objetivo.** Cada conversa que nasce de um anúncio do Google fica atribuída à campanha pelo Código de Clique; a Verba entra por sincronização diária da API do Google Ads; Sobra por Real sai por campanha e período, com dia sem gasto marcado como incompleto; a consulta paga volta ao Google como conversão offline com o gclid; um Agente de Anúncios em nível 1 lê tudo isso todo dia e **propõe** ao Dono pelo WhatsApp, sem escrever no Google; a tela Anúncios mostra campanhas, Sobra por Real, links de captura e propostas.

**Arquitetura.** Módulo próprio `lib/ads/`, com crons no scheduler herdado (`ads-spend-sync`, `ads-conversion-upload`, `ads-agent`) e rotas em `app/api/v1/ads/*`. Nada em `inbound-turn.ts`; o extrator Meta fica intocado. O Google Ads entra por **REST v25** com `fetch` (sem SDK), credenciais **por instalação** em env — como o app da Meta —, porque a LAVRA opera um MCC só (done-for-you, ADR-0009): `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_OAUTH_CLIENT_ID`, `GOOGLE_ADS_OAUTH_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_API_VERSION` (default `v25`). Por Conta, a tabela `ad_accounts` guarda o `customer_id` da clínica, a conversion action e o Nível de Autonomia. O modelo de linguagem entra por `runModelCall` (o seam único do harness), com ponto de IA `ads_agent` registrado. O **destinatário "dono"** nasce nesta fase (a issue exige proposta pelo WhatsApp; a Fase 7 reusa): `organizations.settings.dono.whatsapp` + `lib/dono/` que garante contato e conversa e envia por `sendMessageHandler`.

**Decisões que o levantamento impôs.** (1) O extrator do Código de Clique roda no preparador de entrada, **antes** da redação clínica: uma primeira mensagem clínica com o código não pode perder a atribuição, e o código não é Conteúdo Clínico. (2) Policies de tabela nova são **por papel** (`fn_role_at_least(organization_id, 'manager')` na escrita, membro na leitura): o guarda `rbac-config-ia-canais` reprova policy `ALL` só de tenancy. (3) `ads-agent` roda como cron HTTP com `timeout 120` e passos limitados (`maxSteps: 6` em `RunModelCallInput`), com `cfg = llmEdgeConfigFromEnv(env)` e `pool = getRequestPool()` de `lib/agent-engine/db/request-pool.ts` (padrão de `app/api/v1/conversations/[id]/draft-reply/route.ts`) — a análise é bounded e é uma Conta por vez; se crescer, vira job no worker. (4) Página de Captura é `route.ts` público em `/ir/[slug]`, liberado em `lib/auth/public-paths.ts` com regex ancorada.

**Prova da fase** (da issue): `pnpm vitest run lib/ads` verde: fixture com gasto de 2 dias, 3 Contatos atribuídos por Código de Clique e 2 consultas pagas com margens diferentes calcula Sobra por Real por campanha e marca dia sem gasto como incompleto; código inválido não bloqueia; código reusado não sobrescreve; Agente em nível 1 nunca chama ferramenta de escrita. HITL: campanha real atribuída ponta a ponta com `ad_spend` populada por sync real (`scripts/prova-ads.ts`).

**Ambiente.** `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`. Baseline: apêndice antes da varredura anon; funções novas revogam `public` e `anon`. `test:unit` com `--maxWorkers=3`.

---

## Parte A — Schema e Google

### Tarefa 1 — Migration 0208: as cinco tabelas de ads e o WhatsApp do Dono

**Arquivos:** `supabase/baseline.sql`, `supabase/migrations/20260903000000_0208_ads_no_google.sql`, `MANIFEST.md`, novo `tests/invariants/ads-schema.test.ts`, `tests/invariants/rls-completude-varredura.test.ts` (entrada em `TABLES` ou `PROVA_PROPRIA` para cada tabela nova).

1. Invariante primeiro: as cinco tabelas existem com RLS; org B não lê nada da org A em cada uma; `viewer` da org A não escreve em `ad_capture_links` (policy por papel); `ad_clicks.code` é único por org; `ad_spend` único em `(organization_id, campaign_id, date)`; `ad_conversion_uploads.appointment_id` único. Rodar `pnpm test:db tests/invariants/ads-schema.test.ts` — vermelho.
2. SQL, todas com `organization_id uuid not null references organizations(id) on delete cascade`, `created_at`, RLS habilitada, policy de leitura `for select` para membro (`organization_id in (select fn_user_org_ids())`) e policy de escrita `for all` com `fn_role_at_least(organization_id, 'manager') or fn_is_platform_admin()` em `using` e `with check`; `revoke all from anon`:
   - `ad_accounts`: `provider text not null default 'google_ads' check (provider = 'google_ads')`, `customer_id text not null` (10 dígitos), `conversion_customer_id text null`, `conversion_action text null` (resource name), `currency char(3) not null default 'BRL'`, `autonomy_level smallint not null default 1 check (between 1 and 3)`, `budget_floor_cents bigint null`, `budget_ceiling_cents bigint null`, `max_cost_per_conversation_cents bigint null`, `status text not null default 'active' check in ('active','paused','error')`, `last_sync_at`, `last_error text`; unique `(organization_id, provider)`.
   - `ad_capture_links`: `slug text not null unique` (global: é o caminho público), `campaign_id text not null`, `campaign_name text`, `whatsapp_e164 text not null`, `mensagem text not null` (a frase pré-preenchida, sem o código), `active boolean default true`; unique `(organization_id, campaign_id)`.
   - `ad_clicks`: `code text not null`, `link_id uuid references ad_capture_links(id) on delete set null`, `campaign_id text not null`, `gclid text`, `gbraid text`, `wbraid text`, `user_agent text`, `consumed_at timestamptz`, `contact_id uuid references contacts(id) on delete set null`; unique `(organization_id, code)`; índice em `(organization_id, consumed_at)`.
   - `ad_spend`: `campaign_id text not null`, `campaign_name text`, `date date not null`, `cost_micros bigint not null default 0`, `clicks int`, `impressions int`, `conversions numeric`, `conversions_value numeric`, `synced_at timestamptz not null default now()`; unique `(organization_id, campaign_id, date)`.
   - `ad_proposals`: `campaign_id text`, `kind text not null check in ('orcamento','pausar','palavra_chave','anuncio','observacao')`, `level smallint not null`, `title text not null`, `body text not null`, `payload jsonb not null default '{}'`, `status text not null default 'pendente' check in ('pendente','aprovada','recusada','aplicada')`, `decided_by uuid`, `decided_at`, `llm_call_id uuid null`.
   - `ad_conversion_uploads`: `appointment_id uuid not null references calendar_appointments(id) on delete cascade unique`, `gclid text`, `gbraid text`, `wbraid text`, `conversion_value_cents bigint`, `uploaded_at`, `status text check in ('enviada','falhou','ignorada')`, `error text`.
   - Nenhuma função nova. `notify pgrst, 'reload schema'`.
3. `PROVA_PROPRIA` da varredura de completude (não `TABLES`: o usuário semeado lá é `agent`, e a escrita aqui exige `manager` — mesma razão de `webhook_lead_captures`): registrar as cinco citando `tests/invariants/ads-schema.test.ts`. FKs de verdade: `ad_proposals.decided_by references auth.users(id) on delete set null`, `ad_proposals.llm_call_id references llm_calls(id) on delete set null`. Rodar `pnpm test:db` completo — verde. Commit: `feat(db): the ads tables — accounts, capture links, clicks, spend, proposals, conversion uploads`.

### Tarefa 2 — Cliente REST do Google Ads

**Arquivos:** novos `lib/ads/google/config.ts`, `lib/ads/google/token.ts`, `lib/ads/google/cliente.ts`, `lib/ads/google/gasto.ts`, `lib/ads/google/conversoes.ts`, `lib/ads/google/campanhas.ts` e testes co-localizados; `.env.example`.

1. Testes com `vi.stubGlobal("fetch")` (padrão de `tests/unit/channel-adapter-meta.test.ts`): `googleAdsDisponivel(env)` só com as cinco variáveis; `accessToken()` troca o refresh token em `https://www.googleapis.com/oauth2/v3/token` e **cacheia** até `expires_in - 60s`; `lerGastoPorCampanhaEDia(customerId, de, ate)` faz `POST …/v25/customers/<cid>/googleAds:searchStream` com os três cabeçalhos (`Authorization`, `developer-token`, `login-customer-id` sem hífen) e GAQL `SELECT campaign.id, campaign.name, campaign.status, segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN … AND campaign.status != 'REMOVED'`, e converte a resposta (array de chunks, `int64` como string) em linhas `{ campaignId, campaignName, date, costMicros: number, clicks, impressions, conversions, conversionsValue }`; `subirConversoes(conversionCustomerId, linhas)` faz `POST …:uploadClickConversions` com `partialFailure: true`, `conversionDateTime` no formato `yyyy-mm-dd hh:mm:ss+|-hh:mm`, `currencyCode: 'BRL'`, `orderId` = id do agendamento, e devolve por índice `{ ok } | { ok: false, erro: 'EXPIRED_EVENT' | 'TOO_RECENT_EVENT' | 'ORDER_ID_ALREADY_IN_USE' | … }` lendo `partialFailureError.details[].errors[].location.fieldPathElements[0].index`; `lerCampanhas(customerId, dias)` traz o agregado com `campaign_budget.amount_micros` e `campaign.bidding_strategy_type`; erro HTTP nunca lança — devolve `{ ok: false, code, motivo }` com `DEVELOPER_TOKEN_NOT_APPROVED`, `USER_PERMISSION_DENIED` traduzidos para o operador. Rodar — vermelho.
2. Implementar. `AbortSignal.timeout(20_000)`. Sem `console.log`; `logger`. As seis variáveis entram em `lib/env.ts` como `z.string().optional().default("")` (padrão de `GOOGLE_CALENDAR_CLIENT_ID`), em `.env.example` (seção `# --- Google Ads (opcional; a instalação que opera o MCC) ---`, comentário em linha própria: `tests/unit/env-template-sem-comentario-inline`) e em `.env.hostgator.example` **só se** o validador do kit aceitar chave que o `install.sh` não grava — senão fica fora, como as da Meta, e o desvio é registrado. `tests/unit/env-example-sync` cobra `lib/env.ts ⊆ .env.example`. `googleAdsDisponivel(env)` lê de `env` (o objeto de `lib/env.ts`), não de `process.env`.
3. Verde. Commit: `feat(ads): a thin REST client for Google Ads — token, spend, conversions, campaigns`.

## Parte B — Captura e atribuição

### Tarefa 3 — Código de Clique: gerar, extrair, consumir

**Arquivos:** novos `lib/ads/codigo.ts`, `lib/ads/codigo.test.ts`, `lib/ads/atribuicao.ts`, `lib/ads/atribuicao.test.ts`; `lib/clinica/redacao.ts` (campo `codigoDeClique`), os cinco ingestores (`lib/channels/{meta,fake,zernio}/ingest.ts`, `lib/channels/meta/coexistencia/gravar.ts`, `lib/waha/ingest.ts`: passam `codigoDeClique: preparada.codigoDeClique`), `lib/channels/pos-entrada.ts` (campo + chamada), `tests/unit/ingestores-passam-pela-redacao.test.ts` (afirma também `codigoDeClique`).

1. `codigo.ts`: `gerarCodigoDeClique()` — 6 caracteres do alfabeto `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (sem 0/O/1/I), `crypto.randomInt`; `frasePreenchida(mensagem, codigo)` → `"<mensagem> (ref <codigo>)"`; `extrairCodigoDeClique(texto)` → regex tolerante `/\bref[\s:#-]*([A-Z2-9]{6})\b/i` sobre o texto normalizado (sem acento, maiúsculas), devolve o código ou `null`; nunca casa com 6 letras soltas sem `ref`. Testes: geração usa só o alfabeto, extração em variações ("(ref X7K3MQ)", "REF: x7k3mq", "ref-X7K3MQ"), texto sem `ref` devolve null, texto clínico com código extrai o código.
2. `atribuicao.ts`: `consumirCodigoDeClique(admin, { organizationId, contactId, codigo })`: busca `ad_clicks` por `(organization_id, code)`; inexistente → `{ status: 'desconhecido' }` (nunca bloqueia); já consumido → `{ status: 'reusado' }` **sem** sobrescrever (a RPC de atribuição é primeiro toque, e o clique também); válido → `estamparAtribuicaoDoContato(admin, contactId, { plataforma: 'google_ads', sourceId: campaign_id, titulo: campaign_name, corpo: null, sourceUrl: null, bruto: { click_code, gclid, gbraid, wbraid, link_id } })` + `update ad_clicks set consumed_at, contact_id`. Testes com dublê.
3. `lib/clinica/redacao.ts`: `EntradaPreparada.codigoDeClique: string | null`, extraído do **texto cru** antes de qualquer decisão de redação (o código não é Conteúdo Clínico). `pos-entrada.ts`: `EntradaDeMensagem.codigoDeClique?: string | null`; em `aplicarEfeitosPosEntrada`, logo após `abrirDemanda` e **antes** de qualquer `return` por redação, `if (entrada.codigoDeClique) await consumirCodigoDeClique(...)` (try/catch, nunca derruba). Os **quatro** ingestores que chamam `aplicarEfeitosPosEntrada` passam o campo (`meta`, `fake`, `zernio`, `waha`); `lib/channels/meta/coexistencia/gravar.ts` **fica intocado** — é eco do app e histórico, e consumir código em mensagem antiga gastaria cliques de outra época. Teste estático amplia a asserção para os quatro. `consumirCodigoDeClique` lê `contacts.source_metadata->>'ad_platform'` antes: contato já atribuído devolve `'ja_atribuido'` sem tocar em nada (a RPC é primeiro toque e casa zero linhas em silêncio). Atualizar o cabeçalho de `lib/leads/atribuicao-de-anuncio.ts`, que dizia que a landing page não existia.
4. `pnpm vitest run lib/ads lib/clinica lib/channels tests/unit/ingestores-passam-pela-redacao tests/unit/pos-entrada-efeitos-do-canal tests/unit/atribuicao-de-anuncio`. Commit: `feat(ads): click codes — generated on capture, read on the first message, consumed once`.

### Tarefa 4 — Página de Captura `/ir/<slug>`

**Arquivos:** novo `app/ir/[slug]/route.ts`, `lib/auth/public-paths.ts`, novos `lib/ads/captura.ts`, `lib/ads/captura.test.ts`, `tests/unit/ir-slug-rota.test.ts`.

1. Testes: `registrarClique(admin, { slug, gclid, gbraid, wbraid, userAgent })` → link ativo achado → insere `ad_clicks` com código novo e devolve `{ destino: 'https://wa.me/<e164 sem +>?text=<frase codificada>' }`; slug inexistente ou inativo → `{ destino: null }` (a rota responde 404 sem revelar por quê); a rota `GET /ir/<slug>?gclid=…` responde `302` com `Location` e `Cache-Control: no-store`; `isPublicPath('/ir/abc')` é `true` e `isPublicPath('/ir/abc/x')` é `false`. Rodar — vermelho.
2. Implementar. Rota com `createAdminClient()` (é pública: filtra por slug global e nada mais); sem cookies; `robots` noindex por header `X-Robots-Tag: noindex`. `PUBLIC_PATHS` ganha `/^\/ir\/[^/]+$/` com comentário. Sem HTML: é redirecionamento puro (o Contato só vê o WhatsApp abrir).
3. Verde. Commit: `feat(ads): the public capture page turns a Google click into a WhatsApp message with a click code`.

## Parte C — Verba, Sobra por Real e conversão offline

### Tarefa 5 — Sincronização de gasto e cálculo de Sobra por Real

**Arquivos:** novos `lib/ads/sync-gasto.ts`, `lib/ads/sync-gasto.test.ts`, `lib/ads/sobra.ts`, `lib/ads/sobra.test.ts`, `lib/ads/relatorio.ts`, `lib/ads/relatorio.test.ts`, `app/api/v1/cron/ads-spend-sync/route.ts`; `docker/scheduler/entrypoint.sh`, `lib/rotinas/esperadas.ts`.

1. `sobra.ts` (puro): `calcularSobraPorReal({ periodo: { de, ate }, gastos: { campaignId, date, costMicros }[], vendas: { campaignId, paidCents, marginBps }[] })` → por campanha `{ campaignId, gastoCents, receitaCents, sobraCents (= Σ paid × margin/10000), sobraPorReal (= sobraCents / gastoCents, null se gasto 0), diasSemGasto: string[], incompleto: boolean }`. Teste da prova: 2 dias de gasto, 3 contatos, 2 pagas com margens diferentes → números exatos; dia sem linha de gasto → `incompleto: true`; campanha com venda e sem gasto → `sobraPorReal: null`.
2. `relatorio.ts`: `insumosDeSobra(admin, orgId, periodo)` lê `ad_spend` e as vendas: `calendar_appointments` `completed` com `paid_cents not null` no período, join `contacts` com `source = 'google_ads'` e `source_metadata->>'ad_source_id'` como campanha, join `calendar_event_types.margin_bps` (nulo → venda entra em `semMargem` e fica fora da sobra, contada à parte). Teste com dublê.
3. `sync-gasto.ts`: `sincronizarGasto(admin, { agora, diasParaTras = 3 })`: para cada `ad_accounts` ativa, `lerGastoPorCampanhaEDia`, upsert em `ad_spend` por `(org, campaign_id, date)`, `last_sync_at`; erro da API → `status = 'error'`, `last_error`, audit `ads.sync_falhou`; sucesso → audit `ads.spend_synced` com contagem. Rota `ads-spend-sync` (auth de cron + `comExecucaoDeRotina`), `10 3 * * *|120|api/v1/cron/ads-spend-sync`, `ROTINAS_ESPERADAS` (1440). Ações no `lib/audit/actions.ts`.
4. `pnpm vitest run lib/ads lib/rotinas tests/unit/cron-routes-scheduled tests/unit/cron-routes-registram-execucao tests/unit/cron-audita-so-quando-ha-efeito`. Commit: `feat(ads): daily spend sync and net return per real, with incomplete days marked`.

### Tarefa 6 — Conversão offline

**Arquivos:** novos `lib/ads/conversoes.ts`, `lib/ads/conversoes.test.ts`, `app/api/v1/cron/ads-conversion-upload/route.ts`; `entrypoint.sh`, `esperadas.ts`, `actions.ts`.

1. Testes: `subirConversoesDevidas(admin, { agora })` seleciona agendamentos `completed` com `paid_cents` cujo contato tem `source_metadata->'ad_raw'->>'gclid'` (ou `gbraid`/`wbraid`) e sem linha em `ad_conversion_uploads`; monta `conversionDateTime` com o fuso do agendamento; chama `subirConversoes` com `orderId` = id; grava `ad_conversion_uploads` por resultado (`enviada`, `falhou` com erro, `ORDER_ID_ALREADY_IN_USE` = `enviada`); `TOO_RECENT_EVENT` não grava (tenta de novo amanhã); Conta sem `conversion_action` → `ignorada` com motivo. Audit `ads.conversion_uploaded` só quando enviou.
2. Rota + `40 3 * * *|120|api/v1/cron/ads-conversion-upload` + esperadas (1440).
3. Commit: `feat(ads): paid visits go back to Google as offline conversions`.

## Parte D — Dono, Agente e tela

### Tarefa 7 — O destinatário "dono"

**Arquivos:** novos `lib/dono/destinatario.ts`, `lib/dono/destinatario.test.ts`; `lib/schemas/settings.ts`, `app/actions/settings/updateTenant.ts`, `app/app/settings/tenant/{_form,page}.tsx`, `lib/i18n/dicionario.ts`, `lib/rotinas/vigia.ts` (o comentário "precisa do destinatário dono" deixa de valer: o vigia passa a avisar o Dono também), `lib/clinica/vigia.ts` (idem).

1. Testes: `whatsappDoDono(settings)` lê `settings.dono.whatsapp` (E.164, validado); `garantirConversaDoDono(admin, orgId)` acha ou cria o contato (`display_name: 'Dono'`, `source: 'dono'`, telefone) e a conversa na sessão de canal ativa da org (a mais recente `WORKING`; sem sessão → `{ ok: false, motivo: 'sem_canal' }`); `enviarAoDono(admin, orgId, texto)` chama `sendMessageHandler` com ator `ai_agent` e `role: 'manager'` (como `aviso-ao-lead.ts`; não existe ator `sistema`) e nunca lança. Seleção da sessão de canal copiada de `lib/agenda/lembretes.ts`. Limitação registrada em comentário: o vigia de rotinas avisa o Dono pelo mesmo canal que pode estar caído. Toggle no formulário da Conta: campo "WhatsApp do Dono" (Zod E.164), merge não destrutivo em `settings.dono`.
2. Vigias passam a chamar `enviarAoDono` além do inbox e do audit, com texto curto e sem dado sensível.
3. Commit: `feat(dono): the owner is a recipient — a contact and a conversation the product can write to`.

### Tarefa 8 — Agente de Anúncios em nível 1

**Arquivos:** novos `lib/ads/agente/contexto.ts`, `lib/ads/agente/ferramentas.ts`, `lib/ads/agente/niveis.ts`, `lib/ads/agente/rodar.ts` e testes; `app/api/v1/cron/ads-agent/route.ts`; `lib/ai/pontos/registro.ts` (ponto `ads_agent`); `entrypoint.sh`, `esperadas.ts`, `actions.ts`.

1. `niveis.ts`: `podeEscrever(conta: { autonomy_level }, acao: 'orcamento' | 'pausar' | 'anuncio' | 'palavra_chave')` — nível 1 nunca; nível 2 só `orcamento` e `pausar`; nível 3 tudo. Teste exaustivo dos 3×4. (A Fase 8 liga a escrita de verdade; aqui as ferramentas de escrita existem e **recusam** com `{ recusado: true, motivo: 'nivel_insuficiente' }`, auditando `ads.escrita_recusada` com `autonomy_level` no metadata — ADR-0018 pede o nível em vigor no audit.)
2. `contexto.ts`: `montarContexto(admin, orgId, { agora })` → últimos 7 e 30 dias: por campanha gasto, cliques, conversas atribuídas (contatos com `ad_source_id`), agendamentos, consultas pagas, Sobra por Real (reusa `relatorio.ts`), dias incompletos, propostas pendentes. Serializado em texto compacto para o modelo, **sem** nome de paciente nem telefone.
3. `ferramentas.ts`: tools no formato de `runModelCall` (`tool` reexportado de `lib/agent-engine/edge/llm/run-model-call.ts`): leitura `ler_campanhas`, `ler_sobra_por_real`; ação `propor({ campaign_id?, kind, title, body, payload })` que insere `ad_proposals` com `level` da Conta; escrita `ajustar_orcamento`, `pausar_campanha` que passam por `podeEscrever`. Teste: com modelo falso (mock de `runModelCall` devolvendo tool calls), nível 1 grava propostas e **nunca** chega às escritas — e se o modelo tentar, a ferramenta recusa e audita.
4. `rodar.ts`: `rodarAgenteDeAnuncios(admin, pool, orgId, { agora })`: monta contexto → `runModelCall(pool, cfg, { tenantId, purpose: 'ads_agent', system: PROMPT, messages, tools, stepCountIs(6) })` → coleta propostas criadas → texto de resumo (até 5 propostas, 1 linha cada + Sobra por Real do período) → `enviarAoDono` + `agent_inbox_items` (`kind: 'other'`) + audit `ads.proposta_criada` por proposta. Orçamento de IA estourado (`LlmBudgetExceededError`) → pula com audit `ads.agent_pulado`. Prompt: papel, o que pode (propor), o que não pode (escrever no Google no nível 1; sugerir público de pacientes — nunca; prometer resultado), formato das propostas, e "diga quando não há o que propor".
5. `lib/ai/pontos/registro.ts`: entrada `ads_agent` com todos os campos (`id, rotulo, oQueFaz, papel, exige, emissor, sintomaDeFalha, registraEm`), `papel: 'entender'` (um dos seis existentes); em `rodar.ts` o literal é `purpose: 'ads_agent'` com **aspas simples** — `tests/unit/pontos-de-ia-completude` acha o ponto por regex e reprova ponto fantasma.
6. Rota `ads-agent`, `0 7 * * *|120|api/v1/cron/ads-agent` (antes do relatório das 8h), esperadas (1440). Pool por `createPool` de `lib/agent-engine/db/pool.ts`, fechado no `finally`.
7. Commit: `feat(ads): the ads agent reads spend and paid visits and proposes to the owner — level 1 never writes`.

### Tarefa 9 — Tela Anúncios e API

**Arquivos:** novos `app/api/v1/ads/{conta,links,campanhas,propostas}/route.ts`, `app/app/anuncios/{page,_client,loading}.tsx`, `hooks/ads/useAnuncios.ts`, `tests/unit/anuncios-tela.test.tsx`, `tests/unit/ads-api.test.ts`; `lib/navigation/registry.ts`, `lib/i18n/dicionario.ts`.

1. API (todas `requireRole`, Zod, `ok()/fail()`, snake_case, audit nas mutações): `GET/PATCH conta` (`customer_id`, `conversion_customer_id`, `conversion_action`; `autonomy_level` **só leitura** nesta fase), `GET/POST links` (POST: `campaign_id`, `campaign_name`, `whatsapp_e164`, `mensagem`; slug gerado de `campaign_name` + 4 chars; devolve a URL pública), `GET campanhas?dias=30` (linhas de `relatorio.ts` + conversas e agendamentos), `GET/PATCH propostas` (PATCH: `status` `aprovada`/`recusada`; `aplicada` só na Fase 8).
2. Tela `/app/anuncios` (grupo `analise`, sem `sidebar: true`, `minRole: 'manager'`): cartão da Conta (customer id, conversion action, nível de autonomia, último sync e erro), tabela de campanhas (gasto, cliques, conversas, agendamentos, pagas, Sobra por Real, dias incompletos em amarelo), links de captura (URL copiável), propostas pendentes com aprovar/recusar.
3. Testes de tela isolados por componente; `i18n` em espanhol; `navegacao-completude` verde.
4. Commit: `feat(ads): the ads screen — account, campaigns with net return per real, capture links, proposals`.

### Tarefa 10 — Gates, prova e HITL

1. Gates completos em arquivos; rodapés.
2. `pnpm vitest run lib/ads` (prova da issue) — colar em #23. `scripts/prova-ads.ts` (fino): com env do Google e `AD_ACCOUNT_CUSTOMER_ID`, roda `sincronizarGasto` e imprime as linhas de `ad_spend` do dia — é o HITL da issue.
3. PR para `main` sem `Closes #23` (fecha no HITL).
4. HITL (José): MCC, developer token (Explorer), OAuth client Desktop com consent screen **publicado**, refresh token pelo script `scripts/ads/obter-refresh-token.ts` (loopback + PKCE — criar nesta tarefa, fino), conta da clínica vinculada ao MCC, auto-tagging ligado, conversion action `UPLOAD_CLICKS` (janela 90 dias, BRL) e esperar 4–6 h; preencher a Conta na tela Anúncios; criar o link de captura da campanha e trocar a URL final do anúncio pela URL pública; WhatsApp do Dono nas configurações; rodar `scripts/prova-ads.ts`.

## O que este plano não faz

Não liga níveis 2 e 3 (Fase 8). Não toca Meta Ads. Não faz landing page com HTML: `/ir/<slug>` é redirecionamento. Não envia lista de pacientes ao Google em nenhuma forma. Não guarda credencial do Google por Conta: uma instalação, um MCC.

---

## Desvios registrados na execução (02/09/2026)

- **`.env.hostgator.example` sem as `GOOGLE_ADS_*`**: o validador do kit reprova chave que o `install.sh` não grava (mesmo caso das da Meta). Pendência do DoD registrada até o kit aprender a gravá-las.
- **`EntradaPreparada.codigoDeClique` é opcional no tipo** (sempre preenchido pelo preparador): `gravar.ts` monta o literal à mão e tinha de ficar intocado.
- **`lib/ads/captura.ts` nasceu duas vezes** (registro do clique aqui, helpers de slug/URL na Tarefa 9); ficou um arquivo só com os dois papéis.
- **Vigia de rotinas avisa cada Dono** (`enviarAosDonos`): ele fala no nível da instalação, sem org. O contato do Dono é criado por insert direto, não pela RPC de WhatsApp (ela exige `chat_id`).
- **Audit de conversão por Conta**, não por rodada: a rodada percorre várias organizações e um audit único não teria `organization_id`.
- **Conversões: janela de 90 dias em `starts_at`** na seleção (fora dela o Google devolve `EXPIRED_EVENT`); a rota pula sem tocar no banco quando o Google não está configurado.
- **Escritas do Agente existem e recusam** (`escrita_chega_na_fase_8`); a Fase 8 liga.
- **`ads.sync_falhou` foi declarada por duas tarefas**; ficou uma.
- **Prova de realidade por vitest** (`tests/prova/ads.prova.ts`), como a da Fase 4; `scripts/prova-ads.ts` é casca.
