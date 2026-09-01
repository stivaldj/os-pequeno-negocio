# Plano — Fase 2: adapter fake, rotinas com `job_runs` e Coexistência pela Meta

Issue: #20. Spec: `docs/spec/0003-relatorio-das-8h.md`. ADRs: 0007 (emendada), 0014, 0015.

**Objetivo.** Ao fim desta fase: (a) toda prova local roda por um adapter de canal em memória; (b) toda rotina do scheduler grava `job_runs` e um vigia alerta quando uma não rodou; (c) o Número entra por Embedded Signup em Coexistência, com a resposta pela recepção chegando como eco na Conversa e silenciando o Agente por um intervalo.

**Arquitetura.** Três entregas independentes entre si até a Tarefa 13. O adapter fake é um `ChannelAdapter` a mais, registrado só fora de produção; a Coexistência é extensão do adapter `meta_cloud` e dos seus webhooks, em `lib/channels/meta/coexistencia/`; `lib/rotinas/` é pasta nova que os crons chamam. Nada toca `lib/agent-engine/agent/inbound-turn.ts`. Nenhum nome de provider sai de `lib/channels/`.

**Regras do repo que este plano obedece.** Schema só por apêndice no fim de `supabase/baseline.sql` + arquivo em `supabase/migrations/` + linha em `supabase/migrations/MANIFEST.md`. RLS em tabela tenant-aware. Função nova revoga `execute` de `public` e `anon`. Zod em input externo. Audit em mutação. Env nova em `.env.example`, `.env.hostgator.example` e `lib/env.ts` com default que não quebra. Commits em inglês, conventional. `tests/unit/cron-routes-scheduled.test.ts` reprova rota de cron sem linha em `CRONS`.

**Prova da fase** (da issue): `pnpm vitest run lib/channels/adapters/fake lib/rotinas lib/channels/meta/coexistencia` verde; `pnpm lint:channels` verde; `pnpm test:db` verde; HITL com número de teste em Coexistência.

**Ambiente.** Antes de qualquer `pnpm`: `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`. `pnpm test:unit` completo com `--maxWorkers=3`. Branch a partir de `main` depois do merge do PR #27 e da branch `docs/spec-0003-relatorio-das-8h`.

---

## Parte A — Adapter fake

O provider chama-se `fake_channel`. Não é `fake`: a catraca de lint (`scripts/lint-channels.pattern.ts`) reconhece provider por grafia separada e PascalCase, e `fake` sozinho casaria com todo helper de teste do repo.

### Tarefa 1 — O provider existe para tipos, capacidades, registry, lint e banco

**Arquivos:** `lib/channels/types.ts`, `lib/channels/capabilities.ts`, `lib/channels/index.ts`, `scripts/lint-channels.pattern.ts`, `tests/unit/channel-capability-matrix.test.ts`, `tests/unit/lint-channels-fronteira.test.ts`, `supabase/baseline.sql`, `supabase/migrations/20260902000000_0204_canal_fake_para_provas.sql`, `supabase/migrations/MANIFEST.md`, novo `lib/channels/adapters/fake.test.ts`.

