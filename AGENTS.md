# AGENTS.md — OS Pequeno Negócio

A doutrina deste repositório está em [`CLAUDE.md`](CLAUDE.md): regra do fork, convenções herdadas do DeskcommCRM, gates e Definition of Done. Vale igual para Codex, Cursor, OpenCode e qualquer outro agente — leia-o antes de mexer em código.

## Guias embutidos do upstream

`.agents/skills/` (fonte) com espelho em `.claude/skills/` (`pnpm skills:sync`). Vêm do DeskcommCRM e valem para a camada herdada; a doutrina deste fork (acima) vence quando divergir.

| Quando | Guia |
| --- | --- |
| instalar, atualizar ou consertar a instalação numa VPS | `deskcomm-instalar` |
| configurar o CRM para um cliente ou nicho | `deskcomm-cliente-novo` |
| desempenho, conversão, custo de IA, funil | `deskcomm-metricas` |
| o agente responde errado ou passa tudo para humano | `deskcomm-prompt` |
| contribuir de volta ao upstream (PR em `melgarafael/DeskcommCRM`) | `deskcomm-contribuir` |
| escrever ou revisar código na camada herdada | `deskcomm-doutrina` e `sistema-vivo` |
