# HANDOFF — continuar a Spec 0003 a partir da Fase 6

Escrito em 02/09/2026 ao fim de uma sessão longa no Claude Code (Mac do José). Cole este arquivo inteiro como primeira mensagem da próxima janela.

---

## Prompt para a próxima janela

Você continua o trabalho no repo `~/CODING/newstuff/os-pequeno-negocio` (fork do DeskcommCRM; remoto `origin` = `stivaldj/os-pequeno-negocio`, `upstream` = `melgarafael/DeskcommCRM`). Responda em português do Brasil; código, arquivos e commits em inglês. Antes de qualquer coisa, leia nesta ordem: `CLAUDE.md`, `CONTEXT.md`, `docs/spec/0003-relatorio-das-8h.md`, as ADRs 0015 a 0019 em `docs/adr/`, e os planos executados em `docs/superpowers/plans/` (2026-09-01 e 2026-09-02, quatro arquivos) — cada um termina com uma seção "Desvios registrados na execução" que explica o que o código faz de diferente do plano e por quê.

### Onde o projeto está

Cliente zero: Clínica Humana (Várzea Grande-MT, Google Ads com link para WhatsApp, número fixo já no app). Alvo: a frase de destino do README inteira para uma Conta — atendimento, agenda, ads, caixa e o Relatório das 8h.

Fases concluídas em código (todas com PR mergeado ou aberto, gates verdes, HITL pendente registrado na issue):

| Fase | Issue | PR | Estado |
|---|---|---|---|
| 1 — fork limpo | #19 | #27 mergeado | falta HITL: `install.sh` numa VPS |
| 2 — adapter fake, `job_runs`, Coexistência pela Meta | #20 | #33 mergeado | falta HITL: Tech Provider na Meta, número de teste em Coexistência |
| 3 — redação clínica, aviso de IA, vigia de ato médico | #21 | #34 mergeado, issue fechada | — |
| 4 — agenda, preço/margem, valor pago, lembrete, Embarque | #22 | #36 mergeado | falta HITL: `embarque.json` do Dono, Google Calendar, 3 atendimentos reais |
| 5 — Página de Captura, Sobra por Real, conversão offline, Agente de Anúncios nível 1, destinatário "dono", tela Anúncios | #23 | **#37 aberto** | falta merge + HITL: MCC, developer token, refresh token, conversion action, `scripts/prova-ads.ts` |

PRs auxiliares abertos e mergeáveis: #31 (CI: heap do typecheck), #32 (CI: e2e em duas partes com teto 40 min), #35 (transcrição de áudio passa pela redação clínica). O CI do fork é vermelho por dois motivos pré-existentes que esses PRs corrigem; os gates locais do `CLAUDE.md` são a autoridade.

