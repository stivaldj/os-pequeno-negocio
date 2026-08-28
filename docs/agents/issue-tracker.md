# Issue tracker: GitHub

Issues e specs deste repo vivem como GitHub Issues. Use a CLI `gh` para todas as operações.

## Convenções

- **Criar issue**: `gh issue create --title "..." --body "..."`. Use heredoc para corpos multi-linha.
- **Ler issue**: `gh issue view <number> --comments`.
- **Listar issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`.
- **Comentar**: `gh issue comment <number> --body "..."`
- **Labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Fechar**: `gh issue close <number> --comment "..."`

O repo é inferido de `git remote -v`.

## Idioma

Títulos e corpos de issues em **português do Brasil**. Nomes de branch e mensagens de commit em **inglês**.

## Pull requests como superfície de triagem

**PRs como superfície de request: não.**

## Quando uma skill disser "publish to the issue tracker"

Criar uma GitHub Issue.

## Quando uma skill disser "fetch the relevant ticket"

Rodar `gh issue view <number> --comments`.

## Operações de wayfinding

Usadas pelo `/wayfinder`. O **mapa** é uma issue única com issues **filhas** como tickets.

- **Mapa**: issue com label `wayfinder:map`.
- **Ticket filho**: sub-issue nativa do GitHub, labels `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: dependências nativas do GitHub — `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, onde o id é o **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`), não o `#number`.
- **Fronteira**: issues filhas abertas, sem bloqueador aberto e sem assignee.
