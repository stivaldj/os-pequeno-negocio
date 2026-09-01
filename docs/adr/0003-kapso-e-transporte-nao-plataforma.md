# A Kapso é transporte, não plataforma

O Agente vive no nosso backend. A Kapso entrega e recebe mensagem do WhatsApp por webhook e nada mais — não usamos os flows visuais nem o Agent node dela.

Ela resolve bem o problema chato: embedded signup da Meta, número verificado, e multi-número por Conta a preço baixo. Mas construir o Agente dentro dela transformaria o produto numa revenda: o que vendemos é o cérebro e a integração com o negócio do cliente.

## Consequências

Trocar Kapso por Z-API, Evolution ou um BSP é trocar um adaptador, não reescrever o Agente. Em troca, perdemos a conveniência dos flows prontos e assumimos a orquestração.

## Emenda (01/09/2026, Spec 0003)

A Kapso deixa de ser o transporte previsto. A Coexistência da Meta só existe dentro do Embedded Signup, e o Embedded Signup exige Tech Provider ou Solution Partner — então o caminho principal é a LAVRA como Tech Provider, operando a Cloud API pelo adapter `meta_cloud` do fork (ADR-0015). Kapso e Zernio ficam como pontes possíveis se a aprovação da Meta atrasar. O princípio desta ADR continua: transporte é adaptador, e o Agente vive no nosso backend.
