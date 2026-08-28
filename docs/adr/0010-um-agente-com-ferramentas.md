# Um Agente por Conta, com Ferramentas — não vários agentes

"Vários funcionários perfeitos, cada um na sua função" é como o produto se vende, não como ele se constrói. Cada Conta tem **um** Agente; a "função" é qual conjunto de Ferramentas está ligado.

Agentes separados de verdade, com contexto e prompt próprios e orquestração entre eles, resolvem o mesmo problema com dez vezes mais partes móveis. A separação só se justifica quando um agente precisar de contexto que os outros não podem ver — o que vai acontecer nas Contas de saúde (ver ADR-0004). A costura fica preparada; o corte não é feito agora.

## Consequências

A camada de Ferramentas precisa ser configurável por Conta desde o início, e cada Ferramenta precisa declarar que dado ela toca — é o que tornará o corte possível quando ele for necessário.
