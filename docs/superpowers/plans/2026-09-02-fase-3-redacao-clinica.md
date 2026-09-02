# Plano — Fase 3: redação de Conteúdo Clínico, aviso de IA e "não é ato médico"

Issue: #21. Spec: `docs/spec/0003-relatorio-das-8h.md` (Fronteiras → `lib/clinica/`). ADRs: 0004, 0012, 0013 e a nova 0019 (escrita nesta fase).

**Objetivo.** Em Conta de saúde: (a) texto do Contato que revele sintoma, condição ou medicação nunca é persistido — `messages.body` vira marcador, o preview da conversa e o `event_log` só veem o marcador, o RAG nunca recebe o texto; a mensagem provoca Passagem por gatilho clínico; (b) a primeira mensagem de saída de toda Conversa avisa que há IA (CFM 2.454/2026); (c) saída que pareça diagnóstico ou prescrição é detectada e vira alerta (modo observação).

**Arquitetura.** Pasta própria `lib/clinica/`, ligada por Conta em `organizations.settings.clinica`. O classificador é um **léxico determinístico em português**, síncrono, rodando **antes do insert** nos quatro ingestores — porque a ADR-0004 proíbe persistir e um modelo de linguagem não cabe antes da gravação sem segurar a mensagem em memória com um juiz que pode cair. O modelo entra como segunda opinião em fase posterior. A Passagem usa `triggerHandoff` de `lib/ai/handoff/orchestrator.ts` com motivo novo `clinical_mention`. O aviso de IA já existe como `disclosureGate` na cadeia `before_send`, por template versionado por Conta: esta fase prova que ele cobre o primeiro contato e entrega o texto do template. O "não é ato médico" é uma função pura mais um cron vigia em modo observação, porque um gate novo na cadeia exigiria contexto de Conta montado em `inbound-turn.ts`, que não se edita.

**Toques em código herdado, todos de poucas linhas e listados:** `lib/channels/meta/ingest.ts` e `lib/waha/ingest.ts` (chamada ao preparador antes do insert e no preview), `lib/ai/handoff/orchestrator.ts` (membro na união `HandoffReason`), `lib/escalacao/aviso-ao-lead.ts` (texto do motivo), `lib/schemas/settings.ts` + `app/actions/settings/updateTenant.ts` + `app/app/settings/tenant/_form.tsx` (toggle), `docker/scheduler/entrypoint.sh` (cron), `lib/rotinas/esperadas.ts`, `lib/audit/actions.ts`.

**Prova da fase** (da issue): `pnpm vitest run --config vitest.db.config.ts tests/invariants/redacao-clinica.test.ts` verde dentro de `pnpm test:db`. Como o Postgres efêmero não tem PostgREST, o invariante chama o preparador TS e grava o resultado com psql, afirmando `messages.body`, `conversations.last_message_preview`, `event_log.payload->>'body_preview'` e a ausência do texto em qualquer coluna de texto do banco. O caminho ponta a ponta pelo adapter fake com a pilha no ar fica para o `scripts/prova-agenda.ts` da Fase 4, que reusa a asserção.

**Ambiente.** `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"` antes de `pnpm`. `test:unit` com `--maxWorkers=3`. Em `tests/invariants/**`, arquivo novo; não editar os existentes.

---

## Parte A — Léxico e redação

### Tarefa 1 — O classificador de Conteúdo Clínico

**Arquivos:** novos `lib/clinica/lexico.ts`, `lib/clinica/classificar.ts`, `lib/clinica/classificar.test.ts`, `lib/clinica/corpus.ts`.

