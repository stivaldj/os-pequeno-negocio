# Plano — Fase 4: Clínica Humana no ar — agenda pelo WhatsApp, Google Calendar, preço e valor pago

Issue: #22. Spec: `docs/spec/0003-relatorio-das-8h.md` (O dinheiro → Receita; Painel). ADRs: 0012, 0013, 0017.

**Objetivo.** O paciente pede horário pelo WhatsApp, o Agente lista serviços, encontra vaga e agenda; o evento é empurrado ao Google Calendar pelo cron herdado; a recepção marca "compareceu" com o valor pago, que é a Venda Confirmada (ADR-0017); cada serviço tem preço e Margem Declarada; o paciente recebe lembrete da consulta; e existe um script de Embarque que coloca a clínica no ar a partir de um arquivo com os nomes, serviços, expediente e preços que só o Dono tem.

**Arquitetura.** Quase tudo já existe no fork: motor de horários, tools MCP de agenda, push ao Google por cron, tela do dia com "compareceu"/"faltou", tela de tipos de agendamento, vocabulário do funil, playbook por camadas, versão publicada do agente. O que falta e entra nesta fase: **duas colunas de dinheiro** (`price_cents` e `margin_bps` em `calendar_event_types`; `paid_cents` em `calendar_appointments`), o valor pago no "compareceu" (API + tela), preço na tool `crm_list_event_types` (para o Agente responder preço com o que o Dono cadastrou), o **cron de lembrete** que consome as colunas `reminder_*` que o fork criou e nunca leu, o **script de Embarque** e o **script de prova**. Nada em `inbound-turn.ts`; o playbook da clínica é conteúdo, instalado na camada `tenant`.

**Desvios de texto da spec, decididos aqui.** (1) A spec falava numa tabela `service_pricing`; duas colunas no tipo de agendamento fazem o mesmo com menos peças, e o tipo já é "o serviço". (2) A issue falava em `followup_flow_versions` para a confirmação; não existe gatilho de agenda nos fluxos, e o fork já tem `reminder_enabled`, `reminder_minutes_before`, `reminder_template_name` e `reminder_sent_at` sem leitor — o lembrete nasce consumindo isso. A confirmação pela resposta do paciente é o Agente chamando `crm_confirm_appointment`, instruído pelo playbook.

**Prova da fase** (da issue): `pnpm tsx scripts/prova-agenda.ts` contra uma pilha local (Supabase de desenvolvimento com `.env.local`, como os `scripts/seed-e2e-*`). O script semeia uma Conta de saúde com sessão `fake_channel`, um Profissional com Expediente, um serviço com preço e margem; injeta pelo adapter fake uma mensagem clínica e afirma o marcador (asserção da Fase 3); chama **in-process** `crm_list_event_types` → `crm_find_free_slots` → `crm_book_appointment` (handlers com `McpContext`, como o worker faz); afirma o `event_log` `agenda.appointment.push_to_google` pedido; move o agendamento para o passado por SQL (o handler exige desfecho sobre o passado) e chama o handler de PATCH com `completed` + `paid_cents`; afirma `paid_cents` gravado e `price_cents`/`margin_bps` no tipo; roda o lembrete a seco e afirma `reminder_sent_at`. Com `PROVA_GOOGLE=1` e um Calendar conectado na Conta, roda o push e afirma `google_event_id`; sem isso, o push real é o HITL.

**Ambiente.** `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`. `test:unit` com `--maxWorkers=3`. Baseline: apêndice antes da varredura anon; constraint nova corrige dados antes de nascer (aqui não há dados: colunas novas nulas).

---

## Parte A — Dinheiro no schema, na API e na tool

### Tarefa 1 — Migration 0207: preço, margem e valor pago

**Arquivos:** `supabase/baseline.sql` (bloco antes da varredura), `supabase/migrations/20260902000300_0207_preco_margem_e_valor_pago.sql`, `supabase/migrations/MANIFEST.md`, novo `tests/invariants/agenda-dinheiro.test.ts`.

