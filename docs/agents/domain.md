# Docs de domínio

Como as skills devem consumir a documentação de domínio deste repo.

## Antes de explorar, leia

- **`CONTEXT.md`** na raiz — glossário e modelo de domínio.
- **`docs/adr/`** — leia as ADRs que tocam a área em que você vai trabalhar.

Se algum desses não existir, siga em silêncio. O `/domain-modeling` os cria conforme os termos e decisões se resolvem.

## Estrutura (single-context)

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-....md
│   └── 0002-....md
└── src/
```

## Idioma

- **Docs, glossário, ADRs, specs e tickets**: português do Brasil.
- **Código, identificadores, nomes de arquivo, mensagens de commit e comentários**: inglês.
- A fronteira é o `CONTEXT.md`, que mapeia cada termo de domínio em português para o identificador em inglês. Use o termo do glossário; não derive para sinônimos.

## Conflito com ADR

Se sua proposta contradiz uma ADR existente, diga isso explicitamente em vez de sobrescrever em silêncio.
