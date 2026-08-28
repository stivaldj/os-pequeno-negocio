# OS Pequeno Negócio

Glossário do domínio. Nome do produto ainda provisório.

O produto é um sistema multi-tenant que atende e vende pelo WhatsApp para pequenos negócios, preenche o CRM sozinho, cuida dos anúncios e entrega ao dono, todo dia às 8h, um retrato do que entrou, do que sai e de quanto sobra por real investido.

Este arquivo é **só glossário**. Decisões vão para `docs/adr/`.

## Language

### Quem é quem

**Dono** (`Owner`):
A pessoa que paga pelo produto e recebe o relatório diário. Decide, confirma vendas e declara margens.
_Evitar_: usuário, admin, gestor

**Conta** (`Tenant`):
A empresa cliente. Unidade de isolamento: todo dado nasce pertencendo a exatamente uma Conta.
_Evitar_: workspace, organização, cliente

**Contato** (`Contact`):
A pessoa do outro lado do WhatsApp — quem procura o negócio do Dono.
_Evitar_: lead, usuário final, paciente

**Plantonista** (`OnCallUser`):
A pessoa da Conta que recebe o aviso quando o Agente passa uma conversa para humano.
_Evitar_: atendente, operador

### O agente

**Agente** (`Agent`):
A configuração de comportamento de uma Conta: instruções, tom, limites e quais Ferramentas estão ligadas. Uma Conta tem um Agente.
_Evitar_: bot, assistente, funcionário

**Ferramenta** (`Tool`):
Uma capacidade que o Agente pode acionar — agendar, consultar estoque, registrar no CRM, buscar métrica de anúncio. Ligar e desligar Ferramentas é o que dá ao Agente a sua "função".
_Evitar_: função, skill, ação

**Conversa** (`Conversation`):
A troca de mensagens entre um Contato e uma Conta num Número.
_Evitar_: chat, ticket, atendimento

**Passagem** (`Handoff`):
O momento em que o Agente para e entrega a Conversa a um humano. Tem um gatilho nomeado e sempre desemboca na Caixa de Entrada.
_Evitar_: transbordo, escalonamento, transferência

**Gatilho de Passagem** (`HandoffTrigger`):
A condição que provoca uma Passagem. Os seis: pedido explícito de humano, menção a sintoma ou medicação, reclamação, pedido de desconto fora de tabela, dois erros seguidos do Agente, fora do expediente.
_Evitar_: regra, condição

**Caixa de Entrada** (`Inbox`):
A tela do painel onde as Conversas passadas para humano esperam resposta. Toda Passagem termina aqui, nunca no número pessoal de alguém.
_Evitar_: fila, chat interno

**Conteúdo Clínico** (`ClinicalContent`):
Texto de Contato que revela sintoma, condição, medicação ou especialidade procurada. Nunca é persistido — é reconhecido, provoca Passagem, e descartado.
_Evitar_: dado de saúde, informação médica

### Canal

**Número** (`BusinessNumber`):
Um número de WhatsApp que pertence a uma Conta. É por ele que Contato e Agente se falam.
_Evitar_: linha, telefone, canal

**Janela de Atendimento** (`ServiceWindow`):
As 24 horas que se abrem quando um Contato manda mensagem. Dentro dela o Agente escreve livremente; fora, só Modelo Aprovado.
_Evitar_: janela de 24h, sessão

**Modelo Aprovado** (`MessageTemplate`):
Texto pré-aprovado pela Meta, único jeito de iniciar conversa fora da Janela de Atendimento.
_Evitar_: template, mensagem pronta

### Venda

**Oportunidade** (`Deal`):
Um Contato com intenção de compra identificada, posicionado numa Etapa do Funil. É o que o Agente cria e move sozinho.
_Evitar_: lead, negócio, card

**Funil** (`Pipeline`) e **Etapa** (`Stage`):
A sequência de estados por onde uma Oportunidade passa até virar Venda Confirmada ou morrer.
_Evitar_: kanban, coluna, status

**Venda Confirmada** (`ConfirmedSale`):
Uma Oportunidade que o Dono confirmou como vendida. Só o Dono confirma — o Agente propõe.
_Evitar_: conversão, fechamento

**Margem Declarada** (`DeclaredMargin`):
Quanto o Dono diz que sobra em cada produto ou serviço, informado uma vez no Embarque. É o que torna possível calcular Sobra por Real.
_Evitar_: markup, lucro, margem de contribuição

### Dinheiro

**Verba** (`AdSpend`):
Quanto foi gasto em anúncio num período, lido das APIs de anúncio.
_Evitar_: investimento, budget, custo de mídia

**Sobra por Real** (`NetReturnPerReal`):
Quanto sobra para o Dono a cada real de Verba, calculado com Venda Confirmada e Margem Declarada. É a promessa central do produto — não confundir com ROAS, que ignora a margem.
_Evitar_: ROI, ROAS, retorno

**Extrato** (`Statement`):
Movimentação bancária que entra no sistema por importação de arquivo OFX.
_Evitar_: transações, lançamentos bancários

**Conta a Pagar** (`Payable`) e **Conta a Receber** (`Receivable`):
Compromisso financeiro com data. Gera Lembrete e aparece no Relatório Diário.
_Evitar_: boleto, cobrança, fatura

### Rotina

**Relatório Diário** (`DailyBriefing`):
A mensagem das 8h: o que o Agente fez na noite anterior, Verba e Sobra por Real, caixa, e o que vence hoje. É a promessa que não pode falhar.
_Evitar_: resumo, digest, briefing

**Lembrete** (`Reminder`):
Mensagem disparada por data — vencimento, retorno de cliente, follow-up de Oportunidade parada.
_Evitar_: notificação, alerta

**Execução de Rotina** (`JobRun`):
O registro de que um trabalho agendado rodou. Existe para que a ausência dele seja detectável: falha silenciosa vira falha barulhenta.
_Evitar_: job, task, cron

**Raio-X** (`Audit`):
O diagnóstico pago que abre a relação com um cliente novo — marca, redes, anúncios, produtos, pagamentos, sistemas. Entregável comercial, não módulo do sistema.
_Evitar_: auditoria, diagnóstico, assessment

**Embarque** (`Onboarding`):
O processo de colocar uma Conta no ar: conectar Número, ligar Ferramentas, declarar Margens, vincular contas de anúncio.
_Evitar_: setup, implantação, ativação