1. Invariante primeiro (padrão SQL de `rls-isolation.test.ts`): as três colunas existem; `margin_bps` recusa 10001 e -1; `paid_cents` recusa -1; `price_cents` recusa -1; org B não vê tipo nem agendamento da org A (a RLS existente cobre as tabelas; o teste só confirma que continua). Rodar `pnpm test:db tests/invariants/agenda-dinheiro.test.ts` — vermelho.
2. SQL: `alter table calendar_event_types add column if not exists price_cents bigint null, add column if not exists margin_bps integer null;` + checks `price_cents >= 0` e `margin_bps between 0 and 10000` (`drop constraint if exists` + `add`, uma vez só). `alter table calendar_appointments add column if not exists paid_cents bigint null, add column if not exists paid_currency char(3) not null default 'BRL';` + check `paid_cents >= 0`. `comment on column` explicando Margem Declarada em pontos-base e "pago nulo = dado faltante, não zero" (ADR-0017). `notify pgrst, 'reload schema'`.
3. Verde. Commit: `feat(db): price, declared margin and paid amount on the agenda`.

### Tarefa 2 — API de tipos e de agendamentos, e a tool lista preço

**Arquivos:** `app/api/v1/agenda/tipos/route.ts`, `app/api/v1/agenda/agendamentos/route.ts`, `app/api/v1/agenda/agendamentos/_handler.ts`, `lib/agenda/consulta.ts` (`listaTiposDeAtendimento`, se for onde o select vive), `lib/mcp/tools/agendamento.ts`, testes: novo `tests/unit/agenda-dinheiro-api.test.ts`, existentes de agendamentos/tipos (procurar `tests/unit/agenda-*`).

1. Testes: `criarSchema` de tipos aceita `price_cents` (int ≥ 0, opcional) e `margin_bps` (0..10000, opcional); `alterarSchema` de agendamentos aceita `paid_cents` **só** junto de `status: "completed"` (refine: `paid_cents` sem `completed` → inválido); o handler grava `paid_cents` e `paid_currency` quando `completed`; `crm_list_event_types` devolve `preco_cents` e `moeda` por tipo (null quando não cadastrado). Rodar — vermelho.
2. Implementar. `marcarAgendamentoHandler` passa a gravar `conversation_id` quando o `McpContext` o tiver (hoje a coluna existe e fica sempre nula; é `_handler.ts`, permitido) — o lembrete da Tarefa 4 usa isso como caminho primário. Corrigir valor: um segundo PATCH `completed + paid_cents` sobre agendamento já `completed` **atualiza** `paid_cents` (não devolve `inalterado`); o refine do Zod exige `status: "completed"` no mesmo corpo. Na tool, o campo entra na resposta e na descrição da tool ("preço cadastrado pelo Dono; se nulo, diga que não tem o valor e ofereça a recepção"). Auditoria: o PATCH de `completed` hoje não audita por decisão herdada; com valor pago, **passa a auditar** `agenda.appointment_paid` com `metadata: { appointment_id, paid_cents }` — é mutação de dinheiro. Registrar a ação em `lib/audit/actions.ts`.
3. Verde. Commit: `feat(agenda): paid amount on completion; price and margin on event types; the agent sees the price`.

### Tarefa 3 — Telas: preço e margem no tipo; valor no "compareceu"

**Arquivos:** `app/app/settings/tenant/agenda/_client.tsx`, `components/agenda/HistoricoDaAgenda.tsx`, `app/app/agenda/_client.tsx`, `hooks/agenda/useRemarcarAgendamento.ts`, `lib/agenda/consulta.ts` (`listaAgendamentos`/`AgendamentoListado` ganham `price_cents` e `paid_cents` via `calendar_event_types(price_cents)` — o coletor hoje não traz `event_type_id` nem preço; o mesmo coletor serve `crm_list_appointments`, e o preço vai junto), o GET de `app/api/v1/agenda/agendamentos/route.ts`, `components/agenda/tipos.ts`, o hook `useAgendamentos`, `lib/i18n/dicionario.ts`, testes: novo `tests/unit/agenda-dinheiro-tela.test.tsx` (padrão de `tests/unit/canal-parceiro-tela.test.tsx`).

