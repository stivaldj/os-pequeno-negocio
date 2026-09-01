# HANDOFF — Fork do DeskcommCRM como base do os-pequeno-negocio

Escrito em 01/09/2026 numa sessão de chat (sem acesso ao Mac). A próxima sessão roda no Cowork ou Claude Code, no Mac do José, com git no terminal.

## Contexto em 5 linhas

1. Produto: "funcionário perfeito" — agente de IA no WhatsApp que atende, qualifica, vende, agenda, preenche o CRM e manda relatório das 8h com gasto/retorno de ads e caixa. Frase de destino e 10 ADRs já estão em `~/CODING/newstuff/os-pequeno-negocio` (remoto privado `github.com/stivaldj/os-pequeno-negocio`). Cliente zero: Clínica Humana.
2. Auditoria do `melgarafael/DeskcommCRM` concluiu que o repo entrega ~85k LOC testados da camada atendimento/CRM/agenda/follow-up, na mesma stack e com o mesmo seam de canal que os ADRs pedem. Mapa completo em `mapa-deskcommcrm.md` (mesmo diretório deste arquivo) — **leia antes de qualquer coisa** e copie para `docs/research/mapa-deskcommcrm.md` no repo.
3. Rota escolhida: **fork**, com módulos proprietários (ads, financeiro, redação clínica) como pastas próprias em `lib/` e workers próprios, falando com o CRM via MCP e `event_log` — nunca editando `inbound-turn.ts`.
4. Transporte: Kapso (conta com 50 números) como 4º `ChannelAdapter`, copiando a forma do `meta-cloud`. Adapter fake para teste local é mais um adapter, registrado só em dev.
5. Restrições da clínica: agente não persiste conteúdo clínico (só quem/quando/qual profissional); paciente é avisado de que há IA (CFM 2.454/2026); triagem clínica é ato médico e fica fora.

## Ambiente

- Git só roda no terminal do Mac — a ponte do Cowork não apaga arquivos.
- Tracker: GitHub Issues, labels `bug`, `feature`, `chore`, `decisao`, `descartado`. Docs em `docs/`, ADRs em `docs/adr/`, tudo em português.
- Todo ticket carrega `## Prova` no formato da skill `prova-de-aceite` (comando único, rodado, vermelho hoje, critério com o que não pode mudar junto).
- Node 22, pnpm. `pnpm test:db` precisa de Docker.

## Decisão pendente no Portão 0

Um repo ou dois? Recomendação: **um repo** — o fork vira `stivaldj/os-pequeno-negocio` (ou nome definitivo que o José escolher) e `CONTEXT.md`, `docs/adr/`, `docs/research/` migram para dentro dele. Dois repos (fork + repo de docs) criam exatamente a divergência que o plano de fusão deles diz ter matado o projeto anterior. Confirmar com o José antes de mover.

Se ele confirmar: fork no GitHub → `git remote rename origin upstream` → novo `origin` privado → `git subtree`/cópia dos docs do repo atual → primeiro commit "chore: fork DeskcommCRM + docs do domínio".

## Fases — cada uma termina em prova de realidade

Herdado da doutrina deles (`docs/vendaval-fusion-plan.md` §0): teste verde não é progresso; progresso é o José VER funcionando. Parar e perguntar nos gatilhos marcados **HITL**.

### Fase 1 — Fork limpo de pé
Objetivo: o repo é seu e sobe numa VPS de teste com WAHA por QR, sem tocar em código de produto.
- Apagar: `evidence/`, `loop/`, `plan/`, `triagem/`, `tasks/`, `.specs/`, `HANDOFF*.md` da raiz, `.claude/`, `.codex/`, `.agents/`. Manter em `docs/`: `doctrine/`, `specs/`, `runbooks/`, `white-label.md`, `SETUP.md`, `ATUALIZANDO.md`, `vendaval-fusion-plan.md` (histórico útil).
- Escrever `CLAUDE.md` próprio: herda as convenções não-negociáveis deles (RLS, audit, baseline apêndice) + regra "módulo próprio nunca edita `lib/agent-engine/agent/inbound-turn.ts`".
- Escolher um motor: apagar `lib/ai/runtime/agent.ts` e `tools.ts`, migrar os 5 chamadores (`app/actions/onboarding/createDefaultAgent.ts`, `montarQuadro.ts`, rota `versions/[vid]/test`, seu teste, `app/api/internal/agents/run`) para o agent-engine. **HITL** se a migração exigir mudar comportamento visível do onboarding.
- Rodar `pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit && pnpm test:shell && pnpm build && pnpm test:db`.
- **Prova:** `bash hostgator-setup-kit/install.sh --yes` numa VPS descartável seguido de `bash hostgator-setup-kit/healthcheck.sh` com saída sem ✗; QR escaneado; mensagem real entra no inbox. Critério: nenhum arquivo em `lib/` ou `app/` alterado além dos chamadores do motor antigo.

