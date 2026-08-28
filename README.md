# OS Pequeno Negócio

> Nome provisório. Produto da linha **Veio** da LAVRA.

## Destino

O dono de um pequeno negócio em Várzea Grande abre o WhatsApp e vê que o agente atendeu, qualificou, vendeu ou agendou os clientes da noite anterior, o CRM já está preenchido, e o relatório do dia com gasto e retorno dos anúncios chegou às 8h, fluxo de caixa, as contas a pagar e a receber do dia, com lembretes já enviados — sem ele ter tocado em nada. Ele consegue entender, a cada 1 real investido em ads, o quanto está sobrando pra ele, dando segurança na tomada de decisão de escalar.

## Onde as coisas estão

- **`CONTEXT.md`** — glossário do domínio. Toda palavra usada em issue, teste e nome de tipo sai daqui.
- **`docs/adr/`** — as decisões e por que foram tomadas.
- **`docs/agents/`** — como os agentes devem operar neste repo (issue tracker, labels, docs de domínio).
- **`docs/research/`** — fatos verificados contra fonte primária, com data.

## Escopo da v1

Atendimento e venda por WhatsApp · CRM preenchido pelo Agente · gestão e relatório de anúncios · caixa e contas a pagar/receber via OFX · lembretes e follow-up · Sobra por Real.

**Fora da v1, de propósito:** Open Finance · saúde, treino, dieta e medicação · prospecção fria · app nativo · integração com ERP/PDV.

## MVP antes da v1

O escopo acima é o destino da v1, não o primeiro corte de código. O MVP é bem mais estreito — uma Conta, um Agente no WhatsApp, Passagem para a Caixa de Entrada e um painel mínimo — sem CRM, sem anúncios e sem módulo financeiro. Ver ADR-0011.

## Cliente zero

Clínica Humana. Ver ADR-0004 — é dela que vem a regra de nunca persistir Conteúdo Clínico.

## Idioma

Docs, glossário, ADRs, specs e tickets em português do Brasil. Código, identificadores, nomes de arquivo e mensagens de commit em inglês. A fronteira é o `CONTEXT.md`.