1. Escrever `lib/channels/adapters/fake.test.ts` com três casos: `getAdapter("fake_channel")` devolve adapter com `provider === "fake_channel"` quando `NODE_ENV=test`; `capabilitiesOf("fake_channel")` devolve `{ freeformOutsideWindow: true, requiresTemplates: false, canManageTemplates: false, banRisk: false, minIntervalMs: null, voiceNote: "any", groups: "full", costPerMessage: false }`; com `vi.stubEnv("NODE_ENV","production")` + `vi.resetModules()` + `await import("@/lib/channels")`, `getAdapter("fake_channel")` lança `unknown_channel_provider: fake_channel`. Rodar: `pnpm vitest run lib/channels/adapters/fake` — vermelho (módulo não existe).
2. `types.ts`: `ChannelProvider = "waha" | "meta_cloud" | "zernio" | "fake_channel"`. `capabilities.ts`: entrada `fake_channel` como acima e `export const CHANNEL_PROVIDER_FAKE: ChannelProvider = "fake_channel"`. Conferir o tipo de `voiceNote` e `groups` no arquivo e usar os valores que existem.
3. `index.ts`: `ADAPTERS.fake_channel = process.env.NODE_ENV === "production" ? null : fakeChannelAdapter` (o adapter vem da Tarefa 2; nesta tarefa, um stub mínimo que satisfaça a interface).
4. `lint-channels.pattern.ts`: `SEPARADO` ganha `fake_channel`; `PASCAL` ganha `FakeChannel`. Rodar `pnpm vitest run tests/unit/lint-channels-fronteira` e ajustar o teste se ele enumera os nomes.
5. `tests/unit/channel-capability-matrix.test.ts`: incluir `fake_channel` onde o teste itera providers. Rodar.
6. Banco. **Regra do repo:** `channel_sessions_provider_check` e `channel_sessions_provider_ref_check` são definidas **uma vez só**, no bloco existente do baseline (linhas ~9377-9391), com o vocabulário final; `tests/unit/baseline-constraint-reconstruida.test.ts` reprova um segundo `drop`/`add` da mesma constraint em apêndice. Então: editar **in place** as duas definições existentes, acrescentando `'fake_channel'` à lista do `provider_check` e a linha `(provider = 'fake_channel' and waha_session_name is not null)` ao `provider_ref_check` (o fake usa `waha_session_name` como `sessionRef`, para não criar coluna; espelhar em `lib/channels/session-ref.ts`: acrescentar `{ provider: "fake_channel"; waha_session_name: string }` à união `ChannelSessionRef` e o `case` no `switch`, senão o typecheck acusa `switch` não exaustivo). Acrescentar ao fim do arquivo um apêndice `-- ---- canal fake para provas locais (migration 0204) ----` só com comentário apontando para o bloco editado (sem DDL da constraint), para o histórico do baseline continuar legível. O arquivo de migration 0204 carrega o `drop`/`add` completo com o vocabulário final, como a 0132 fez; linha no MANIFEST. Rodar `pnpm vitest run tests/unit/baseline-constraint-reconstruida` — verde.
7. Rodar `pnpm vitest run lib/channels/adapters/fake tests/unit/channel-capability-matrix tests/unit/lint-channels-fronteira` — verde. `pnpm lint:channels` — verde. `pnpm typecheck`.
8. Commit: `feat(channels): register the fake_channel provider for local proofs`.

### Tarefa 2 — O adapter envia para uma caixa em memória

**Arquivos:** novo `lib/channels/fake/caixa.ts`, `lib/channels/adapters/fake.ts`, `lib/channels/adapters/fake.test.ts`.

1. Acrescentar ao teste: `send` de dois envelopes da mesma org devolve `externalId` diferentes e determinísticos entre execuções (`fake:<org>:<n>`), `lerEnviados(orgId)` devolve só os da org, `limparCaixaFake()` zera, `echoExternalIds({externalId, recipient})` devolve `[externalId]`, `resolveRecipient` devolve `phoneNumber` normalizado ou `groupChatId`, `checkHealth` devolve `{ reachable: true }`, `sendTemplate` grava entrada com `kind: "template"`. Rodar — vermelho.
2. `caixa.ts`: `Map<orgId, Envelope[]>` + contador por org; exporta `registrarEnvio`, `lerEnviados`, `limparCaixaFake`. Só memória, sem I/O.
3. `adapters/fake.ts`: implementa `ChannelAdapter` usando a caixa. `codes = { notConfigured: "fake_not_configured", sendFailed: "fake_send_failed", unknownError: "fake_unknown" }`. Copiar a forma de `meta-cloud.ts`, sem HTTP.
4. Rodar — verde. Commit: `feat(channels): fake adapter with an in-memory outbox`.

### Tarefa 3 — Mensagem entra pelo webhook genérico e vira Conversa

**Arquivos:** `lib/channels/inbound.ts`, novos `lib/channels/fake/ingest.ts`, `lib/channels/fake/ingest.test.ts`, `lib/channels/fake/envelope.ts`.

