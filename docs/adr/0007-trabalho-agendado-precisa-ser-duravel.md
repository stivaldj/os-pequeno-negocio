# Trabalho agendado roda no Inngest, nunca no Vercel Cron

Relatório Diário, Lembretes e follow-up de Funil rodam como funções duráveis no Inngest. Toda execução bem-sucedida grava uma linha em `job_runs`, e existe alerta de "não rodou desde X".

O Vercel Cron está descartado por documentação da própria Vercel: a entrega é *best effort*, uma falha de rede impede a execução **sem gerar log algum**, e não há retry. O modo de falha dele é não deixar rastro — inaceitável para um produto cujo contrato é uma mensagem às 8h. O Inngest dá retry, memoização de steps (falhou no terceiro passo, não repete o primeiro), `sleepUntil` para Lembrete por data, e alerta de falha; seus incidentes públicos são de atraso, não de perda, que é como um sistema durável deve degradar.

## Considerado e recusado

**Trigger.dev** — igualmente durável e sem timeout, primeiro degrau pago bem mais barato. Fica como alternativa nomeada se as rotinas ficarem longas. **pg-boss/Graphile** — troca um fornecedor por um worker que morre em silêncio às três da manhã.

## Consequências

O free tier do Inngest guarda só 24h de rastreamento, e o salto de plano não tem meio-termo. A tabela `job_runs` existe justamente para não depender do painel dele para saber que algo não rodou.
