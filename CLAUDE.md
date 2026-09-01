# OS Pequeno Negócio

Nome provisório. Produto da linha **Veio** da LAVRA. Cliente zero: Clínica Humana.

Este repo é um **fork do DeskcommCRM** (`melgarafael/DeskcommCRM`, remote `upstream`). A camada de atendimento, CRM, agenda e follow-up é herdada; os módulos proprietários (ads, financeiro, redação clínica, relatório das 8h) entram por cima. Mapa do que foi herdado em `docs/research/mapa-deskcommcrm.md`; plano por fases em `docs/research/handoff-fork-deskcomm.md`.

## Agent skills

### Issue tracker

GitHub Issues, via a CLI `gh`. Ver `docs/agents/issue-tracker.md`. Todo ticket carrega `## Prova` no formato da skill `prova-de-aceite` (comando único, rodado, vermelho hoje).

### Triage labels

Cinco papéis canônicos, com `wontfix` renomeado para `descartado`, mais labels de categoria. Ver `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` na raiz e ADRs em `docs/adr/`. Ver `docs/agents/domain.md`. As leis herdadas do upstream vivem em `docs/doctrine/` (canal, packaging, versionamento, sistema vivo, separação fala × operação).

## Idioma

Docs em português do Brasil; código, nomes de arquivo e commits em inglês. Detalhe em `docs/agents/domain.md`.

## Regra do fork (NÃO NEGOCIÁVEL)

- **Módulo próprio nunca edita `lib/agent-engine/agent/inbound-turn.ts`.** Ads, financeiro, redação clínica e relatório entram como pasta própria em `lib/` e worker próprio, falando com o CRM via MCP (`lib/mcp/`) e `event_log`. Se parecer necessário mexer no turno, o módulo está no lugar errado — pare e pergunte.
- **Um motor só.** O agente é `lib/agent-engine/`. O motor antigo (o runtime em lib/ai/runtime e o dispatcher nativo, ambos apagados) foi removido na Fase 1 e `tests/unit/handoff-por-orcamento.test.ts` reprova a volta dele.
- **Canal só em `lib/channels/`.** Adapter novo (Kapso, fake) copia a forma do `meta-cloud`; nenhum `if (provider === ...)` fora do seam. `pnpm lint:channels` é catraca. Lei em `docs/doctrine/restricao-de-canal.md`.
- **Upstream continua alcançável.** `git fetch upstream && git merge upstream/main` é a forma de absorver correções; por isso o código herdado só muda quando o produto exige.
- **Clínica:** o agente nunca persiste Conteúdo Clínico (ADR-0004), avisa que há IA (CFM 2.454/2026) e não faz triagem clínica (ADR-0012).

## Convenções herdadas do DeskcommCRM (NÃO NEGOCIÁVEIS)

### Multi-tenancy
- `organization_id uuid not null references organizations(id) on delete cascade` em **toda** tabela tenant-aware, com RLS `tenant_isolation_<tabela>_all` via `fn_user_org_ids()`.
- Service role bypassa RLS: handler com admin client **filtra `organization_id` manualmente**, resolvido de fonte confiável (cookie/JWT/webhook secret/path token), **nunca do body**.
- O teste de isolamento (2 tenants, sem vazamento) roda em `pnpm test:db` e é gate.

### Eventos e idempotência
- **Trigger Postgres NUNCA faz HTTP.** Trigger emite linha em `event_log`; worker/cron consome.
- Mensagens e eventos externos: `unique (organization_id, external_id)` + captura de `23505`.
- Evento sem consumidor é anti-pattern (`tests/unit/evento-comando-tem-consumidor.test.ts`).

### API `/api/v1/`
- Wrappers `ok()` / `fail()` de `lib/api/wrappers.ts`; JSON snake_case; dinheiro em `_cents` + `currency`.
- Auth dual (cookie ou `Bearer tok_...`); API key só em header; token plaintext mostrado uma vez, hash SHA256 no banco.
- Sempre `getUser()`, nunca `getSession()`. Zod em todo input externo.

### Audit e LGPD
- Toda mutação bem-sucedida → linha em `api_audit_log` (fire-and-forget). Cron que não fez nada não audita. Audit é append-only no schema.
- Anonimização antes de delete; cascade de redact preserva timestamps; ações `lgpd.*` auditadas.

### Schema: só via baseline
- **Toda mudança de schema entra como apêndice idempotente no fim de `supabase/baseline.sql`** (bloco `-- ---- <coisa> (migration NNNN) ----`), mais o arquivo em `supabase/migrations/` e a linha no `MANIFEST.md`. O kit self-host aplica **só o baseline**, em install (`ON_ERROR_STOP=1`) e update (re-aplica) — migration solta não chega a ninguém.
- Constraint nova corrige os dados **antes** de nascer. Função nova em `public` revoga `execute` de `public` **e** `anon`.
- `pnpm test:db` sobe Postgres efêmero, aplica install + update e roda `tests/invariants/**`. É a prova de qualquer mudança de schema.

### Packaging
- Nenhum serviço de `docker-compose.prod.yml` constrói na máquina do cliente: tudo declara `image:` publicada pelo CI. Instalação aponta para número de versão, nunca tag móvel. Lei em `docs/doctrine/packaging.md`; deploy em `docs/runbooks/deploy.md`.
- Bump que exige o operador editar arquivo à mão não entra.

### Anti-patterns proibidos
String que devia ser FK · duplicação sem fonte declarada · evento sem consumer · trigger com HTTP · service role sem filtro de org · `getSession()` no backend · API key em query string · bearer plaintext no banco · `console.log` em código merged.

## Gates

```bash
pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell && pnpm build && pnpm test:db
```

- `pnpm test:unit` é `vitest run` **sem caminho** — alcança os testes co-localizados em `lib/`, `app/`, `components/` e `hooks/`. Rodar `tests/unit` só é um verde menor.
- Não corte a saída: redirecione para arquivo e leia o rodapé (`Test Files` / `Tests`), que é a autoridade.
- Node 22 (`.nvmrc`), pnpm 9. `pnpm test:db` precisa de Docker.

## Definition of Done

1. Gates acima verdes.
2. RLS testada se tocou tabela tenant-aware; audit emitido se há mutação; Zod em input externo.
3. Env var nova em `.env.example`, `.env.hostgator.example` e `lib/env.ts` (com default que não quebra `.env` antigo).
4. Schema: apêndice no baseline + migration + MANIFEST.
5. Tela nova tem porta em `lib/navigation/registry.ts`.
6. Se tocou Dockerfile, compose ou kit: `pnpm test:shell` e a mudança chega a quem já instalou.
7. Teste verde não é progresso: a fase só fecha com a **prova de realidade** da issue (José vê funcionando).