1. `corpus.ts`: dois arrays exportados, `CLINICOS` e `NAO_CLINICOS`, com pelo menos 40 frases cada, em português coloquial de WhatsApp. Clínicos: sintomas ("tô com dor de cabeça há 3 dias", "minha filha está com febre"), condições ("tenho diabetes", "sou hipertensa"), medicação ("tomo losartana 50mg", "acabou meu rivotril", "preciso de receita de fluoxetina"), pedidos clínicos ("pode me dizer se isso é grave"). Não clínicos: escolha de serviço/profissional (ADR-0012: "quero marcar com a cardiologista", "tem vaga na psiquiatria?", "quanto custa a consulta de nutrição"), logística ("qual o endereço", "aceita Unimed", "posso remarcar pra terça"), saudações, e armadilhas ("a dor de cabeça é ver o trânsito" — aceita como falso positivo consciente; listar em `AMBIGUOS`, fora das asserções).
2. `classificar.test.ts`: para cada frase de `CLINICOS`, `classificarConteudoClinico(frase).clinico === true` com `motivo` em `sintoma | condicao | medicacao`; para cada de `NAO_CLINICOS`, `false`; a função é pura e determinística; acentos e caixa não importam ("FEBRE", "febre", "fébre" via normalização NFD). Rodar — vermelho.
3. `lexico.ts`: listas por categoria (sintomas, condições, medicamentos e classes, marcadores de dose `\b\d+\s?(mg|ml|g|comprimidos?)\b`, receita/prescrição), mais padrões de forma ("dor de/no/na …", "estou com …", "tô com …", "sinto …", sufixos `-ite`, `-ose`, `-algia` em palavras com 6+ letras). Excluir explicitamente os nomes das 14 especialidades da clínica e as palavras "consulta", "exame de rotina" e "check-up": escolher não é Conteúdo Clínico.
4. `classificar.ts`: normaliza (NFD, sem diacríticos, minúsculas), casa por palavra inteira, devolve `{ clinico, motivo, termos: string[] }` — `termos` são as chaves do léxico que casaram, úteis só em memória para os testes. **Nunca persistir `termos`**: a chave que casa em "tomo losartana" é `losartana`, e gravá-la em qualquer coluna é gravar a medicação que a ADR-0004 manda descartar.
5. Verde. Commit: `feat(clinica): deterministic lexicon that recognises clinical content`.

### Tarefa 2 — O preparador que os ingestores chamam antes de gravar

**Arquivos:** novos `lib/clinica/redacao.ts`, `lib/clinica/redacao.test.ts`, `lib/clinica/config.ts`, `lib/clinica/config.test.ts`.

1. `config.ts`: `configuracaoClinica(settings: unknown): { redacao: boolean }` lendo `settings.clinica.redacao_clinica === true`; `lerConfiguracaoClinica(admin, orgId)` faz `select settings from organizations where id = …`. Teste: default falso; `true` só com a chave exata.
2. `redacao.ts`: `export const MARCADOR_CLINICO = "[conteúdo clínico redigido]"`. `prepararEntradaDoContato(admin, orgId, texto | null): Promise<EntradaPreparada>` onde `EntradaPreparada = { body: string | null; preview: string; textoParaEfeitos: string | null; redigido: { motivo, termos } | null }`. Sem `redacao` na Conta ou texto não clínico → passa tudo íntegro. Clínico → `body = MARCADOR_CLINICO`, `preview = MARCADOR_CLINICO`, `textoParaEfeitos = null` (para os follow-ups não gravarem a resposta), `redigido = { motivo }` (só a categoria; `termos` fica fora do retorno persistível). Se o `select settings` falhar, **redigir e logar** (fail-closed): errar para o lado seguro custa só UX; testar esse ramo.
3. Teste com admin falso: os três ramos; `redigido.termos` não contém o texto original; texto não clínico numa Conta de saúde fica íntegro (asserção do critério da issue).
4. Verde. Commit: `feat(clinica): prepare contact text before persistence`.

### Tarefa 3 — Os quatro ingestores passam pelo preparador

**Arquivos:** `lib/channels/fake/ingest.ts`, `lib/channels/meta/ingest.ts`, `lib/channels/meta/coexistencia/gravar.ts`, `lib/waha/ingest.ts`, novo `tests/unit/ingestores-passam-pela-redacao.test.ts`, `lib/channels/fake/ingest.test.ts`.

1. Teste estático primeiro: cada um dos quatro arquivos contém `prepararEntradaDoContato(` e, no ramo de entrada, `body:` não recebe mais `e.text`/`texto` cru (afirmar que `body: preparada.body` ou equivalente aparece). Rodar — vermelho.
2. Em cada ingestor, no caminho **inbound** e só nele: antes do insert, `const preparada = await prepararEntradaDoContato(admin, orgId, texto)`; `body: preparada.body`; preview de `fn_mark_conversation_message` = `preparada.preview` (só para texto; mídia mantém o preview de tipo); `metadata` ganha `...(preparada.redigido ? { redigido: { motivo: preparada.redigido.motivo } } : {})` — só a categoria; `aplicarEfeitosPosEntrada(..., texto: preparada.textoParaEfeitos)`. Em `gravar.ts`, aplicar só quando `direction === "inbound"` (saída da recepção não é texto do Contato); o preview da linha ~97 passa a `preparada.preview` nesse ramo — muda só o histórico importado, nunca o eco. Em `waha/ingest.ts`, o insert de entrada é o das linhas ~589-610; o de saída (~819) não muda.
3. `fake/ingest.test.ts` ganha um caso: com admin falso devolvendo `settings.clinica.redacao_clinica = true`, "tô com dor no peito" → insert com `body = MARCADOR_CLINICO`, `fn_mark_conversation_message` com preview marcador, e `aplicarEfeitosPosEntrada` chamado com `texto: null`.
4. Os admins falsos dos testes existentes de `meta/ingest`, `waha/ingest` e `zernio` não respondem `from("organizations")`; ensiná-los a devolver `settings: {}` (ramo íntegro). `pnpm test:unit --maxWorkers=3`. Commit: `feat(clinica): every inbound ingestor redacts before writing`.