1. Ler `lib/channels/zernio/ingest.ts` e `tests/unit/channel-ingest-zernio.test.ts` para copiar o admin falso e a sequência de RPCs. Escrever `lib/channels/fake/ingest.test.ts`: corpo `{ from: "5565999990001", text: "oi", external_id: "fake-in-1" }` → `fn_upsert_wa_contact`, `fn_upsert_wa_conversation`, insert em `messages` com `channel_session_id` e `direction: "inbound"`, `fn_mark_conversation_message`, e `aplicarEfeitosPosEntrada` chamado; 23505 no insert → `{ status: "duplicate" }`; corpo inválido → `{ ok: false, code: "contrato_violado" }` pelo `handleInboundWebhook`; sessão de outra org não é encontrada. Rodar — vermelho.
2. `envelope.ts`: Zod `{ from: string.min(8), text: string.min(1), external_id: string.min(1), sent_at: string.datetime().optional() }`.
3. `ingest.ts`: `ingestFakeInbound(admin, evento, dono)` espelhando `ingestMetaInbound` (mesma cadeia, `sessionByRef` filtrando `organization_id` e `archived_at`, sessão resolvida por `waha_session_name = sessionRef`).
4. `inbound.ts`: `acceptsInboundWebhook` devolve `true` também para `CHANNEL_PROVIDER_FAKE`; `case CHANNEL_PROVIDER_FAKE:` parseia com o Zod e chama o ingest. Sem assinatura: o segredo é o `webhook_path_token` da rota, que já é verificado antes.
5. Rodar — verde. `pnpm lint:channels`. Commit: `feat(channels): fake inbound through the generic webhook route`.

### Tarefa 4 — O banco aceita a sessão fake e o isolamento continua

**Arquivos:** novo `tests/invariants/canal-fake-provider.test.ts`, novo `lib/channels/fake/sessao.ts`.

1. `sessao.ts`: `garantirSessaoFake(admin, orgId)` faz upsert de uma `channel_sessions` com `provider: "fake_channel"`, `waha_session_name: "fake-<orgId8>"`, `webhook_path_token` aleatório, `status: "active"`; devolve `{ sessionId, webhookPathToken }`. Usada por provas e scripts das fases seguintes.
2. Teste de invariante (padrão de `rls-isolation.test.ts`): insere sessão `fake_channel` na ORG_A via `sql()`; afirma que o CHECK aceita; afirma que o usuário da ORG_B conta zero sessões da ORG_A; afirma que a `provider_ref_check` recusa `fake_channel` sem `waha_session_name`.
3. Rodar `pnpm test:db` (Docker) — redirecionar para arquivo e ler o rodapé. Verde.
4. Commit: `test(db): the fake provider is accepted and isolated`.

---

## Parte B — Rotinas com histórico e vigia

### Tarefa 5 — Tabela `job_runs`

**Arquivos:** `supabase/baseline.sql`, `supabase/migrations/20260902000100_0205_job_runs.sql`, `MANIFEST.md`, novo `tests/invariants/job-runs-rls.test.ts`.

1. Teste de invariante primeiro: service role insere `{ job_name: 'x', status: 'ok' }`; `anon` não lê (`set role anon` → zero linhas ou erro de permissão); usuário autenticado comum não lê; `fn_is_platform_admin()` lê. Rodar `pnpm test:db` — vermelho (tabela não existe).
2. Apêndice `-- ---- toda rotina deixa rastro (migration 0205) ----`: `create table if not exists public.job_runs (id uuid primary key default gen_random_uuid(), organization_id uuid null references organizations(id) on delete cascade, job_name text not null, status text not null check (status in ('running','ok','failed','missing')), started_at timestamptz not null default now(), finished_at timestamptz null, duration_ms integer null, stats jsonb not null default '{}'::jsonb, error text null)`; índice `(job_name, started_at desc)`; `alter table ... enable row level security`; policy `job_runs_platform_admin_all` usando `fn_is_platform_admin()`; `revoke all on public.job_runs from anon`. `organization_id` nulo = plataforma, como em `agent_inbox_items`. Comentário explicando por que não é tenant-aware.
3. Rodar `pnpm test:db` — verde. Commit: `feat(db): job_runs — every scheduled job leaves a trace`. No corpo do commit, registrar por que o teste é um invariante próprio e não uma entrada em `rls-isolation.test.ts`: tabela de plataforma, sem tenant, não cabe no teste de duas orgs; a issue #20 pede "no teste de isolamento" e isto é o que cumpre a intenção.

