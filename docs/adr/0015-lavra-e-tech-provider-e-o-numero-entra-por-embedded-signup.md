# A LAVRA é Tech Provider da Meta; o Número entra por Embedded Signup em Coexistência

A Coexistência prometida na ADR-0014 só existe dentro do Embedded Signup da Meta, e o Embedded Signup só é liberado para Solution Partner ou Tech Provider, com verificação de empresa e App Review aprovados. Decidimos que a LAVRA cumpre esse rito e opera a Cloud API diretamente, pelo adapter `meta_cloud` que o fork já tem, acrescido do fluxo de onboarding de usuário do app e dos webhooks de eco, sincronização de estado e histórico.

A alternativa era um parceiro que já oferece Coexistência. Recusada como caminho principal porque o produto vai operar dezenas de Números de clientes diferentes, e cada um pagaria a margem do intermediário. Fica como ponte: se a aprovação da Meta chegar depois de a clínica estar pronta, o Número entra por Kapso ou Zernio e migra depois, sem mudar nada fora de `lib/channels/`.

## Consequências

A papelada da Meta corre em paralelo ao código desde o início da Fase 2, e é o operador quem a faz. A clínica cadastra cartão no próprio WABA, porque Tech Provider não tem linha de crédito. Nunca se apaga a conta do app: é o único caminho que perde o histórico e bloqueia o Número no app.

**Sobre a doutrina herdada.** `docs/doctrine/restricao-de-canal.md` registra que Embedded Signup não cabe em self-host, porque exigiria cada instalação virar Tech Provider. Esta ADR não a contradiz: o Embedded Signup é opcional por instalação, ligado só quando a instalação declara o app da Meta (`META_APP_ID`, `META_APP_SECRET`, `META_EMBEDDED_SIGNUP_CONFIG_ID`), e o BYO manual continua sendo o caminho padrão. A LAVRA é a instalação que é Tech Provider; quem instala o kit por conta própria segue colando credencial.
