# O MVP é uma Conta, um Agente, e nada mais

O primeiro código de produto entrega só isto: o Agente da Clínica Humana atendendo pelo WhatsApp, Passagem para a Caixa de Entrada com aviso ao Plantonista, e um painel mínimo com a fila de Passagem e o histórico de Conversas. Persistência mínima — quem, quando, qual profissional — nunca Conteúdo Clínico (ADR-0004). `tenant_id` e RLS desde o primeiro commit (ADR-0002), mas sem Embarque de uma segunda Conta enquanto a primeira não estiver estável.

Ficam fora, sem data de retomada: Raio-X, Agente gestor de anúncios e qualquer integração com Meta Ads, Funil e CRM completo — inclusive a hipótese de usar o Twenty CRM como base, adiada por exigir uma segunda aplicação (NestJS/React/Postgres/Redis) ao lado do stack já fechado em ADR-0006 —, importação de Extrato e qualquer painel financeiro, integrações públicas (Serasa, Receita Federal, CNPJ/CPF, IPTU, multas), o produto "OS da vida da pessoa" e qualquer módulo pessoal, e o modelo self-serve para autônomos (ADR-0009).

O escopo desejado cresceu em paralelo à arquitetura e nada disso tem uma linha escrita. O risco não é escolher errado entre os módulos: é continuar aprofundando arquitetura e pesquisa para um produto de N módulos e N Contas antes de provar que o módulo mais simples funciona para uma Conta só. A frase de destino do README já basta para orientar um MVP estreito — o Dono abre o WhatsApp e vê que o Agente atendeu, qualificou, vendeu ou agendou a noite anterior.

## Consequências

O painel do Dono nasce mais pobre do que o destino escrito no README, e parte da pesquisa já feita (Twenty CRM, Pluggy/OFX) fica parada por tempo indeterminado. As ADRs de longo prazo continuam válidas e não precisam ser refeitas quando os módulos cortados voltarem — este ADR corta calendário, não arquitetura.

Revisitar quando a Clínica Humana operar sem intervenção manual diária por algumas semanas, ou quando um segundo cliente pedir explicitamente um dos módulos cortados — o que vier primeiro. Até lá, pedido de expandir escopo volta como ideia nova, não como adendo a este ADR.

## Emenda (01/09/2026, Spec 0003)

O corte desta ADR era de calendário, e o calendário mudou: o fork entregou de uma vez a camada que o MVP ia construir à mão. O alvo volta a ser a frase de destino inteira do README, para uma Conta só — a Clínica Humana. Continua valendo: uma Conta, um Agente, nenhum Embarque de segunda Conta antes da primeira estável. A Spec 0002, escrita para repo vazio, é substituída pela Spec 0003.