### Tarefa 6 — Helper que embrulha um handler de cron

**Arquivos:** novos `lib/rotinas/registrar.ts`, `lib/rotinas/registrar.test.ts`.

1. Teste: `comExecucaoDeRotina("x", handler)` devolve função que, ao rodar, insere `{ job_name: "x", status: "running" }`, chama o handler, e atualiza para `ok` com `finished_at`, `duration_ms` e `stats` (o JSON da resposta `ok()` quando houver — ler de `res.clone().json()`, nunca do `res` original, senão o corpo chega consumido ao Next; o teste afirma que a `Response` devolvida ainda tem corpo legível); handler que lança → `failed` com `error` e o erro é relançado; falha ao escrever em `job_runs` não impede o handler (é logada). Admin falso como nos testes de ingest.
2. Implementar. O admin vem de `lib/supabase/admin.ts` (usar o export que as rotas de cron já usam). Nunca `console.log`; usar o `logger` do repo.
3. Rodar — verde. Commit: `feat(rotinas): wrap cron handlers so every run is recorded`.

### Tarefa 7 — Lista de rotinas esperadas e o vigia

**Arquivos:** novos `lib/rotinas/esperadas.ts`, `lib/rotinas/esperadas.test.ts`, `lib/rotinas/vigia.ts`, `lib/rotinas/vigia.test.ts`, `app/api/v1/cron/rotinas-vigia/route.ts`, `docker/scheduler/entrypoint.sh`, `lib/audit/actions.ts`.

1. `esperadas.test.ts`: lê `docker/scheduler/entrypoint.sh`, extrai cada linha `expr|timeout|api/v1/cron/<nome>` (cortando o nome em `?`: `storage-redaction?limit=50` é `storage-redaction`) e afirma que `ROTINAS_ESPERADAS` tem exatamente esses nomes com `periodoMinutos` igual ao derivado da expressão (`* * * * *` = 1, `*/5` = 5, `17 * * * *` = 60, `0 12 * * *` = 1440). Rodar — vermelho.
2. `esperadas.ts`: constante `ROTINAS_ESPERADAS: { nome, periodoMinutos }[]` com as 20 rotinas atuais mais `rotinas-vigia` (60).
3. `vigia.test.ts`: dado admin falso com a última linha `ok` de `channel-health` há 3× o período, `vigiar(admin, agora)` insere `{ job_name: "channel-health", status: "missing" }`, insere `agent_inbox_items` com `organization_id: null`, `kind: "job_dead"` (o CHECK de `kind` é fechado: `qr_rescan, job_dead, event_dead, budget_exceeded, handoff, promotion_review, judge_unaligned, other`; inventar um valor passa no admin falso e reprova no banco real) e título nomeando a rotina, chama `audit` com `rotinas.nao_rodou`; rotina cuja última linha já é `missing` dentro do mesmo intervalo não gera segunda linha; rotina em dia não gera nada. Tolerância: `2 × período + 5 min`. Rodar — vermelho.
4. Implementar `vigia.ts`. Registrar `rotinas.nao_rodou` em `lib/audit/actions.ts` (ver como as ações são declaradas lá).
5. Rota `rotinas-vigia/route.ts` copiando a auth de `storage-redaction/route.ts`, embrulhada em `comExecucaoDeRotina`. Linha em `CRONS`: `7 * * * *|60|api/v1/cron/rotinas-vigia`.
6. Rodar `pnpm vitest run lib/rotinas tests/unit/cron-routes-scheduled` — verde. `pnpm test:shell` (o teste do entrypoint). Commit: `feat(rotinas): a watcher that turns a missing run into a loud one`.

### Tarefa 8 — As vinte rotinas herdadas passam a registrar execução