### Fase 2 — Adapters fake e Kapso
Objetivo: mensagem real entra e sai pelo número da clínica via Kapso; testes locais rodam sem Kapso.
- Ler `docs/doctrine/restricao-de-canal.md` inteiro e `lib/channels/types.ts`, `adapters/meta-cloud.ts`, `meta/*.ts`, `inbound.ts`, `capabilities.ts` antes de escrever.
- Fake primeiro: `lib/channels/adapters/fake.ts` + `provider: "fake"`, registrado só quando `NODE_ENV !== "production"`. Guarda envelopes em memória e devolve `externalId` determinístico. Reaproveitar o que já existe do fork endurecido do `silicon-intern/kapso-emulator` que o José pediu em 29/08 (verificar se foi feito).
- Kapso: os 7 arquivos e 7 toques listados na seção 3 do mapa. Credencial por sessão cifrada no banco (padrão da migration 0118, ver `lib/channels/zernio/credentials.ts`). Apêndice idempotente no `baseline.sql` para o `check` de `channel_sessions.provider`. `kapso` na lista do `scripts/lint-channels.ts`.
- Extrator `extrairAtribuicao` para o `referral` do payload Kapso (passthrough da Cloud API — copiar de `lib/channels/atribuicao-de-anuncio-oficial.ts`).
- Tela de Conexões: opção Kapso com validação da credencial na hora (invariante 6 da doutrina). **HITL** para o José colar credencial e conectar o primeiro número.
- **Prova:** `pnpm lint:channels && pnpm test:unit -- lib/channels/kapso` verde, e um script `scripts/prova-kapso.ts` que envia texto a um número de teste e espera o eco pelo webhook em ≤30 s. Critério: `lib/channels/adapters/{waha,meta-cloud,zernio}.ts` intocados; nenhum `if (provider === "kapso")` fora de `lib/channels/`.

### Fase 3 — Redação clínica e aviso de IA
Objetivo: o banco da clínica nunca guarda conteúdo clínico; todo paciente é avisado de que há IA.
- Redação na ingestão: passo em `lib/channels/kapso/ingest.ts` (e no `waha/ingest.ts` se a clínica usar QR) que, quando o roteador de intenção classifica o turno como clínico, grava `messages.body` como marcador (`[conteúdo clínico redigido]`) e preserva só `contact_id`, timestamps e o profissional atribuído. Conteúdo original nunca chega ao `event_log` nem ao RAG (`lib/ai/rag/ingest/conversations.ts` já tem `anonymize/` — estender, não duplicar). Registrar como ADR.
- Conferir `lib/ai/handoff/aviso-ao-lead.ts` e `disclosure_template_versions`: cobrem o primeiro contato ou só o handoff? Se só handoff, adicionar disclosure no primeiro turno via `playbook`.
- Guardrail "não é ato médico" em `lib/ai/guardrails/lista-de-conferencia.ts`.
- **Prova:** teste de invariante em `tests/invariants/` que injeta uma mensagem clínica pelo adapter fake e afirma `messages.body` redigido, `ai_chunks` sem o texto, e a primeira mensagem de saída contendo o aviso de IA. Critério: mensagens não-clínicas continuam íntegras.

### Fase 4 — Clínica Humana no ar
Objetivo: paciente agenda pelo WhatsApp e cai no Google Calendar da clínica; recepção vê no inbox.
- Playbook e vocabulário do funil (lead → Paciente, won → Agendado) via tela de Funis.
- Conectar Google Calendar (`lib/agenda/google/`), definir `calendar_event_types` e jornada.
- Follow-up de confirmação de consulta usando `followup_flow_versions`.
- **HITL:** José aprova o playbook e acompanha os 3 primeiros atendimentos reais.
- **Prova:** `scripts/prova-agenda.ts` — pelo adapter fake, simula paciente pedindo horário, afirma `crm_find_free_slots` → `crm_book_appointment` → evento criado no Google Calendar de teste. Critério: nenhum campo clínico persistido (reusa a asserção da Fase 3).

