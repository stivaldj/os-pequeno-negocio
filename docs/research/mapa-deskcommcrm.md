# DeskcommCRM — mapa de aproveitamento para o os-pequeno-negocio

Base: clone de `melgarafael/DeskcommCRM@main` em 01/09/2026. Números medidos no código, não lidos do README.

## 1. Raio-X em números

| Área | LOC | Situação |
|---|---|---|
| `lib/agent-engine/` | 23.378 | Cérebro rico (worker 24/7). Vivo. |
| `lib/followup/` | 14.472 | Follow-up vivo, enrollments, fila com rodízio. Vivo. |
| `lib/ai/` | 12.912 | RAG, credenciais, orçamento, evolução, skills. Vivo — com um motor antigo residual. |
| `lib/channels/` | 7.850 | Seam de canal: WAHA, Meta Cloud, Zernio (BSP). Vivo. |
| `lib/mcp/` | 6.078 | 60 ferramentas `crm_*`. Vivo. |
| `lib/waha/` | 3.011 | Transporte QR. Vivo, mas marcado pra ser absorvido por `lib/channels/`. |
| `lib/automation/` + `lib/webhooks/` | 3.975 | Captação + QUANDO/SE/ENTÃO. Vivo. |
| `lib/lgpd/` | 2.065 | Export/redact via workers. Vivo. |
| `workers/` | 4.314 | 8 workers + agent-worker. Vivo. |
| `app/api/v1/` | 42.261 | 223 route handlers. |
| `components/` | 27.084 | UI shadcn. |
| `supabase/baseline.sql` | 17.190 | 118 tabelas. **Única fonte de schema** — as 186 migrations são parcialmente stubs. |
| Testes | 597 em `tests/` + 133 co-locados | CI com invariante de isolamento RLS como gate. |

Compose de produção: `app`, `worker`, `scheduler`, `waha`, `redis`, `srh` (Upstash-compatível), `caddy`. Um host, `docker compose up`.

Dependências centrais: `ai@7`, `@ai-sdk/{anthropic,openai,google}@4`, `@modelcontextprotocol/sdk@1.30`, `next@16.3`, `react@19.2`, `zod@4`, `@supabase/supabase-js@2.112`, `pg@8`.

## 2. Camada por camada

### 2.1 `lib/channels/` — APROVEITA INTEGRAL

É o seu ADR de transporte trocável já implementado, com lint.