**Arquivos:** os 20 `app/api/v1/cron/*/route.ts`, novo `tests/unit/cron-routes-registram-execucao.test.ts`.

1. Teste: para cada diretório em `app/api/v1/cron/`, o `route.ts` contém `comExecucaoDeRotina(`. Rodar — vermelho para 20.
2. Em cada rota, renomear `export async function GET(...)` para `async function handle(...)` e exportar `export const GET = comExecucaoDeRotina("<nome>", handle)` (e `export const POST = GET` onde hoje há `POST`; 11 rotas têm). Duas edições por export; nada mais muda. É a única edição em código herdado desta fase e está aqui para o rebase contra upstream saber.
3. Rodar o teste novo e `pnpm test:unit --maxWorkers=3 > /tmp/claude-501/unit.txt; tail -20 /tmp/claude-501/unit.txt` — verde. Commit: `feat(rotinas): inherited cron routes record their runs`.

---

## Parte C — Coexistência

Tudo em `lib/channels/meta/coexistencia/` para a prova da issue. Fonte: página "Onboard WhatsApp Business app users" do Embedded Signup e a referência dos webhooks `smb_message_echoes`, `smb_app_state_sync` e `history` (URLs no relatório de pesquisa de 01/09/2026 citado na Spec 0003). O Embedded Signup é **opcional por instalação**: só aparece quando a instalação declara app da Meta; o BYO manual continua sendo o padrão, como a doutrina exige para self-host.

### Tarefa 9 — Env e troca de código por token

**Arquivos:** `lib/env.ts`, `.env.example`, `.env.hostgator.example`, novos `lib/channels/meta/coexistencia/embedded-signup.ts`, `lib/channels/meta/coexistencia/embedded-signup.test.ts`.

1. Teste com `vi.stubGlobal("fetch", ...)` no estilo de `tests/unit/channel-adapter-meta.test.ts`: `embeddedSignupDisponivel({ META_APP_ID: "", ... })` é `false` e com os três valores é `true`; `trocarCodigoPorToken("abc")` chama `GET https://graph.facebook.com/<versão>/oauth/access_token?client_id&client_secret&code` e devolve `access_token`; erro HTTP vira `{ ok: false, code: "meta_oauth_failed" }`; `assinarWebhookNaWaba(token, wabaId)` faz `POST /<wabaId>/subscribed_apps`. Rodar — vermelho.
2. `lib/env.ts`: `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID` como `z.string().optional().default("")`. Seção nova em `.env.example` e `.env.hostgator.example`: `# --- Embedded Signup em Coexistência (opcional; só para instalação que é Tech Provider) ---`.
3. Implementar usando a mesma versão da Graph API que `validate-credentials.ts` usa.
4. Rodar — verde. Commit: `feat(channels): embedded signup code exchange for coexistence`.

### Tarefa 10 — Rota que conecta pelo Embedded Signup

**Arquivos:** `app/api/v1/channels/official/route.ts`, novo `app/api/v1/channels/official/embedded-signup/route.ts`, novo `lib/channels/meta/conectar.ts`, `supabase/baseline.sql`, `supabase/migrations/20260902000200_0206_coexistencia_na_sessao.sql`, `MANIFEST.md`, `lib/audit/actions.ts`, `tests/unit/canal-oficial-embedded-signup.test.ts`.

1. Migration 0206: `alter table channel_sessions add column if not exists meta_coexistence boolean not null default false` (apêndice + arquivo + MANIFEST). Sem RLS nova (coluna em tabela já isolada).
2. Teste da rota (padrão de `tests/unit/canal-oficial-pode-receber.test.ts` ou similar que mocka `requireRole`): `POST` com `{ code, waba_id, phone_number_id }` → troca código, valida credencial (`validateMetaCredentials`), assina webhook, grava sessão com `meta_coexistence: true` e token cifrado, emite audit `channels.official.embedded_signup`; sem env do app → 404 `embedded_signup_unavailable`; Zod recusa `code` vazio. `GET /api/v1/channels/official` passa a devolver `embedded_signup: { available, app_id, config_id }` (nunca o secret). Rodar — vermelho.
3. Extrair do `POST` atual de `official/route.ts` a gravação da sessão para `lib/channels/meta/conectar.ts` (`conectarCanalOficial(admin, orgId, creds, { coexistence })`), e fazer as duas rotas chamarem a mesma função. Manter comportamento do `POST` manual idêntico: os testes existentes dele são a rede.
4. Rodar testes novos e os existentes de `canal-oficial*` — verde. Commit: `feat(channels): connect the official channel through embedded signup`.

