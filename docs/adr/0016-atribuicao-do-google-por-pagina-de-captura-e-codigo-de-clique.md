# Atribuição do Google Ads por Página de Captura e Código de Clique

O botão de WhatsApp nativo do Google Ads entrega só conversão agregada por campanha; a mensagem que abre no WhatsApp não carrega identificador de clique. Decidimos que o anúncio aponta para uma Página de Captura própria, que grava o gclid e a campanha, gera um Código de Clique curto e abre o WhatsApp com o código pré-preenchido. O ingest reconhece o código na primeira mensagem e estampa a atribuição no Contato com o mecanismo de primeiro toque que o fork já tem.

A alternativa era uma frase inicial distinta por campanha no botão nativo, sem página. Recusada porque entrega só o nível de campanha e não devolve nada ao Google: sem gclid não há conversão offline, e sem conversão offline o lance automático não aprende com a consulta paga — que é o que torna o Agente de Anúncios útil.

## Consequências

Existe uma página pública a manter, com domínio próprio, e a campanha deixa de usar o botão nativo. Código ausente ou inválido nunca bloqueia o atendimento: o Contato entra sem atribuição. A consulta paga com gclid volta ao Google como conversão offline com valor.