- `types.ts` define `ChannelAdapter`: `resolveRecipient`, `isConfigured`, `send`, `codes`, e opcionais `fetchProfilePictureUrl`, `echoExternalIds`, `resolvePhoneForIdentity`, `templates`, `checkHealth`, `fetchInboundMedia`, `sendTemplate`.
- `ChannelCapabilities` declara por canal: `freeformOutsideWindow`, `requiresTemplates`, `canManageTemplates`, `banRisk`, `minIntervalMs`, `voiceNote`, `groups`, `costPerMessage`. A UI e a cadeia `before_send` perguntam a capability, nunca o provider.
- `index.ts`: registry fail-closed (`getAdapter` lança pra provider desconhecido — nunca cai no WAHA por default).
- `inbound.ts`: rota genérica `/api/v1/webhooks/channel/[token]` entrega sessão + corpo cru + headers; a verificação de assinatura e o parse moram dentro do seam por canal.
- `ChannelTenantScope.organizationId` obrigatório em todo envelope — fecha o bug de credencial de org errada (issue #236 deles).
- Credencial por sessão, cifrada no banco (migration 0118) — não por `.env`. **Isso é o que permite 50 números de clientes diferentes numa conta Kapso só.**
- `scripts/lint-channels.ts`: catraca — arquivo novo que nomeia provider fora de `lib/channels/` reprova no CI. Lista de dívida só encolhe.

Doutrina em `docs/doctrine/restricao-de-canal.md`, 4 invariantes verificáveis. Adapter é tradutor de formato; janela de 24h, cap, horário, throttle vivem na cadeia `before_send`.

### 2.2 `lib/waha/` — APROVEITA SÓ SE USAR QR

3k LOC de ingest, envelope, client, media, dedup de eco. `DEFAULT_CHANNEL_PROVIDER = "waha"` e a coluna `channel_sessions.provider` tem `default 'waha'`. Pra Clínica Humana com Kapso você não usa, mas não remove: 10 arquivos fora do seam ainda leem `WAHA_API_*` (a dívida que o lint rastreia). Remover é a "Fase 3" que eles mesmos ainda não fizeram.

Atenção: o compose sobe `devlikeapro/waha:latest-2026.7.2`; multi-número exige WAHA Plus (licença paga).

### 2.3 `lib/agent-engine/` — APROVEITA, COM UMA RESSALVA

Veio de um projeto anterior do autor ("Vendaval") que falhou por validar só contra mocks; a fusão foi feita com a regra "prova de realidade a cada fase" (`docs/vendaval-fusion-plan.md`).

O que tem:
- `agent/inbound-turn.ts` — o turno principal. **12 tools**: `get_lead_context`, `send_template`, `search_knowledge`, `send_message`, `update_lead_state`, `save_lead_note`, `get_lead_note`, `request_human_handoff`, `schedule_followup`, `read_skill_reference`, `open_human_case`, `provide_case_update`.
- `agent/followup-turn.ts`, `case-reply-turn.ts`, `operator-turn.ts` — turnos distintos por situação.
- `agent/declaracao.ts` — separação FALAR × OPERAR (spec 16): o conversador termina o turno declarando em linguagem de negócio o que a pessoa quer e o que foi prometido; outra camada traduz em operação. Medido: 30% de vazamento de vocabulário de ferramenta sem isso.
- `pacing/` — anti-ban (throttle, jitter, janela), com `pacing_ledger` e `send_ledger`.
- `agent/human-handoff.ts`, `human-cases.ts` — handoff auditado, casos humanos com inbox (`agent_cases`, `agent_inbox_items`).
- `agent/org-memory.ts`, `skills.ts`, `playbook.ts` — memória versionada, skills instaláveis, playbook por org.
- `flywheel/` — conversas resolvidas viram proposta de melhoria com gate humano (`flywheel_distiller_proposals`, `flywheel_judge_verdicts`).
- `edge/llm/` — `run-model-call`, `pricing`, `orcamento`, `count-tokens`, `stable-prefix` (cache de prompt).
- `cron/scheduler.ts`, `edge/crm/drain.ts`, `session-watchdog.ts`.

Ressalva: `inbound-turn.ts` tem **3.243 linhas num arquivo só**. Funciona, é testado, mas é o ponto onde qualquer customização sua vai doer. Se forkar, o primeiro refactor é quebrar esse arquivo por responsabilidade antes de tocar em qualquer tool.

### 2.4 `lib/ai/` — APROVEITA, DECIDINDO O MOTOR ANTIGO

- `rag/` — chunker, extractors (pdf, markdown), ingest de documento/FAQ/política/conversas, versionamento. Tabelas `ai_chunks` (pgvector), `ai_knowledge_sources`, `ai_knowledge_versions`.
- `credentials/`, `pontos/`, `gateway-binding.ts` — provedor por "ponto" do sistema (quem conversa ≠ quem indexa), trocável pela tela.
- `budget/check.ts` + `ai_budgets`, `ai_pricing`, `usage/aggregate.ts` — teto por org e tela de uso. **Base pronta pra você cobrar tokens com markup.**
- `evolution/aggregate.ts` — tela Evolução da IA.
- `anonymize/` — anonimização PT-BR (nomes) **só na ingestão de RAG**, não nas mensagens.
- `runtime/agent.ts` (702 LOC) + `runtime/tools.ts` — **motor antigo**, marcado "a ser substituído" no plano de fusão, mas ainda referenciado por `app/actions/onboarding/createDefaultAgent.ts`, `montarQuadro.ts`, a rota de teste de versão e `app/api/internal/agents/run`. Dois cérebros no repo. Num fork: decidir e apagar um.

### 2.5 `lib/mcp/` — APROVEITA COMO SUPERFÍCIE DO "AGENTE GESTOR"

60 ferramentas `crm_*` sobre `@modelcontextprotocol/sdk`, com auth (`auth.ts`), audit (`audit.ts`) e recusa legível pro modelo. Cobrem: leads, estágios, conversas, mensagens, templates, handoff, casos humanos, follow-up, memória, conhecimento, produtos/pedidos, agendamento (7 tools), automações, webhooks, privacidade, evolução, fila e time.

É exatamente a interface pelo qual o seu agente de ads/financeiro operaria o CRM sem acoplar ao schema.

### 2.6 `lib/agenda/` — APROVEITA. É O PEDAÇO QUE A CLÍNICA HUMANA PRECISA

Google Calendar via OAuth próprio (`platform_google_oauth`, `calendar_connections`, `calendar_connection_calendars`), `horarios-livres.ts`, `ocupados.ts`, `jornada.ts`, `calendar_appointments`, `calendar_availability_exceptions`, `calendar_event_types`, crons de sync/push/refresh. MCP: `crm_find_free_slots`, `crm_book_appointment`, `crm_reschedule_appointment`, `crm_cancel_appointment`, `crm_confirm_appointment`, `crm_set_appointment_outcome`, `crm_list_appointments`.

Você tinha isso como "a construir". Está pronto.

### 2.7 `lib/followup/`, `lib/automation/`, `lib/webhooks/`, `lib/routing/`, `lib/lgpd/` — APROVEITA

Follow-up com tempo adaptativo e gatilhos por etapa; regras QUANDO/SE/ENTÃO drenadas de `event_log` por cron (trigger de banco nunca faz HTTP); fontes de captação com token público; roteador de intenção por número (`ai_routers`, `ai_router_decisions`); export/redact LGPD com anonimização em cascata.

### 2.8 `lib/nuvemshop/` + tabelas `orders`, `nuvemshop_products` — IGNORA PARA CLÍNICA, MAS OLHA `orders`

`orders` é a tabela de "venda confirmada". No seu desenho, o retorno sobre anúncio precisa de confirmação de venda pelo dono via WhatsApp — `orders` é a coluna onde isso pousa, com ou sem Nuvemshop.

### 2.9 `lib/leads/atribuicao-de-anuncio.ts` — APROVEITA. É A SEMENTE DO SEU MÓDULO DE ADS

Captura `ctwa_clid` (clique em anúncio click-to-WhatsApp da Meta), título, corpo e URL, e grava no contato. Extrator por transporte (Meta oficial e QR). **Google Ads não existe** — depende de LP com `gclid` embutido na mensagem pré-preenchida, e essa LP não existe.

O que falta pro "retorno por real investido": Meta Marketing API (gasto por campanha), margem declarada por produto, e o join `ctwa_clid → crm_leads won / orders`. Nada disso está no repo.

### 2.10 `hostgator-setup-kit/` — APROVEITA PARA INSTÂNCIA DEDICADA

`install.sh` idempotente, `update.sh` com backup, `restore.sh`, `healthcheck.sh`, `reset-mfa.sh`, `marca-emails.sh`. Detecta proxy próprio (Hostinger, Coolify, Dokploy). Marca por instalação e por organização pela tela. Uma VPS por cliente = um `install.sh`.

### 2.11 JOGA FORA NUM FORK

| Pasta | Tamanho | Motivo |
|---|---|---|
| `evidence/` | 43 MB | Screenshots de QA visual do autor. |
| `docs/` | 9,8 MB | 157 docs — manter `doctrine/`, `specs/`, `runbooks/`, `white-label.md`, `SETUP.md`; o resto é histórico. |
| `loop/`, `plan/`, `triagem/`, `tasks/`, `.specs/` | ~1,3 MB | Harness de execução do autor com agentes. |
| `HANDOFF*.md` (11 arquivos na raiz) | — | Handoffs entre sessões dele. |
| `.claude/`, `.codex/`, `.agents/` | — | Instruções de agente do autor. Substituir pelas suas. |
| `lib/ai/runtime/agent.ts` | 702 LOC | Motor antigo (ver 2.4). |

## 3. Onde o Kapso plugaria

Kapso é Tech Provider sobre a Cloud API da Meta — o adapter mais próximo é o `meta-cloud`, não o `zernio` (Zernio endereça por id de thread próprio; Kapso endereça por telefone e devolve `wamid` da Meta, como a Cloud API).

Arquivos a criar, seguindo a família existente:

```
lib/channels/adapters/kapso.ts          # ChannelAdapter — copia a forma do meta-cloud
lib/channels/kapso/credentials.ts       # por sessão, cifrada no banco (padrão 0118), com lookup por organization_id
lib/channels/kapso/envelope.ts          # payload Kapso → envelope neutro
lib/channels/kapso/ingest.ts            # envelope → contacts/conversations/messages
lib/channels/kapso/webhook.ts           # verificação de assinatura do Kapso
lib/channels/kapso/templates.ts         # ChannelTemplateOps, se a API do Kapso expuser CRUD de template
lib/channels/kapso/atribuicao-de-anuncio.ts  # extrairAtribuicao do `referral` (passthrough da Cloud API)
```

Alterações em arquivos existentes:

1. `lib/channels/types.ts` — `ChannelProvider = "waha" | "meta_cloud" | "zernio" | "kapso"`.
2. `lib/channels/capabilities.ts` — entrada `kapso`: `freeformOutsideWindow: false`, `requiresTemplates: true`, `canManageTemplates` conforme a API, `banRisk: false`, `minIntervalMs: null`, `voiceNote: "opus-only"`, `groups: "none"`, `costPerMessage: true`. Mais `CHANNEL_PROVIDER_KAPSO`.
3. `lib/channels/index.ts` — registrar no `ADAPTERS`.
4. `lib/channels/inbound.ts` — `acceptsInboundWebhook` devolve `true` para kapso; `case` no `handleInboundWebhook`. Zero linhas na rota.
5. `supabase/baseline.sql` — o `check` de `channel_sessions.provider` (se houver) ganha `'kapso'`. Apêndice idempotente no baseline, não migration solta.
6. `scripts/lint-channels.ts` — `kapso` na lista de nomes proibidos fora do seam.
7. Tela de Conexões — opção "Kapso" com validação de credencial na hora (padrão BYO do invariante 6 da doutrina).

Estimativa pelo tamanho das famílias existentes: Zernio tem 2.049 LOC, Meta 2.385 LOC. Kapso fica entre 1.500 e 2.000 LOC com testes, porque herda o vocabulário da Cloud API.

O adaptador fake para teste local que você pediu em 29/08 é **mais um `ChannelAdapter`** (`provider: "fake"`), registrado só em dev. O seu ADR de transporte trocável é preservado sem uma linha de arquitetura nova.

Multi-cliente na conta Kapso: uma linha em `channel_sessions` por número, cada uma com `organization_id` do cliente e credencial cifrada própria. Isolamento por RLS já testado no CI.

## 4. O que o repo NÃO tem e é seu módulo proprietário

| Capacidade da frase de destino | No repo | Falta |
|---|---|---|
| Agente atende, qualifica, vende, agenda | Sim (agent-engine + agenda) | Persona/playbook por nicho |
| CRM preenchido sozinho | Sim (`update_lead_state`, `declaracao`) | — |
| Relatório das 8h no WhatsApp do dono | Cron + `send_message` + `metrics` existem | O conteúdo do relatório e o destinatário "dono" |
| Gasto e retorno de anúncios | `ctwa_clid` no contato, `orders` | Meta Marketing API, margem por produto, join clique→venda, Google Ads |
| Fluxo de caixa, contas a pagar/receber, lembretes | **Zero** | Importação OFX, lançamentos, vencimentos, lembrete via agente |
| Retorno por real investido | Zero | Cálculo sobre os dois acima |
| Painel web do dono | Existe (Desempenho, Evolução, Uso) | Painel financeiro e de ads |

Restrições da Clínica Humana contra o código:
- **Agente não persiste conteúdo clínico** — `messages.body` guarda tudo, cru. Não existe política de redação na ingestão; `lib/ai/anonymize/` só atua no RAG. Precisa de um passo em `ingest` que substitua o corpo por marcador quando o roteador classificar como clínico, guardando só quem/quando/qual profissional. Trabalho seu.
- **Aviso de IA ao paciente (CFM 2.454/2026)** — existe `lib/ai/handoff/aviso-ao-lead.ts` e `disclosure_template_versions`; conferir se cobre "há IA nesta conversa" no primeiro contato ou só no handoff.
- **Sem triagem clínica** — `intent-classifier` e `stage-classifier` classificam intenção comercial; a fronteira "não é ato médico" é prompt e guardrail seus (`lib/ai/guardrails/lista-de-conferencia.ts` é o lugar).

## 5. Fork × referência — com os números na mão

| | Fork | Referência (repo próprio) |
|---|---|---|
| Camada de atendimento/CRM/agenda/follow-up | Pronta, ~85k LOC testados | Reescrever do zero |
| Kapso | 1,5–2k LOC num seam pronto | Seam também do zero |
| Tempo até Clínica Humana em produção | Semanas | Meses |
| Bus factor | Herda 1 mantenedor; você vira o segundo | Zero dependência |
| Schema | Baseline de 17k linhas, 118 tabelas, migrations parciais | Seu, enxuto |
| Customização profunda | Dói em `inbound-turn.ts` (3.2k linhas) | Livre |
| Upstream | Rebase contra `main` ativa (~3k commits) | Nenhum |
| Seu diferencial (ads/financeiro) | Módulo em cima, via MCP + `event_log` | Idem |

Leitura: o repo entrega o que você já decidiu construir, na stack que você já decidiu, com o seam de canal que você já desenhou em ADR. O custo real do fork não é técnico — é assumir um schema de 118 tabelas que você não escreveu e um mantenedor que pode parar. Referência custa meses de reconstrução de algo que existe e é testado.

Se for fork, três regras de higiene desde o primeiro commit: (1) apagar o ruído da seção 2.11 e escrever seu próprio `CLAUDE.md`; (2) escolher um motor e apagar `lib/ai/runtime/agent.ts`; (3) todo módulo seu (ads, financeiro, redação clínica) entra como pasta própria em `lib/` e worker próprio, falando com o CRM via MCP e `event_log` — nunca editando `inbound-turn.ts`. Assim o rebase contra upstream continua possível.

## 6. Ordem de ataque sugerida (se fork)

1. Fork + limpeza + `install.sh` numa VPS de teste com WAHA QR (prova de realidade do repo como está).
2. Adapter Kapso + adapter fake (seção 3). Prova: mensagem real entrando e saindo pelo número da clínica.
3. Redação clínica na ingestão + conferir aviso de IA (seção 4).
4. Playbook e agenda da Clínica Humana. Prova: paciente agenda pelo WhatsApp e cai no Google Calendar.
5. Só depois: módulo de ads (Marketing API + join `ctwa_clid`) e módulo financeiro (OFX).
6. Relatório das 8h como consumidor dos dois módulos.