### Tarefa 11 — Botão na tela de Conexões

**Arquivos:** `hooks/channels/useOfficialChannel.ts`, novo `components/connections/EmbeddedSignupButton.tsx`, `components/connections/CanalOficialClient.tsx`, `next.config.ts` (CSP), novo `tests/unit/canal-oficial-embedded-signup-tela.test.tsx`.

1. Conferir em `next.config.ts` / `proxy.ts` se há CSP (em 01/09/2026 não havia `Content-Security-Policy` nos dois arquivos; se o middleware herdado a adicionar, `script-src` precisa de `https://connect.facebook.net` e `frame-src` de `https://www.facebook.com`. Sem isso o SDK não carrega e a falha é silenciosa.
2. Teste de tela (padrão de `canal-parceiro-tela.test.tsx`): com `embedded_signup.available = false` o botão não aparece e o formulário manual sim; com `true`, aparece "Conectar pelo WhatsApp Business" e o formulário manual continua acessível abaixo. Rodar — vermelho.
3. `EmbeddedSignupButton.tsx`: carrega o SDK (`https://connect.facebook.net/en_US/sdk.js`) uma vez; `FB.init({ appId, version })`; ao clicar, `FB.login(cb, { config_id, response_type: "code", override_default_response_type: true, extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" } })`; ouvinte de `message` com origem `facebook.com` captura o evento `WA_EMBEDDED_SIGNUP` (`data.type`) para `waba_id` e `phone_number_id`; com `code` + os dois ids chama `useConnectOfficialChannelByEmbeddedSignup` (mutation nova no hook). Erros e cancelamento viram toast com `showApiError`.
4. Rodar — verde. `pnpm lint:channels` (hoje `SEPARADO` só casa `graph.facebook.com`, então `connect.facebook.net` no componente passa; se a catraca crescer e reprovar, mover a URL para uma constante exportada de `lib/channels/meta/coexistencia/sdk.ts` e importar). Commit: `feat(connections): embedded signup button next to the manual form`.

### Tarefa 12 — Os três webhooks da Coexistência

**Arquivos:** `lib/channels/meta/webhook.ts`, `tests/fixtures/meta/inbound-webhooks.json`, novos `lib/channels/meta/coexistencia/eco.ts`, `.../eco.test.ts`, `.../estado.ts`, `.../estado.test.ts`, `.../historico.ts`, `.../historico.test.ts`, `app/api/v1/webhooks/meta/[token]/route.ts`, `tests/unit/meta-webhook-inbound.test.ts`.

1. Fixtures: acrescentar ao JSON um payload de cada campo (`smb_message_echoes`, `smb_app_state_sync`, `history`) copiado da referência da Meta. Teste em `tests/unit/meta-webhook-inbound.test.ts` (sem `vi.mock`, como os demais): `parseMetaWebhook` devolve `AppEchoEvent { kind: "app_echo", phoneNumberId, to, externalId, type, text, sentAt }`, `AppStateSyncEvent { kind: "app_state_sync", contacts: [{ phone, name }] }`, `HistoryEvent { kind: "history", messages: [...] }` com direção por mensagem. Rodar — vermelho.
2. `webhook.ts`: parser dos três campos. Os tipos entram na união `MetaWebhookEvent`.
3. `eco.test.ts` (admin falso): eco de texto → mensagem `direction: "outbound"`, `status: "delivered"`, `external_id` do eco, `metadata: { origem: "app" }`, `fn_mark_conversation_message` com `outbound`, e `conversations.bot_silenced_until = agora + silêncio`; 23505 → `duplicate`; eco para contato inexistente cria contato e conversa pelas mesmas RPCs do ingest. Silêncio lido de `organizations.settings->>'coexistence_silence_minutes'` (o jsonb `settings` existe e já guarda `visibility_mode`; default 10). Rodar — vermelho; implementar `eco.ts`; verde.
4. `estado.test.ts`: cada contato do sync vira `fn_upsert_wa_contact` com nome; sem sobrescrever nome já editado à mão (conferir se a RPC já tem essa regra; se não, só chamar quando o contato não existir). Implementar `estado.ts`.
5. `historico.test.ts`: mensagem inbound do histórico passa por `ingestMetaInbound` com `sent_at` original; outbound passa por `eco.ts` **sem** silenciar o Agente (flag `silenciar: false`); duplicatas por `external_id` são contadas e ignoradas; devolve `{ importadas, duplicadas }`. Implementar `historico.ts`. Não chamar `aplicarEfeitosPosEntrada` para histórico (não é mensagem nova: sem follow-up, sem turno do Agente). `ingestMetaInbound` chama esse efeito incondicionalmente (linha ~211) e não expõe opção: acrescentar um quarto parâmetro opcional `{ efeitosPosEntrada?: boolean }` com default `true`, edição de duas linhas em código herdado, documentada no commit. `sentAt` já é parâmetro do evento.
6. Rota do webhook: o `switch` por `kind` ganha os três casos, cada um com sua função. Conferir que a assinatura (`verifyMetaSignature`) já cobre o corpo inteiro, seja qual for o campo.
7. Invariante `tests/invariants/coexistencia-eco-silencia-o-agente.test.ts`: pelo banco real, após o eco, `comando_da_conversa(conversations)` não é o Agente até o fim do silêncio (usa `fn_comando_da_conversa` com `p_agora` fixo).
8. Rodar `pnpm vitest run lib/channels/meta/coexistencia tests/unit/meta-webhook-inbound` e `pnpm test:db` — verde. Commit: `feat(channels): consume the coexistence webhooks — echo, state sync, history`.

### Tarefa 13 — Gates, prova e HITL

1. `pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit --maxWorkers=3 && pnpm test:shell && pnpm build && pnpm test:db`, cada um redirecionado para arquivo; ler os rodapés. (`test:shell` tem um vermelho pré-existente de apóstrofo no macOS; conferir que é só esse.)
2. Rodar a prova da issue: `pnpm vitest run lib/channels/adapters/fake lib/rotinas lib/channels/meta/coexistencia`. Colar o rodapé na issue #20.
3. Registrar na ADR-0015 a nota de que o Embedded Signup é opcional por instalação (feito junto com este plano).
4. Abrir PR para `main` com `## Resumo`, `## Mudanças`, `## Testes`, `## Checklist`, e `Closes #20` só depois do HITL.
5. **HITL (José), em paralelo desde o dia um:** (a) Business Verification da LAVRA no Meta Business; (b) app Meta com produto WhatsApp; App Review para `whatsapp_business_messaging` e `whatsapp_business_management`, um vídeo por permissão; (c) criar a configuração do Embedded Signup com o recurso de onboarding de usuário do app; preencher `META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID` na instalação; (d) num telefone com WhatsApp Business ≥ 2.24.17 e um chip de teste, conectar pela tela; mandar mensagem de outro celular; responder pelo app; conferir na Conversa a entrada, o eco e o silêncio do Agente. (e) Se a aprovação da Meta passar da Fase 4 pronta, abrir conta em Kapso ou Zernio e conectar pela tela de canal parceiro, sem mudar código.

---

## O que este plano não faz

Não mexe em `inbound-turn.ts`. Não cria adapter Kapso (o de Zernio existe como ponte). Não implementa o aviso ao Dono por WhatsApp quando uma rotina falha — isso precisa do destinatário "dono", que é da Fase 7; até lá o alerta é linha em `job_runs`, item em `agent_inbox_items` e audit. Não reduz a colisão entre app e Agente além do silêncio por intervalo (ADR-0014).
