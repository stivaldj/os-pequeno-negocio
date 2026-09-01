# O Agente de Anúncios tem Níveis de Autonomia, ligados pelo Dono

Um worker diário do produto, usando a API da Claude com ferramentas sobre a API do Google Ads, cuida das campanhas de cada Conta. Decidimos que ele nasce em modo de observar e propor, e só ganha poder de escrita por Nível de Autonomia que o Dono liga na Conta: (1) observar e propor pelo WhatsApp; (2) ajustar orçamento e lances entre teto e piso, e pausar campanha que estoura custo por conversa; (3) criar e editar anúncios e palavras-chave.

A alternativa era uma sessão agendada do Claude Code fora do produto. Recusada porque a ação não ficaria no audit da Conta, não valeria para o segundo cliente, e os limites de verba viveriam num prompt em vez de no sistema.

## Consequências

Toda ferramenta de escrita consulta o nível antes de agir e grava audit com o nível em vigor. O Agente nunca sobe lista de pacientes como público, porque saúde é categoria sensível na política do Google. Subir de nível é ação do Dono no painel, auditada; o operador não sobe por ele.
