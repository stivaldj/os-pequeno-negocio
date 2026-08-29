# Especialidade escolhida não é Conteúdo Clínico; sintoma escrito é

Conteúdo Clínico passa a ser definido pelo que o Contato **escreve** — sintoma, condição, medicação — e não pelo que ele **escolhe**. Escolher um Profissional ou um serviço dentro do que o Agente ofereceu não é Conteúdo Clínico, e não provoca Passagem.

Isto emenda a ADR-0004, que incluía "especialidade procurada" na definição. A Clínica Humana publica catorze serviços, entre eles psiquiatria, ginecologia e psicologia: pela regra anterior, quase todo pedido de agendamento viraria Passagem, e a Ferramenta de agendar do MVP não rodaria uma vez. A regra escrita para proteger dado sensível estava, na prática, devolvendo todo o atendimento para o humano — que é exatamente o que o produto existe para não precisar.

O que protege o dado não é a definição larga, é onde ele para: o Agendamento guarda Conta, Contato, Profissional, data, hora e status, e nunca o motivo. O texto livre do Contato continua sendo avaliado antes de qualquer persistência, e sintoma, condição ou medicação continuam descartados e continuam provocando Passagem (ADR-0004).

## Consequências

Sobra risco residual, e ele é aceito conscientemente: um Agendamento com um Profissional de especialidade única permite inferir a especialidade procurada. É inseparável do ato de marcar consulta — a própria clínica tem esse dado na agenda de papel — e some se a inferência for barrada, junto com o produto. O que não é aceito é o motivo da consulta, que continua fora do banco.

A entrada **Conteúdo Clínico** do `CONTEXT.md` muda junto. O teste que afirma que o texto clínico não está em lugar nenhum do banco continua valendo, sem afrouxamento.