1. Testes: o formulário de tipo tem campos "Preço (R$)" e "Margem declarada (%)" e envia `price_cents`/`margin_bps` (reais → centavos, % → bps); o botão "Compareceu" abre um diálogo com o valor pré-preenchido pelo preço do tipo e envia `{ id, status: "completed", paid_cents }`; deixar em branco envia sem `paid_cents` (dado faltante, não zero) e mostra aviso. Rodar — vermelho.
2. Implementar com os componentes shadcn já usados no arquivo (`Dialog`, `Input`). `useRegistrarDesfecho` aceita `paid_cents?`. Chaves em espanhol.
3. `pnpm vitest run tests/unit/agenda-dinheiro-tela tests/unit/i18n-espanhol-cobre-a-tela`. Commit: `feat(agenda): the day screen asks how much was paid on attendance`.

## Parte B — Lembrete de consulta

### Tarefa 4 — Cron `agenda-lembretes` consome as colunas `reminder_*`

**Arquivos:** novos `lib/agenda/lembretes.ts`, `lib/agenda/lembretes.test.ts`, `app/api/v1/cron/agenda-lembretes/route.ts`; `docker/scheduler/entrypoint.sh`, `lib/rotinas/esperadas.ts`, `lib/audit/actions.ts`.

1. Ler `lib/ai/handoff/aviso-ao-lead.ts` para copiar como se envia mensagem ao contato pelo CRM (`sendMessageHandler` despacha pelo adapter; no `fake_channel` cai em `registrarEnvio`). Data/hora no fuso do agendamento com `rotuloLocal` de `lib/tempo/agora.ts` (o que `lib/mcp/tools/agendamento.ts` já usa) e `lib/agenda/fuso.ts`. Conversa: `calendar_appointments.conversation_id` quando houver (Tarefa 2), senão a última conversa do contato — **este é o caminho primário nos dados de hoje**, e o teste o cobre primeiro.
2. Teste com admin falso: `enviarLembretesDevidos(admin, { agora })` seleciona agendamentos `status in ('pending','confirmed')`, `reminder_sent_at is null`, tipo com `reminder_enabled`, `starts_at - reminder_minutes_before <= agora < starts_at`; para cada um envia pela conversa do agendamento (ou pela última conversa do contato) o texto "Lembrete: sua consulta de <serviço> é <dia> às <hora> com <Profissional>. Responda SIM para confirmar ou avise se precisar remarcar." — **sem motivo, sem especialidade além do nome do serviço que o próprio paciente escolheu** (ADR-0012); marca `reminder_sent_at`; audit `agenda.reminder_sent`; a seco (`{ dryRun: true }`) devolve os candidatos sem enviar nem marcar. Sem conversa/canal → pula e registra `sem_canal`. Rodar — vermelho.
3. Implementar; rota com auth de cron + `comExecucaoDeRotina("agenda-lembretes", ...)`; `*/10 * * * *|60|api/v1/cron/agenda-lembretes` em `CRONS`; entrada (10) em `ROTINAS_ESPERADAS`.
4. `pnpm vitest run lib/agenda/lembretes lib/rotinas tests/unit/cron-routes-scheduled tests/unit/cron-routes-registram-execucao tests/unit/cron-audita-so-quando-ha-efeito`; `pnpm test:shell`. Commit: `feat(agenda): appointment reminders finally read the reminder columns`.

## Parte C — Embarque da clínica

### Tarefa 5 — Playbook da clínica e o arquivo de Embarque

**Arquivos:** novos `lib/clinica/playbook.ts`, `lib/clinica/playbook.test.ts`, `lib/clinica/embarque.ts`, `lib/clinica/embarque.test.ts`, `scripts/clinica/embarque.ts`, `scripts/clinica/embarque.exemplo.json`.

