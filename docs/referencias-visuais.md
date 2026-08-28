# Referências visuais

Não são decisões de tecnologia — são o alvo estético do painel. A decisão de biblioteca, se houver, vira ADR.

## BoardUI — Dashboard

<https://www.boardui.com/templates/dashboard> · React + Tailwind · consultado em 28/08/2026

Referência de **linguagem visual**, não de estrutura. Não compramos e não copiamos a arquitetura de navegação.

**O que puxar:** a densidade e o repouso de um painel que não grita — cartões de indicador sóbrios, tipografia calma, gráfico único e grande em vez de muitos pequenos, hierarquia clara entre o número que importa e o resto.

**O que não puxar:** a estrutura. Os blocos dele — tabela de centenas de registros com filtros, carrossel de contratações, gestão de tickets — são de admin de SaaS B2B operado por um time. O nosso Dono é uma pessoa olhando o celular às 8h da manhã.

## O princípio que isso protege

O produto não pode virar mais um painel de administração com quinze itens de menu. A reclamação mais documentada contra o GoHighLevel é exatamente essa: nomenclatura sobreposta e semanas de curva de aprendizado. Nosso Relatório Diário chega pronto no WhatsApp; o painel existe para o que **não cabe** em mensagem — Funil, gráfico de caixa, Caixa de Entrada e configuração do Agente. Se o Dono precisa aprender a navegar, erramos.

## Base de componentes

**shadcn/ui** como piso: gratuito, padrão do ecossistema React + Tailwind, sem licença a gerenciar e sem custo de saída. Kit pago só entra se entregar bloco que não faríamos — e a cláusula a checar antes de qualquer compra é o uso em SaaS revendido a terceiros.