## Parte B — Passagem por gatilho clínico e configuração da Conta

### Tarefa 4 — Motivo `clinical_mention` e a Passagem a partir da redação

**Arquivos:** `lib/ai/handoff/orchestrator.ts`, `lib/escalacao/aviso-ao-lead.ts`, `tests/unit/aviso-ao-lead.test.ts` (só se enumerar motivos; senão novo `tests/unit/handoff-clinico.test.ts`), novo `lib/clinica/passagem.ts`, `lib/clinica/passagem.test.ts`, `lib/channels/pos-entrada.ts`.

1. Teste: `motivoDoAviso("clinical_mention")` devolve `"outro"` — o texto de `outro` já diz que alguém da equipe assume sem dizer por quê, que é exatamente o que se quer (o teste existente faz o mesmo para `legal_mention`). `passarPorConteudoClinico({ organizationId, conversationId, contactId })` chama `triggerHandoff` com `reason: "clinical_mention"` e `metadata: { gatilho: "conteudo_clinico" }`, sem texto; `triggerHandoff` cria o próprio admin, então o teste faz `vi.mock("@/lib/ai/handoff/orchestrator")`. Rodar — vermelho.
2. `orchestrator.ts`: `| "clinical_mention"` na união, com comentário apontando ADR-0004. `aviso-ao-lead.ts` não muda (cai em `outro`).
3. `pos-entrada.ts`: `aplicarEfeitosPosEntrada` recebe opcionalmente `redigido?: { motivo } | null`; quando presente, chama `passarPorConteudoClinico` **antes** de `pedirDespachoDoAgente` e **não** pede despacho (a conversa já está em Passagem; despachar o Agente seria pedir para ele responder o que não pode ler). Os quatro ingestores passam `redigido: preparada.redigido`.
4. Teste em `lib/clinica/passagem.test.ts` cobre a ordem (handoff antes, sem dispatch). Verde. Commit: `feat(clinica): clinical content hands the conversation to a human`.

### Tarefa 5 — Toggle "Conta do setor de saúde" com superfície

**Arquivos:** `lib/schemas/settings.ts`, `app/actions/settings/updateTenant.ts`, `app/app/settings/tenant/_form.tsx`, `app/app/settings/tenant/page.tsx` (se precisar passar o valor atual), novo `tests/unit/settings-clinica-toggle.test.ts`, `lib/i18n/dicionario.ts`.

1. Teste: `tenantSchema` aceita `clinica_redacao: boolean` (default `false`); `updateTenant` mescla `settings.clinica.redacao_clinica` sem apagar outras chaves (mock do admin como em testes existentes de `updateTenant`, se houver; senão, testar só o schema e a função pura de merge, extraída para `lib/clinica/config.ts` como `aplicarConfiguracaoClinica(settings, { redacao })`).
2. Formulário: um checkbox "Conta do setor de saúde — redigir Conteúdo Clínico e passar para humano (ADR-0004)" ao lado de `dpo_email` no `Card` único de `_form.tsx`; `page.tsx` passa `settings.clinica.redacao_clinica` ao estado inicial. Texto em `useT()` + chave em espanhol no dicionário.
3. `pnpm vitest run tests/unit/i18n-espanhol-cobre-a-tela tests/unit/settings-clinica-toggle`. Commit: `feat(settings): health-sector toggle turns clinical redaction on per account`.

## Parte C — Aviso de IA e "não é ato médico"

### Tarefa 6 — O aviso de IA cobre o primeiro contato

**Arquivos:** novos `lib/clinica/aviso-de-ia.ts`, `lib/clinica/aviso-de-ia.test.ts`, `scripts/clinica/instalar-aviso-de-ia.ts`.

