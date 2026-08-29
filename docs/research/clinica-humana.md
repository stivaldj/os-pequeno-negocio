# Clínica Humana — levantamento

Cliente zero. Lido do site público em 28/08/2026, fonte única: [clinicahumanavg.com.br](https://clinicahumanavg.com.br). Confirmar tudo com o Dono antes de virar seed — site institucional envelhece sem aviso.

## O que está publicado

- **Endereço**: Av. Brigadeiro Eduardo Gomes, 508 — Centro-Sul, Várzea Grande-MT, CEP 78125-265.
- **Expediente**: segunda a sexta, 7h–19h30. Sem sábado e sem domingo no site.
- **Responsável técnica**: Dra. Rafaela Martinez Trevisan, CRM-MT 11586.
- **Contato**: +55 65 4042-1817, apresentado como WhatsApp. É número fixo.
- **Serviços**, catorze: clínica geral, cirurgia geral, psiquiatria, ginecologia e obstetrícia, pediatria, ortopedia, cardiologia, laboratório, pilates, hidroginástica, nutrição, psicologia, fisioterapia, dança.

## O que não está publicado, e é insumo de ticket

- **Profissionais nominais e o Expediente de cada um.** O site diz "conheça a nossa equipe" sem listar ninguém. Sem isso a #8 não tem horário livre para oferecer.
- **Preços por serviço.** Necessários para a Ferramenta de responder com a informação cadastrada (#4).
- **Convênios aceitos.** Pergunta frequente de Contato; sem a lista, o Agente cai em "não sei".

Os três só vêm do Dono.

## Consequências para o MVP

**O Expediente publicado define o buraco que o produto preenche.** Fechada às 19h30 e nos fins de semana, a maior parte das mensagens de Contato cai fora do Expediente — que é o sexto Gatilho de Passagem. Se o Gatilho de fora do Expediente derrubar tudo para a Caixa de Entrada, o MVP entrega uma fila noturna para o Plantonista em vez de atendimento. O Agente precisa atender fora do Expediente no que dá — informação e Agendamento — e passar por assunto, não por horário. Vale rever a redação desse Gatilho antes da #5.

**Catorze especialidades colidem com a definição de Conteúdo Clínico.** A regra atual trata "especialidade procurada" como Conteúdo Clínico, e com esse cardápio quase todo pedido de Agendamento revela uma. Decisão aberta, ver a issue de `decisao` correspondente.

**O número é fixo (4042).** A Cloud API aceita fixo, mas o número não pode estar registrado no app do WhatsApp — se estiver, há migração antes de conectar pela Kapso. Verificar antes da #3 terminar, não na #11.