Próximas fases, já com issue e prova vermelha: **Fase 6 (#24) — financeiro por OFX**, Fase 7 (#25) — Relatório das 8h, Fase 8 (#28) — níveis 2 e 3 do Agente de Anúncios.

### Como trabalhar (o que funcionou)

1. Uma fase = um plano em `docs/superpowers/plans/AAAA-MM-DD-fase-N-<tema>.md` (objetivo, arquitetura, decisões que o levantamento impôs, prova da fase, tarefas com teste antes do código e um commit por tarefa, "o que este plano não faz"). Antes de escrever, despache um agente `Explore` para mapear o código que a fase toca e, se houver API externa, um agente de pesquisa com WebSearch contra fonte primária. Depois passe o plano por um agente revisor (prompt: "plan document reviewer", conferindo buildability por grep) e aplique o que ele achar.
2. Execute em paralelo com agentes em worktree (`isolation: worktree`), um por tarefa independente, cada um com `git reset --hard <hash>` do commit do plano e instruções com caminhos e assinaturas exatos. Você mesmo faz a migration e o que depende dela. Mescle as branches `worktree-agent-*` na branch da fase; conflitos previsíveis: `lib/audit/actions.ts`, `docker/scheduler/entrypoint.sh`, `lib/rotinas/esperadas.ts`, `lib/i18n/dicionario.ts`.
3. Gates antes do PR, cada um redirecionado para arquivo em `/private/tmp/claude-501/` e lendo o rodapé: `pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit --maxWorkers=3 && pnpm test:shell && pnpm build && pnpm test:db`. `test:shell` tem um vermelho pré-existente (apóstrofo no macOS): é aceitável. Rode a prova da issue e cole o rodapé como comentário na issue; PR com `## Resumo / ## Mudanças / ## Testes / ## Checklist`, sem `Closes` quando a fase tem HITL.
4. Registre os desvios no fim do plano e commite.

### Regras do repo que mais morderam

- `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"` antes de qualquer `pnpm` (o shell resolve Node 18). Em worktree de agente, o sandbox pode recusar `export`; usar `/Users/joseoliveira/.nvm/versions/node/v22.22.0/bin/pnpm` direto e criar `node_modules -> ../../../node_modules`.
- Schema só por apêndice idempotente no `supabase/baseline.sql` **antes** do bloco `VARREDURA anon` (último do arquivo), mais o arquivo em `supabase/migrations/NNNN_*.sql` e a linha no `MANIFEST.md`. Constraint de vocabulário existente se edita in place (uma constraint, um bloco). Tabela nova: RLS com leitura por membro e escrita por `fn_role_at_least(organization_id,'manager')` — policy `ALL` só de tenancy reprova no guarda de RBAC; entrada em `PROVA_PROPRIA` de `tests/invariants/rls-completude-varredura.test.ts`. Ao criar organização, um gatilho já semeia tipos de agendamento (`consulta`, `atendimento`, `reuniao`): seeds de teste usam slug próprio.
- Cron novo = rota em `app/api/v1/cron/<nome>/route.ts` embrulhada por `comExecucaoDeRotina`, linha em `CRONS` do `docker/scheduler/entrypoint.sh` (`min|timeout s|rota`, teto praticado 120), entrada em `lib/rotinas/esperadas.ts`, e `audit()` só dentro da lib sob `if` (a rota não audita).
- Ponto de IA novo entra em `lib/ai/pontos/registro.ts` com `purpose: 'nome'` em aspas simples no chamador. Chamada de modelo fora do turno só por `runModelCall` (`maxSteps`, `getRequestPool()`, `llmEdgeConfigFromEnv(env)`).
- Env nova em `lib/env.ts` + `.env.example` (comentário em linha própria). `.env.hostgator.example` só aceita chave que o `install.sh` grava — as da Meta e do Google ficaram de fora, registrado.
- Chave de i18n nova precisa de espanhol em `lib/i18n/dicionario.ts` (o gate reprova). Tela nova precisa de porta em `lib/navigation/registry.ts`.
- Nunca editar `lib/agent-engine/agent/inbound-turn.ts`; nenhum nome de provider fora de `lib/channels/`; texto do Contato nunca persiste se for clínico (o preparador `lib/clinica/redacao.ts` roda antes de todo insert de entrada).
- `tsx` não carrega os handlers do produto (exports de `@react-pdf`): provas de realidade vivem em `tests/prova/*.prova.ts` rodadas por `vitest.prova.config.ts`, com `scripts/prova-*.ts` como casca. A pilha local sobe com `supabase start` **sem** a pasta `supabase/migrations` (stub parcial por desenho): mover a pasta, subir, restaurar, rodar o prelúdio de `scripts/test-db.sh` e o baseline via psql.
- Docker Desktop cai de vez em quando e o daemon não volta sozinho; `open -a Docker` e esperar. Contêiner `deskcomm-test-db-*` órfão de uma sessão morta precisa de `docker rm -fv`.

### Fase 6 — o que a spec e a issue #24 pedem

`lib/financeiro/` com parser OFX, `ledger_entries`, categorias, `payables`/`receivables`, tela Financeiro (importar OFX, caixa, contas) com porta no registry, cron `financeiro-lembretes` ao Dono via `enviarAoDono` de `lib/dono/destinatario.ts`. Receita por paciente **não** vem do OFX (ADR-0017): vem de `calendar_appointments.paid_cents`. Prova: `pnpm vitest run lib/financeiro` com OFX real anonimizado gerando saldo e vencimentos do dia; importar o mesmo OFX duas vezes não duplica. Bloqueada por #20 (usa `job_runs` e o adapter fake), já entregue.

Comece por: levantamento de código (tabelas de dinheiro existentes, `orders`, padrão de importação de arquivo em `app/api/v1/contacts/import` e `lib/contacts/csv.ts`, tela de importação `components/contacts/ImportContactsDialog.tsx`), pesquisa do formato OFX 1.x/2.x usado por bancos brasileiros (SGML vs XML, `STMTTRN`, `FITID` como chave de idempotência), plano, revisão, execução.