1. `playbook.ts`: `PLAYBOOK_DA_CLINICA` — texto que passa por `validatePlaybookLayerContent` (exportado de `lib/agent-engine/agent/playbook.ts:47`) (seções `## ...`, ≤200 linhas): quem é (assistente virtual da clínica, IA declarada), o que faz (informação cadastrada, endereço, convênios, preço quando houver, agendar por serviço e Profissional, remarcar, cancelar, confirmar quando o paciente responde SIM ao lembrete), o que não faz (não avalia sintoma, não indica remédio, não diz se é grave — "isso quem responde é a equipe"; não promete resultado; não dá desconto fora de tabela), como para (pedido de humano, reclamação, desconto, dúvida clínica → `request_human_handoff`), fora do Expediente (avisa que a clínica está fechada e segue agendando — ADR-0013), e uma seção `## Vocabulário` com Paciente/Agendado. Teste: `validatePlaybookLayerContent` aceita e o texto contém as frases-chave.
2. `embarque.ts`: `embarqueSchema` (Zod) do arquivo JSON: `{ organization_id, dono: { nome, whatsapp }, profissionais: [{ email, nome, expediente: { timezone, windows[] } }], servicos: [{ slug, nome, duracao_minutos, price_cents?, margin_bps?, profissional_email?, lembrete_minutos_antes? }], convenios: string[], endereco, expediente_da_clinica }`; `executarEmbarque(admin, pool, dados)` idempotente: vocabulário do funil (lead → "Paciente", won → "Agendado") via `settings` (mesmo merge de `pipelineConfigPatchSchema`), etapas `agendamento-solicitado` e `agendado` garantidas no funil padrão, `attendant_availability` por Profissional (usuário precisa existir: sem ele, reporta e pula), `calendar_event_types` por serviço (upsert por slug, com preço e margem; `lembrete_minutos_antes` mapeia para **`reminder_enabled = true` e `reminder_minutes_before`** — o fork faz o lembrete nascer desligado, migration 0194), playbook `tenant` (idempotente por md5 como a migration 0191), aviso de IA (`instalarAvisoDeIa`), `settings.clinica.redacao_clinica = true`, e versão do agente com `tool_ids` montados por `catalogoComHandler()`/`ligarPacote` de `lib/ai/agents/capacidades-padrao.ts` (pacote de agenda + handoff + conhecimento), nunca lista à mão; publicar via o mesmo insert de `createDefaultAgent.ts`, ou só acrescentar as tools à versão publicada se já houver. Devolve um relatório `{ feito: string[], pulado: [{ item, motivo }] }`.
3. Teste de `embarque.ts` com admin falso e pool falso: schema recusa arquivo sem serviço; upsert de tipos por slug; profissional sem usuário vai para `pulado`; relatório completo. Rodar — vermelho; implementar; verde.
4. `scripts/clinica/embarque.ts <arquivo.json>`: lê credenciais por `scripts/lib/env-de-teste.ts`, imprime o relatório. `embarque.exemplo.json` com a Clínica Humana como está no site (`docs/research/clinica-humana.md`): 14 serviços, expediente seg–sex 7h–19h30, endereço, um Profissional de exemplo com e-mail placeholder. Nomes reais, preços e convênios ficam para o Dono (HITL).
5. Commit: `feat(clinica): onboarding from a file — playbook, services, hours, prices`.

## Parte D — Prova e gates

### Tarefa 6 — `scripts/prova-agenda.ts`

**Arquivos:** novo `scripts/prova-agenda.ts`, novo `scripts/lib/prova.ts` (helpers `afirmar`, `passo`), `lib/clinica/embarque.ts` (reuso).

