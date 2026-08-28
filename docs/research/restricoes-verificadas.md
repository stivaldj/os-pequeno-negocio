# Restrições verificadas

Fatos checados contra fonte primária durante o grilling de 28/08/2026. Reconferir antes de agir sobre qualquer um: preços e políticas mudam.

## WhatsApp e Meta

- A Política de Mensagens exige que a pessoa tenha fornecido o número **e** dado opt-in explícito. Lista comprada ou raspada é violação. — [WhatsApp Business Policy](https://whatsappbusiness.com/policy/)
- Limite inicial de 250 destinatários únicos por 24h, escalando por verificação e qualidade. Denúncias derrubam o quality rating até restrição e banimento da organização. — [Messaging Limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits)
- Fora da Janela de Atendimento de 24h, só Modelo Aprovado.
- A Kapso é Tech Provider sobre a Cloud API, não BSP. Expõe Platform API com `customers` e `setup_links`, inbox embarcado, webhooks, MCP e node no n8n — o suficiente para o papel de transporte da ADR-0003.

## Anúncios

- Enquanto operamos como ferramenta própria (admin do nosso app), Standard/Dev Tier basta e **não há App Review**. Ele só passa a ser exigido quando terceiros autenticam via OAuth. — [Meta Marketing API Access](https://developers.facebook.com/docs/marketing-api/access)
- Meta exige Business Verification com CNPJ; o cliente concede partner access ao nosso Business ID e nós criamos um System User.
- Google Ads exige conta MCC para o developer token; o nível Explorer é aprovado automaticamente. — [Google Ads Access Levels](https://developers.google.com/google-ads/api/docs/access-levels)
- Ambas as APIs são gratuitas.

## Trabalho agendado

- Vercel Cron é *best effort*: "your function does not execute, and no runtime log is created for that scheduled run", e "Vercel will not retry an invocation if a cron job fails". — [Vercel Cron](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- Incidentes públicos do Inngest são de atraso de execução, não de perda. — [status.inngest.com](https://status.inngest.com/history)

## Open Finance

- Participação direta exige autorização do Banco Central. — [Open Finance Brasil](https://openfinancebrasil.org.br/modelo-de-participacao/)
- Pluggy: sandbox é sintético; o trial de 14 dias pausa conexões reais no dia 15; o conector "Meu Pluggy" responde em texto expresso que uso comercial **não** é permitido.
- Risco à frente: a Resolução Conjunta nº 14 pode restringir os contratos de parceria que permitem a não-licenciados operar via licenciado.

## Saúde

- Resolução CFM nº 2.454/2026 classifica no Anexo II como **baixo risco** o agendamento de consultas por IA e chatbots com informação geral de saúde sem aconselhamento clínico personalizado. Veda delegar à IA a comunicação de diagnóstico, prognóstico ou decisão terapêutica sem mediação humana, e dá ao paciente o direito de saber que há IA envolvida. — [CFM 2.454/2026](https://sistemas.cfm.org.br/normas/arquivos/resolucoes/BR/2026/2454_2026.pdf)
- Teletriagem é ato médico. — [CFM 2.314/2022](https://sistemas.cfm.org.br/normas/arquivos/resolucoes/BR/2022/2314_2022.pdf)
- O que o bot diz responsabiliza o médico; nada de prometer resultado nem vincular desconto a premiação. — [CFM 2.336/2023](https://sistemas.cfm.org.br/normas/arquivos/resolucoes/BR/2023/2336_2023.pdf)
- Como operador: LGPD arts. 39, 42 §1º I (solidária), 46–48, e Resolução CD/ANPD nº 15/2024 (incidente em 3 dias úteis). O art. 11 §4º veda uso de dado de saúde para vantagem econômica.
- O Guia de Segurança da ANPD para agentes de pequeno porte é a régua mínima. — [ANPD](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-vf.pdf)

## Mercado

- Agente de IA no WhatsApp já tem preço formado no Brasil como produto de agência: faixa de milhares de reais de setup mais mensalidade na casa dos milhares.
- Não existe produto comercial unindo CRM empresarial e assistente pessoal de vida; o histórico de personal CRM é de fracasso repetido. É o que a ADR-0001 resolve mantendo um produto só, com módulos por perfil.
