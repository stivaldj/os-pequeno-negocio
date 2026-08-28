# A Kapso é transporte, não plataforma

O Agente vive no nosso backend. A Kapso entrega e recebe mensagem do WhatsApp por webhook e nada mais — não usamos os flows visuais nem o Agent node dela.

Ela resolve bem o problema chato: embedded signup da Meta, número verificado, e multi-número por Conta a preço baixo. Mas construir o Agente dentro dela transformaria o produto numa revenda: o que vendemos é o cérebro e a integração com o negócio do cliente.

## Consequências

Trocar Kapso por Z-API, Evolution ou um BSP é trocar um adaptador, não reescrever o Agente. Em troca, perdemos a conveniência dos flows prontos e assumimos a orquestração.