1. Copiar de `tests/e2e/agente-marca-consulta.spec.ts` a sequência e de `scripts/seed-e2e-agenda.ts` o seed. O script: (a) credenciais por `credenciaisSupabaseDeTeste()`; (b) semeia org "Clínica Prova" com `settings.clinica.redacao_clinica`, usuário Profissional, `attendant_availability` seg–sex 07:00–19:30 no fuso de Cuiabá, tipo `consulta-clinica-geral` 30 min com `price_cents: 20000`, `margin_bps: 6000`, `reminder_enabled: true`, `reminder_minutes_before: 1440`, sessão `fake_channel` (`garantirSessaoFake`), contato; (c) `handleInboundWebhook` com corpo clínico e afirma `messages.body` marcador e conversa em Passagem (`bot_silenced_until`); (d) in-process: `crmListEventTypes.handler` → afirma `preco_cents = 20000`; `crmFindFreeSlots.handler` → afirma `horarios.length > 0`; `crmBookAppointment.handler` no primeiro horário → afirma `marcado`; (e) afirma `needs_google_push = true` no agendamento (a coluna gerada da migration 0200 é o que o cron consome; o `event_log` `agenda.appointment.push_to_google` é dead letter documentada e não prova nada); (f) `update calendar_appointments set starts_at = now() - interval '2 hours', ends_at = ...` por SQL (comentário: o handler exige desfecho sobre o passado; em produção é o relógio); `alterarAgendamentoHandler` com `{ id, status: "completed", paid_cents: 20000 }` → afirma `paid_cents` e `paid_currency`; (g) lembrete: cria um segundo agendamento amanhã e roda `enviarLembretesDevidos` com `agora = starts_at - 23h`, afirma `reminder_sent_at` e um envio na caixa fake (`lerEnviados`) contendo "Lembrete"; (h) se `PROVA_GOOGLE=1`: chama `GET(new NextRequest(url, { headers: { authorization: `Bearer ${INTERNAL_CRON_SECRET}` } }))` da rota `agenda-google-push` (só `GET` é exportado, embrulhado por `comExecucaoDeRotina`; exige `lib/env` carregado e grava `job_runs`) e afirma `google_event_id`; senão imprime "push ao Google: HITL". Limpa a org no fim (ou deixa com `--manter`).
2. Pilha local: esta máquina tem o CLI `supabase` e `supabase/config.toml`, mas não `.env.local`. Subir com `supabase start`, exportar `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` e `SUPABASE_DB_URL` a partir de `supabase status -o env` (o `credenciaisSupabaseDeTeste()` lê `process.env` primeiro), aplicar o baseline (`psql $SUPABASE_DB_URL -f supabase/baseline.sql`, como `scripts/test-db.sh` faz) e rodar. Sem pilha, o script falha com mensagem clara de pré-requisito. `scripts/**` fica fora do `tsc`: a lógica vive em `lib/clinica/embarque.ts`; os scripts são finos.
3. Commit: `test(prova): the agenda proof — from clinical redaction to the paid visit`.

### Tarefa 7 — Gates, issue, HITL

1. `pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit --maxWorkers=3 && pnpm test:shell && pnpm build && pnpm test:db` em arquivos; rodapés.
2. Rodar `pnpm tsx scripts/prova-agenda.ts` e colar o resultado em #22, dizendo que o passo do Google é opcional na prova automatizada e obrigatório no HITL. PR para `main` **sem** `Closes #22`: a fase fecha com o HITL (playbook aprovado pelo José, três atendimentos reais, evento no Google da clínica).
3. HITL (José): preencher `embarque.json` com os dados do Dono (nomes, e-mails dos Profissionais, preços, margens, convênios); rodar `pnpm tsx scripts/clinica/embarque.ts embarque.json`; conectar o Google Calendar na tela da agenda; conectar o Número (Coexistência ou ponte, Fase 2); acompanhar os três primeiros atendimentos.

## O que este plano não faz

Não cria tabela `service_pricing` (colunas no tipo). Não cria gatilho de agenda nos fluxos de follow-up. Não cria tela nova (as duas existentes ganham campos). Não toca `inbound-turn.ts` nem `before-send.ts`. Não faz o push ao Google no POST do agendamento (continua no cron herdado).

---

## Desvios registrados na execução (02/09/2026)

- **Seed do invariante do dinheiro usa slug próprio**: o gatilho de nova organização já semeia `consulta`, `atendimento` e `reuniao` em `calendar_event_types`; `on conflict do nothing` engolia o seed.
- **`conversation_id` passa a ser gravado no `crm_book_appointment`** (última conversa do contato): a coluna existia desde a 0177 e ninguém a preenchia; o lembrete usa como atalho e mantém a busca por contato como caminho primário.
- **`lib/agenda/dinheiro.ts`** concentra reais↔centavos e %↔pontos-base para tela e histórico não divergirem.
- **`precoDoTipo` exportada de `lib/agenda/consulta.ts`** e `listaAgendamentos` traz `price_cents`/`paid_cents` — o `crm_list_appointments` vê o preço, nunca o valor pago.
- **Lembrete**: recorte grosso no banco (30 dias, status, `reminder_sent_at is null`) e janela exata em memória, porque o PostgREST não compara `starts_at - reminder_minutes_before` com o relógio; marca idempotente com `.is(reminder_sent_at, null)`; falha de envio não marca.
- **Embarque** não cria usuário: Profissional sem conta na org vai para `pulado` com `usuario_inexistente`. Ação `clinica.embarque_executado` no audit.
- **Dois agentes de execução morreram com a sessão** (Tarefas 3 e 5); o trabalho foi recuperado das worktrees e fechado à mão.