1. Teste: `TEXTO_DO_AVISO_CFM` contém "assistente virtual" e "inteligência artificial" e cabe em 160 caracteres; `disclosureGate.evaluate` com `ctx.disclosure = { template: TEXTO_DO_AVISO_CFM, isFirstOutbound: true, mode: "inject" }` devolve `amendBody` começando pelo aviso; com `isFirstOutbound: false` passa sem emendar; corpo que já contém o aviso passa sem duplicar. Isto é a prova de que o mecanismo herdado cobre o **primeiro contato**, não só o handoff (critério da issue). Rodar — vermelho (módulo ausente).
2. `aviso-de-ia.ts`: o texto e `instalarAvisoDeIa(db: Queryable, tenantId)` que chama `insertDisclosureTemplateVersion` + `setDisclosureTemplatePointer`. `scripts/clinica/instalar-aviso-de-ia.ts <org_id>` para o Embarque (Fase 4), lendo `SUPABASE_DB_URL`.
3. Verde. Commit: `feat(clinica): the CFM disclosure is the first thing the agent says`.

### Tarefa 7 — "Não é ato médico": função pura e vigia em observação

**Arquivos:** novos `lib/clinica/ato-medico.ts`, `lib/clinica/ato-medico.test.ts`, `lib/clinica/vigia.ts`, `lib/clinica/vigia.test.ts`, `app/api/v1/cron/clinica-vigia/route.ts`; `docker/scheduler/entrypoint.sh`, `lib/rotinas/esperadas.ts`, `lib/audit/actions.ts`.

1. Teste de `pareceAtoMedico(texto)`: verdadeiro para "você deve tomar 1 comprimido de 8 em 8 horas", "isso parece uma infecção", "pode ser gastrite", "aumenta a dose"; falso para "a consulta com o cardiologista é às 14h", "traga seus exames", "o valor da consulta é R$ 200". Rodar — vermelho.
2. `ato-medico.ts`: padrões de prescrição (verbo + dose/frequência), diagnóstico ("parece", "pode ser", "você tem" + termo do léxico clínico da Tarefa 1), orientação terapêutica ("suspenda", "aumente a dose"). Reusa `lib/clinica/lexico.ts`.
3. `vigia.test.ts` (admin falso): para Contas com `redacao` ligada, lê `messages` com `direction = 'outbound' and sent_via = 'ai' and created_at > now() - interval '1 hour'` (a autoria do Agente é `sent_via = 'ai'`, CHECK no baseline), aplica `pareceAtoMedico`, e para cada acerto insere `agent_inbox_items` com `kind: "other"`, `severity` alta, título "Possível ato médico na resposta do Agente" e `ref_kind: "message"`, e audit `clinica.ato_medico_suspeito` com `metadata: { message_id }` — **sem o texto**. Dedup por `ref_id`. Rodar — vermelho.
4. Rota `clinica-vigia` (auth de cron + `comExecucaoDeRotina`), linha `23 * * * *|60|api/v1/cron/clinica-vigia` em `CRONS`, entrada em `ROTINAS_ESPERADAS` (60), ação no audit.
5. `pnpm vitest run lib/clinica tests/unit/cron-routes-scheduled tests/unit/cron-routes-registram-execucao lib/rotinas/esperadas`. `pnpm test:shell`. Commit: `feat(clinica): an hourly watcher flags replies that look like medical acts`.

## Parte D — ADR, invariante e gates

### Tarefa 8 — ADR-0019

**Arquivo:** novo `docs/adr/0019-conteudo-clinico-e-reconhecido-por-lexico-antes-de-gravar.md`.

Decisão: classificador determinístico antes do insert, em vez de modelo; marcador no lugar do texto; `event_log`, preview e RAG herdam o marcador porque leem `body`; Passagem por `clinical_mention`; "não é ato médico" em observação por cron. Consequências: falsos positivos aceitos (mensagem íntegra vira marcador e cai para humano — custo assumido; o humano vê a mensagem no app pela Coexistência); falsos negativos residuais (léxico incompleto) mitigados pelo modelo como segunda opinião em fase posterior; **transcrição de áudio (`media_derived_text`) ainda não passa pelo preparador** — risco aberto, registrado; hoje a coluna existe e é lida pelo contexto do lead, mas nenhum código em `lib/` ou `app/` a preenche. Commit: `docs(adr): 0019 clinical content is recognised by lexicon before it is written`.

### Tarefa 9 — Invariante da prova

