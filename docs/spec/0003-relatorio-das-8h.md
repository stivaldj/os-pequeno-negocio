# Spec 0003 — O Relatório das 8h para a Clínica Humana

Escrita em 01/09/2026, sobre o fork do DeskcommCRM (Fase 1 concluída no PR #27). Vocabulário conforme `CONTEXT.md`; decisões e seus porquês em `docs/adr/`.

> **Esta spec substitui a Spec 0002.** A 0002 foi escrita para um repo vazio e descrevia um `core` próprio, agenda sem calendário externo e ausência de rotinas. O fork já entrega atendimento, CRM, agenda com Google Calendar e scheduler. O alvo passa a ser a frase de destino inteira do README, para uma Conta: a Clínica Humana. A Spec 0001 continua sendo o destino da v1.

## Problem Statement

A Clínica Humana perde paciente porque ninguém responde o WhatsApp fora do Expediente, e paga anúncio no Google sem saber quanto sobra por real investido. Hoje o Dono opera o Google Ads sozinho, com o botão de WhatsApp nativo do Google, que só entrega conversão agregada por campanha: não há como saber qual conversa veio de qual clique, nem qual clique virou consulta paga.

O ramo acrescenta duas restrições. O paciente escreve sintoma e medicação, e guardar isso coloca a clínica no regime de dado sensível de saúde. E o Número da clínica é fixo, já registrado no app do WhatsApp Business da recepção: migrá-lo para a API apaga o histórico e tira o app da mão de quem atende.

O que existe hoje no fork resolve o atendimento, a agenda e a Passagem. Não resolve: transporte oficial com Coexistência, redação de Conteúdo Clínico, atribuição de anúncio do Google, gasto de anúncio, receita por consulta, caixa, e o Relatório Diário.

## Solution

Um Agente no Número da clínica, conectado por Coexistência via Embedded Signup da Meta com a LAVRA como Tech Provider (ADR-0015), atende a qualquer hora, agenda com Profissional e horário, e para nos cinco Gatilhos de Passagem. Conteúdo Clínico é reconhecido, provoca Passagem e nunca é gravado (ADR-0004, ADR-0012).

O anúncio do Google aponta para uma Página de Captura própria, que guarda o clique, gera um Código de Clique e abre o WhatsApp com o código pré-preenchido. O webhook lê o código na primeira mensagem e carimba campanha e clique no Contato (ADR-0016). O Agente agenda; a recepção marca na tela do dia que o paciente compareceu e quanto pagou — isso é a Venda Confirmada (ADR-0017). Com Verba lida da API do Google e Margem Declarada por serviço, o sistema calcula Sobra por Real por campanha e devolve a consulta paga ao Google como conversão offline.

Um Agente de Anúncios roda todo dia, raciocina sobre gasto, conversas, agendamentos e consultas pagas, e age no Google Ads dentro de um Nível de Autonomia que o Dono liga por Conta — começando por observar e propor (ADR-0018).

O Extrato entra por OFX e alimenta caixa, Contas a Pagar e a Receber e Lembretes. Às 8h, o Relatório Diário chega no WhatsApp do Dono, montado a partir do que os módulos já calcularam. Toda rotina grava Execução de Rotina; a ausência dela vira alerta (ADR-0007, emendada).

## User Stories

As histórias 1 a 35 da Spec 0002 (Contato, Dono, Plantonista, Operador) continuam valendo e não são repetidas. Acrescentam-se:

### Dono

36. Como Dono, quero receber às 8h no meu WhatsApp o que o Agente atendeu e agendou, o que foi passado para humano, a Verba e a Sobra por Real de ontem, o caixa e o que vence hoje, para decidir sem abrir painel.
37. Como Dono, quero cadastrar preço e Margem Declarada de cada serviço, para que Sobra por Real seja calculada com o meu número, não com uma estimativa.
38. Como Dono, quero saber quanto cada campanha do Google me devolve por real, para decidir onde escalar.
39. Como Dono, quero que o Agente de Anúncios só proponha até eu liberar mais, e quero liberar por etapas, para nunca ser surpreendido por um gasto.
40. Como Dono, quero receber as propostas do Agente de Anúncios pelo WhatsApp e responder sim ou não, para não precisar abrir o Google Ads.
41. Como Dono, quero importar o extrato do banco e ver caixa e vencimentos, para o relatório das 8h falar de dinheiro real.
42. Como Dono, quero ser avisado quando uma rotina não rodou, para que o silêncio nunca pareça normalidade.

### Recepção (Plantonista)

43. Como recepção, quero marcar na agenda do dia que o paciente compareceu e quanto pagou, para a clínica ter receita por consulta sem planilha.
44. Como recepção, quero continuar usando o app do WhatsApp no telefone da clínica, para não perder o histórico nem a rotina.

### Contato

45. Como Contato que clicou num anúncio, quero abrir o WhatsApp já com a mensagem pronta e ser atendido sem repetir de onde vim, para não sentir o rastreamento.

### Operador

46. Como operador, quero conectar o Número da clínica pelo Embedded Signup em Coexistência, sem apagar a conta do app, para o Embarque não destruir nada.
47. Como operador, quero que módulo próprio nunca toque no turno do Agente herdado, para que o upstream continue absorvível.
48. Como operador, quero ver cada ação do Agente de Anúncios no audit, com o nível de autonomia em vigor, para responder por ela.

## Implementation Decisions

### Fronteiras

Módulo próprio é pasta própria em `lib/` com worker ou cron próprio, falando com o CRM herdado por MCP (`lib/mcp/`) e `event_log`. Nenhum módulo edita `lib/agent-engine/agent/inbound-turn.ts`. Schema entra como apêndice idempotente no `baseline.sql`, mais migration e MANIFEST.

- `lib/rotinas/` — tabela `job_runs` (Execução de Rotina) e o alerta de "não rodou desde X". Todo cron novo registra início, fim e resultado. Substitui o Inngest previsto na ADR-0007.
- `lib/channels/adapters/fake.ts` — adapter em memória, registrado só fora de produção, com `externalId` determinístico. É por ele que os testes e provas locais correm.
- `lib/channels/meta/` — ganha Embedded Signup com session logging, o fluxo de onboarding de usuário do app (Coexistência) e os webhooks `smb_message_echoes`, `smb_app_state_sync` e `history`. Provider continua `meta_cloud`; nenhum `if (provider ===)` fora do seam.
- `lib/clinica/` — redação de Conteúdo Clínico na ingestão (corpo substituído por marcador, original descartado antes do `event_log` e do RAG), aviso de IA no primeiro turno via playbook, guardrail "não é ato médico". Ligado por Conta.
- `lib/ads/` — Página de Captura (`app/ir/[slug]`), tabela `ad_clicks` (código, gclid, campanha, criado em, consumido em), extrator do Código de Clique na primeira mensagem, sincronização diária de gasto por campanha (`ad_spend`), catálogo de preço e Margem Declarada por serviço (`service_pricing`, chaveado em `calendar_event_types`), cálculo de Sobra por Real, upload de conversão offline, e o Agente de Anúncios.
- `lib/financeiro/` — parser OFX, `ledger_entries`, categorias, `payables`/`receivables`, Lembrete ao Dono via `crm_send_whatsapp_message`.
- `lib/relatorio/` — monta o Relatório Diário lendo os módulos acima e a agenda; envia por Modelo Aprovado ao Dono. Consome; nunca calcula.

### Transporte

Caminho principal: LAVRA vira Tech Provider da Meta (verificação de empresa mais App Review para `whatsapp_business_messaging` e `whatsapp_business_management`), e o Número entra por Embedded Signup em Coexistência. A papelada começa no dia um da Fase 2 e corre em paralelo ao código. Se a aprovação chegar depois da Fase 4 estar pronta, a clínica entra por um parceiro que já ofereça Coexistência (Kapso ou Zernio, cujo adapter já existe) como ponte, sem mudar nada fora de `lib/channels/`. WAHA por QR fica só para número de teste; nunca no Número da clínica (ADR-0005).

Duas superfícies escrevem no mesmo Número (ADR-0014). Resposta enviada pelo app chega como eco e é gravada na Conversa como mensagem humana; o Agente não responde por cima de uma Conversa em que o app respondeu nos últimos minutos. O intervalo é configuração da Conta.

### O dinheiro

- **Atribuição.** O anúncio aponta para `/ir/<slug>` no domínio da LAVRA ou da clínica. A página grava gclid, campanha e um Código de Clique curto, e redireciona para `wa.me/<numero>?text=<frase com o código>`. O ingest reconhece o código na primeira mensagem do Contato, marca o clique como consumido e estampa a atribuição com o mecanismo herdado (`fn_estampar_atribuicao_de_anuncio`, plataforma `google_ads`). Sem código, o Contato entra sem atribuição; nunca bloqueia.
- **Receita.** A tela do dia da agenda ganha, no "compareceu", o valor pago. Isso grava `paid_cents` no Agendamento e cria a Venda Confirmada. Cartão, convênio e dinheiro entram pelo valor digitado; o Extrato não é fonte de receita por paciente.
- **Sobra por Real** de uma campanha num período = soma de (pago × Margem Declarada do serviço) dos Agendamentos de Contatos atribuídos à campanha, dividida pela Verba da campanha no período. Verba vem de `GoogleAdsService.SearchStream` com `metrics.cost_micros` por campanha e dia. Dia sem gasto lido é marcado como incompleto, não como zero.
- **Conversão offline.** Consulta paga com gclid é enviada ao Google por `UPLOAD_CLICKS`, com valor, para o lance automático. Nunca se envia lista de pacientes como público: saúde é categoria sensível na política do Google.

### O Agente de Anúncios

Worker diário em `lib/ads/agente/`, usando a API da Claude com ferramentas que encapsulam a API do Google Ads (nível Explorer, MCC da LAVRA com a conta da clínica vinculada, `login-customer-id`). Ferramentas de leitura: gasto, cliques, conversas, agendamentos e consultas pagas por campanha. Ferramentas de escrita: orçamento, status de campanha, anúncios e palavras-chave. Cada ferramenta de escrita consulta o Nível de Autonomia da Conta antes de agir:

1. **Observar e propor** — só leitura; envia proposta ao Dono pelo WhatsApp e espera resposta.
2. **Ajustar dentro de limites** — muda orçamento e lances entre teto e piso definidos na Conta; pausa campanha que estoura custo por conversa.
3. **Criar e editar** — escreve anúncios e palavras-chave, sujeito às políticas de saúde do Google.

Toda ação e toda proposta vão para `api_audit_log` e para o Relatório Diário. O nível só sobe por ação do Dono no painel, auditada.

### Rotinas

Todas rodam no scheduler herdado (cron HTTP no contêiner `scheduler`, lista `CRONS`). `lib/rotinas/` grava `job_runs` em cada execução, e um cron de vigia alerta o operador e o Dono quando uma rotina esperada não rodou. Crons novos: `ads-spend-sync` (diário), `ads-agent` (diário), `ads-conversion-upload` (diário), `financeiro-lembretes` (diário), `relatorio-diario` (8h no fuso da Conta), `rotinas-vigia` (a cada hora).

### Painel

Telas novas ou tocadas, todas com porta em `lib/navigation/registry.ts`: Conexões (Embedded Signup em Coexistência), Serviços (preço e Margem Declarada), Agenda do dia (valor pago no "compareceu"), Anúncios (campanhas, Sobra por Real, nível de autonomia, propostas), Financeiro (importar OFX, caixa, contas), Relatório (histórico dos envios).

## Testing Decisions

- **Isolamento.** Toda tabela nova é tenant-aware com RLS e entra no teste de dois tenants de `pnpm test:db`.
- **Redação clínica.** Invariante em `tests/invariants/`: mensagem clínica pelo adapter fake resulta em `messages.body` redigido, nada em `ai_chunks` nem `event_log` com o texto, e primeira mensagem de saída com aviso de IA. Mensagem não clínica permanece íntegra.
- **Atribuição.** Código válido carimba campanha e marca o clique como consumido; código inválido ou ausente não bloqueia; segundo uso do mesmo código não sobrescreve o primeiro toque.
- **Sobra por Real.** Fixture com gasto de dois dias, três Contatos atribuídos, dois pagos com margens diferentes; dia sem gasto marcado como incompleto.
- **Agente de Anúncios.** Modelo falso nos testes: dado o que o modelo devolveu, o sistema respeita o nível (nível 1 nunca escreve; nível 2 nunca ultrapassa teto e piso). Toda escrita gera audit.
- **Rotinas.** Cron que roda grava `job_runs`; vigia dispara alerta quando a última execução esperada não existe.
- **Provas de realidade** por fase, no `## Prova` de cada issue, no formato da skill `prova-de-aceite`. Teste verde não fecha fase.

## Out of Scope

Meta Ads (a clínica não anuncia lá; o extrator herdado fica). Open Finance e qualquer integração bancária além de OFX. Self-serve e segunda Conta antes da primeira estável. Aplicativo nativo. Raio-X como módulo. Módulo pessoal. Prospecção fria. Multi-idioma. Redução da colisão entre app e Agente além do intervalo de silêncio.

## Further Notes

**Emendas.** Esta spec emenda ADR-0003 (Kapso deixa de ser o transporte previsto; vira uma das pontes), ADR-0006 (Drizzle não existe no fork; o acesso é supabase-js atrás de RLS), ADR-0007 (Inngest sai; scheduler herdado mais `job_runs`) e ADR-0011 (o corte era de calendário; o alvo volta a ser a frase de destino). As notas de emenda estão nas próprias ADRs. Quatro ADRs novas: 0015 a 0018.

**Fases.** Oito, em `docs/research/handoff-fork-deskcomm.md` reescrito e nas issues 19 a 25 mais uma nova: (1) fork limpo de pé; (2) adapter fake, rotinas e Coexistência; (3) redação clínica e aviso de IA; (4) clínica no ar com preço e valor pago; (5) ads com atribuição e agente em nível 1; (6) financeiro OFX; (7) Relatório das 8h; (8) níveis 2 e 3 do Agente de Anúncios.

**Pendências fora do código.** VPS para o kit self-host; verificação de empresa da LAVRA na Meta; MCC do Google Ads com a conta da clínica vinculada e developer token; domínio para a Página de Captura; nomes dos Profissionais, preços, margens e convênios, que só o Dono tem.

**O nome do produto continua provisório.**
