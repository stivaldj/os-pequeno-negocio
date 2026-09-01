# Evolution Foundation — avaliação

Analisado em 01/09/2026, a partir de <https://github.com/evolution-foundation> (39 repos públicos).

## O que existe de verdade

| Peça | O que é |
| --- | --- |
| `evolution-api` (TS, 9,2k ★) | API REST de mensageria WhatsApp. Suporta **Baileys** (não oficial) **e Cloud API oficial**. |
| `evolution-go` (Go) | Mesma função sobre whatsmeow (também não oficial). |
| `evo-crm-community` | Plataforma de atendimento: conversas, contatos, inboxes, campanhas, journeys. Monorepo de ~6 serviços. |
| `evo-ai-*-community` | Execução de agentes com tools e MCP (Go + Python + Rails + React). |
| `evo-flow-community` | Journeys e campanhas sobre NestJS + Temporal + ClickHouse + Kafka. |
| Integrações | Typebot, Chatwoot, Dify, OpenAI, n8n, Flowise, RabbitMQ, Kafka, SQS, NATS, S3. |

## Por que "tem tudo pronto" não se sustenta

**O multi-tenant foi deliberadamente retirado.** A Community Edition é declaradamente single-tenant, sem super-admin, sem billing, sem planos. É open-core: abre-se o produto e vende-se exatamente a camada que uma agência precisa. O que falta é o que a ADR-0002 chama de coração do sistema.

**A licença amarra a marca.** Apache 2.0 mais duas condições: não remover logo e copyright dos componentes de frontend, e — a que dói — *Usage Notification Requirement*, que obriga a exibir aviso de que o produto Evolution está em uso **mesmo em sistema proprietário fechado**, visível a administradores e na documentação. O `TRADEMARKS.md` fecha o cerco: modificou a UI, é obrigatório remover toda a marca Evo/Evolution e adotar identidade claramente distinta; paleta, tipografia e border-radius estão listados como elementos protegidos. Não existe whitelabel limpo.

**Há um interruptor de fornecedor.** Desde a `v2.4.0-rc1` (06/05/2026) o `evolution-api` exige **ativação contra o servidor de licenciamento da Evolution Foundation**; sem ela, os endpoints de negócio respondem `503 LICENSE_REQUIRED`. O `evolution-go` já nasce com registro, ativação e heartbeat periódico. Não há informação pública sobre a licença ser gratuita ou paga. A última estável sem isso é a `v2.3.7` (05/12/2025), que envelhece a partir de agora.

**O custo operacional contradiz a ADR-0006.** O stack completo é Rails + Go + Python + NestJS, com Temporal, ClickHouse e Kafka. Adotá-lo troca "escrever código" por "operar seis serviços de outra pessoa" — e ainda deixa o multi-tenant para construir por cima.

## O modo Baileys e o número do cliente

Os WhatsApp Business Terms proíbem em texto expresso desenvolver ou usar aplicações que interajam com os serviços sem consentimento prévio, e criar software que funcione substancialmente como eles. Baileys é engenharia reversa do WhatsApp Web; o próprio projeto declara não ter vínculo com o WhatsApp.

O dado que mais importa não é sobre volume. A issue [whatsmeow #810](https://github.com/tulir/whatsmeow/issues/810) (mai/2025) registra contas avisadas por "ferramentas não autorizadas" **mesmo apenas respondendo mensagens recebidas**, sem disparo — o vetor de detecção é o cliente em si, não o comportamento. Some-se [Baileys #1869](https://github.com/WhiskeySockets/Baileys/issues/1869), com bots de três anos banidos na mesma semana. Aquecimento de chip e limites de envio reduzem risco; não o eliminam.

Estatística confiável de banimento **não existe** — os números que circulam em blogs brasileiros são marketing de vendedores de API oficial, sem metodologia. O padrão observável é estocástico e em ondas.

**A assimetria decide.** O ganho é economizar centavos por mensagem. A perda é o número da clínica: o canal que está no Google Meu Negócio, na fachada, nos anúncios e na agenda de cada paciente. Não há migração — os pacientes seguem escrevendo para um número morto. Seria risco ilimitado, em ativo de terceiro, com o ToS violado conscientemente pela agência. Indefensável em qualquer disputa. Ver ADR-0005.

## Conclusão

Não adotamos o stack Evolution como base do produto: falta exatamente o multi-tenant, a licença obriga a creditar a marca deles no nosso sistema, existe um servidor de licenciamento no caminho crítico, e o custo operacional é incompatível com um operador solo.

**O que aproveitar:** o `evolution-api` **em modo Cloud API oficial** é candidato legítimo a implementação da porta de transporte, ao lado da Kapso — é troca de adaptador, exatamente o que a ADR-0003 previu. Vale comparar com a Kapso em custo, esforço de operação e no que cada um resolve do embedded signup da Meta.

**O que nunca fazer:** Baileys ou whatsmeow em número de cliente.