### Fase 5 — Módulo de ads
Objetivo: cada lead vindo de anúncio tem gasto atribuído e o dono confirma venda pelo WhatsApp.
- `lib/ads/` + `workers/ads-sync-worker.ts`: Meta Marketing API (gasto por campanha/dia) → tabela `ads_spend` (apêndice no baseline). Join `contacts.atribuicao.ctwa_clid` → `crm_leads` won → `orders`.
- Margem por produto declarada no onboarding (tabela `product_margins`).
- Confirmação de venda pelo dono: pergunta via `crm_send_whatsapp_message` no fechamento, resposta grava `orders`.
- Google Ads fica fora do MVP (não há `gclid` sem LP).
- **Prova:** `pnpm test:unit -- lib/ads` com fixture de gasto + 2 leads won calcula retorno por real; e query real via MCP do Supabase mostrando `ads_spend` populada após um sync. Critério: nada em `lib/agent-engine/` alterado.

### Fase 6 — Módulo financeiro
Objetivo: fluxo de caixa, contas a pagar/receber e lembretes, a partir de OFX (Pluggy descartado — sem plano comercial gratuito).
- `lib/financeiro/`: parser OFX, lançamentos, vencimentos, categorias. Lembrete via `schedule_followup`/`crm_send_whatsapp_message` para o dono.
- **Prova:** `pnpm test:unit -- lib/financeiro` com OFX real anonimizado gerando saldo e vencimentos do dia.

### Fase 7 — Relatório das 8h
Objetivo: a frase de destino completa — o dono abre o WhatsApp às 8h e vê atendimentos da noite, CRM preenchido, gasto/retorno de ads, caixa do dia e lembretes enviados.
- Cron no `scheduler` (`lib/agent-engine/cron/schedule.ts`) consumindo Fases 5 e 6 + `metrics`. Destinatário "dono" é campo novo em `organizations`.
- **Prova:** `scripts/prova-relatorio.ts` gera o relatório para uma org de fixture e afirma as 5 seções presentes; **HITL** José recebe o real no WhatsApp.

## Skills sugeridas para a próxima sessão

Digitáveis pelo humano (não invocáveis pelo modelo):
- `/setup-matt-pocock-skills` no fork, se o tracker ainda não estiver configurado (respostas padrão acima).
- `/to-tickets` depois de aprovar este plano — uma issue por fase, com `## Prova` preenchida.
- `/implement` por ticket; `/code-review` antes de cada merge; `/handoff` ao fim da sessão.

Invocáveis pelo modelo quando a etapa pedir: `prova-de-aceite` (obrigatória em todo ticket), `guardrail-repo` (na Fase 1, após limpar), `codebase-design` (na Fase 2, para o seam), `tdd` (Fases 3, 5, 6), `diagnosing-bugs`, `research` (API do Kapso e Marketing API).

## O que NÃO fazer

- Não editar `inbound-turn.ts` para acomodar módulo próprio. Se parecer necessário, é sinal de que o módulo está no lugar errado — parar e perguntar.
- Não aplicar migrations soltas: schema só via apêndice idempotente no `baseline.sql`, ou o `update.sh` não entrega a mudança.
- Não gravar credencial em `.env` por número: é por sessão, cifrada no banco.
- Não marcar fase como concluída com teste verde sem a prova de realidade correspondente.
- Não vender "servidor no Brasil = LGPD". O argumento defensável é: sem transferência internacional, não há exigência de cláusulas-padrão (Res. ANPD 19/2024).

## Fontes

- `mapa-deskcommcrm.md` — mapa por camada, seção 3 (Kapso) e 4 (lacunas).
- Upstream: `https://github.com/melgarafael/DeskcommCRM` — `docs/doctrine/restricao-de-canal.md`, `docs/vendaval-fusion-plan.md`, `docs/white-label.md`, `CLAUDE.md`.
- Repo atual do José: `~/CODING/newstuff/os-pequeno-negocio` — `CONTEXT.md`, `docs/adr/`, `docs/research/restricoes-verificadas.md`.
