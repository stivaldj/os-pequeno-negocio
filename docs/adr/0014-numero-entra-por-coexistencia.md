# O Número entra por Coexistência, não por migração

O Número da Conta é conectado por **Coexistência**: o app do WhatsApp Business continua funcionando no telefone da recepção e a Cloud API opera o mesmo número em paralelo. Não há migração destrutiva no Embarque.

O Número da Clínica Humana — o publicado no site — já estava registrado no app. Pelo caminho direto da Cloud API seria preciso deletar a conta, e a Meta é explícita quanto ao efeito: o histórico de mensagens é perdido e o número não volta a funcionar no app enquanto estiver registrado na Cloud API. Isso tiraria o WhatsApp da mão de quem hoje atende, e jogaria todo o atendimento comum para dentro de uma Caixa de Entrada que foi desenhada para receber Passagem — sem busca, sem iniciar conversa, sem duas pessoas atendendo junto. Seria o ADR-0011 sendo desfeito por uma decisão de infraestrutura.

A Coexistência preserva o histórico e deixa as duas superfícies vivas. A Kapso a suporta (ADR-0003), o que a torna caminho disponível sem trocar de transporte.

## Consequências

Duas superfícies escrevem no mesmo Número, e o sistema deixa de ser a única fonte da Conversa: alguém da recepção pode responder pelo app sem o `core` saber. O estado da Conversa governa o Agente, não o humano do outro lado do telefone — então o Agente pode responder por cima de uma conversa já assumida à mão.

É o preço de não tirar o WhatsApp da clínica, e é menor do que o da alternativa. Reduzir a colisão é problema de produto para depois do MVP; por ora, o botão de desligar o Agente é a saída manual quando a recepção quiser assumir.