**Arquivo:** novo `tests/invariants/redacao-clinica.test.ts`.

1. Seed por psql (padrão de `rls-isolation.test.ts`): org com `settings = '{"clinica":{"redacao_clinica":true}}'`, sessão `fake_channel`, contato, conversa.
2. Chamar `prepararEntradaDoContato` com um admin **mínimo** que implementa só `from("organizations").select("settings").eq().maybeSingle()` devolvendo o `settings` lido por psql (é o único acesso do preparador) e o texto "tô com dor no peito e tomo losartana 50mg".
3. Inserir por psql a mensagem com `body = preparada.body`, chamar `fn_mark_conversation_message` com `preparada.preview`.
4. Afirmar por SQL: `messages.body = '[conteúdo clínico redigido]'`; `conversations.last_message_preview` idem; `event_log` da mensagem tem `payload->>'body_preview'` igual ao marcador; e uma varredura por `'%losartana%'` e `'%dor no peito%'` em `messages.body`, `messages.metadata::text`, `conversations.last_message_preview`, `event_log.payload::text`, `followup_enrollments::text`, `agent_inbox_items.body` e `api_audit_log.metadata::text` devolve zero.
5. Controle negativo: "quero marcar com a cardiologista" na mesma Conta fica íntegro em `body` e no preview.
6. `ai_chunks`: `count(*) where organization_id = org` = 0 (`buildTranscript` não é exportado; só a contagem).
7. **Aviso de IA no banco** (terceiro critério da prova): com `pg.Pool` do efêmero, `instalarAvisoDeIa(pool, org)`, depois `loadDisclosureTemplate(pool, org)` devolve o texto CFM, e `disclosureGate.evaluate({ ...ctx mínimo, disclosure: { template, isFirstOutbound: true, mode: "inject" } })` devolve `amendBody` começando pelo aviso.
8. `pnpm test:db` completo (Docker), rodapé lido. Commit: `test(db): clinical text never lands anywhere in the database`.

### Tarefa 10 — Gates, prova e issue

1. `pnpm typecheck && pnpm lint && pnpm lint:channels && pnpm test:unit --maxWorkers=3 && pnpm test:shell && pnpm build && pnpm test:db`, cada um em arquivo; ler rodapés.
2. Rodar a prova da issue e colar o rodapé em #21. PR para `main` com `Closes #21`; dizer no corpo que `lib/clinica/` substitui o `lib/ai/anonymize/` e o `lista-de-conferencia.ts` que a issue original citava (a Spec 0003 já moveu tudo para `lib/clinica/`) (não há HITL nesta fase; a prova de realidade com paciente real é a da Fase 4).

## O que este plano não faz

Não usa modelo de linguagem para classificar (fase posterior, como segunda opinião). Não redige `media_derived_text` (transcrição de áudio) — registrado na ADR como risco aberto e como chip. Não cria gate novo na cadeia `before_send` (exigiria contexto montado em `inbound-turn.ts`). Não toca no RAG: ele lê `body`, que já chega redigido.

---

## Desvios registrados na execução (02/09/2026)

- **Cinco ingestores, não quatro.** O plano esqueceu `lib/channels/zernio/ingest.ts` (o adapter do parceiro que é a ponte da ADR-0015). Entrou no teste estático e no preparador; `insertMessage` ganhou o campo explícito `body`.
- **`redigido.termos` nunca persiste** (achado do revisor): `metadata.redigido` guarda só `{ motivo }`. A varredura do invariante cobre `messages.metadata`, `agent_inbox_items.body` e `api_audit_log.metadata`.
- **O invariante prova o aviso de IA contra o Postgres efêmero** (`instalarAvisoDeIa` + `loadDisclosureTemplate` + `disclosureGate.evaluate`), cumprindo o terceiro critério da `## Prova` da issue.
- **`instalarAvisoDeIa` recebe `pg.Pool`**, não `Queryable`: as funções herdadas de template pedem `Pool`.
- **`Switch` em vez de checkbox** no formulário da Conta: não existe `components/ui/checkbox.tsx`.
- **`severity: "critical"`** no item do vigia: o CHECK do baseline não aceita `high`.
- **Fail-closed testado:** falha ao ler `organizations.settings` redige e registra.
- **`aviso-ao-lead.ts` não mudou:** `clinical_mention` cai em `outro`, que já não diz o motivo.
- **Sem migration nesta fase.** `agent_inbox_items.kind` já aceita `other` e `ref_kind` não tem CHECK.
