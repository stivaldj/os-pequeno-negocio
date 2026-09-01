# Conteúdo Clínico é reconhecido por léxico determinístico antes de ser gravado

Em Conta de saúde, o texto do Contato passa por um classificador **determinístico, síncrono e em memória** antes do insert em `messages`: um léxico em português de sintomas, condições e medicamentos, mais formas ("tô com dor de…", dose e frequência). Quando casa, `messages.body` recebe o marcador `[conteúdo clínico redigido]`, o preview da Conversa recebe o mesmo marcador, os efeitos pós-entrada não recebem texto, e a Conversa vai para humano com o motivo `clinical_mention`. O `event_log` e o RAG leem `body`, então herdam o marcador sem código próprio. O que se persiste da redação é só a categoria — sintoma, condição ou medicação — nunca a chave do léxico que casou, porque "losartana" é a medicação que a ADR-0004 manda descartar.

A alternativa era o modelo de linguagem classificar, como o motor já faz para intenção comercial. Recusada como único juiz porque a classificação de intenção roda **depois** da persistência, dentro do turno, e a ADR-0004 proíbe persistir. Segurar a mensagem em memória até um modelo responder colocaria um juiz que pode cair, custar e demorar entre a mensagem e o banco. O modelo entra depois como segunda opinião sobre o que o léxico deixou passar, não como porta.

O "não é ato médico" na saída do Agente não vira gate novo na cadeia `before_send`: um gate precisa de contexto de Conta montado em `inbound-turn.ts`, que não se edita (regra do fork). Vira função pura mais um cron horário em modo observação, que marca no inbox e no audit a resposta que pareça diagnóstico ou prescrição. Enforce vem depois de medir.

## Consequências

Falsos positivos são aceitos: uma frase inocente que casa vira marcador e cai para humano. O custo é uma Passagem a mais; com a Coexistência (ADR-0015), a recepção lê a mensagem original no app. Falsos negativos sobram onde o léxico não alcança, e é esse o espaço da segunda opinião por modelo. Se a configuração da Conta não puder ser lida, o preparador redige por segurança.

A transcrição de áudio (`messages.media_derived_text`) ainda não passa pelo preparador. Hoje a coluna existe e é lida no contexto do lead, mas nenhum código em `lib/` ou `app/` a preenche; quando algum passar a preencher, precisa entrar pelo mesmo preparador. Risco aberto, registrado.

O aviso de IA não é desta ADR: o `disclosureGate` herdado já injeta o texto no primeiro envio de toda Conversa a partir de um template por Conta; a Fase 3 entrega o texto (CFM 2.454/2026) e prova a cobertura.
