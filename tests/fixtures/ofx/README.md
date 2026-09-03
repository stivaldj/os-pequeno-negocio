# Fixtures de OFX

Extratos de banco sintéticos para `lib/financeiro/ofx/`. Cada arquivo existe por
causa de um defeito **medido** em extrato brasileiro real — não há fixture
decorativa aqui.

## Regerar

```bash
node tests/fixtures/ofx/gerar.mjs
```

Nunca edite um `.ofx` à mão: toda ferramenta de edição grava UTF-8 com LF, e as
duas coisas que estas fixtures provam (CRLF e o byte único de cp1252) morrem em
silêncio. O `gerar.mjs` escreve por `Buffer.from(texto, "latin1")` com `\r\n`
explícito; o `.gitattributes` da raiz (`tests/fixtures/ofx/*.ofx -text`) impede o
git de desfazer isso no checkout. Para conferir:

```bash
od -c tests/fixtures/ofx/bradesco-like.ofx | head   # tem de mostrar \r \n
git check-attr -a tests/fixtures/ofx/bradesco-like.ofx   # tem de dizer "text: unset"
```

## O que cada arquivo prova

| Arquivo | Prova |
| --- | --- |
| `bradesco-like.ofx` | Linha em branco antes do `OFXHEADER`, `DTSERVER` zerado, fechamento de tag **misto** no mesmo arquivo, `TRNAMT` com vírgula decimal e padding, `MEMO` com acento cp1252 (`CARTÃO`, `COBRANÇA`) e `&` cru, `FITID` igual ao `CHECKNUM`, `ACCTID` com espaço sobrando, `LEDGERBAL` **e** `AVAILBAL`. |
| `duas-contas.ofx` | Dois `STMTTRNRS` no mesmo arquivo; a segunda conta tem **um** `STMTTRN` só. Trava o `asArray()` nos dois sentidos: um filho vira objeto, dois viram array. |
| `caixa-decimal-quebrado.ofx` | `TRNAMT` = `            .  ` (a Caixa manda isso) tem de virar `null`, **jamais 0** — zero entraria no livro-caixa como lançamento válido. `LEDGERBAL` igualmente quebrado: a conta fica **sem** saldo. E a linha sintética `SALDO DIA` com `FITID:0`. |
| `fitid-repetido.ofx` | Duas transações da mesma conta com o mesmo `FITID`: a conta inteira cai para a chave por conteúdo. As duas últimas repetem `(dia, valor)` de propósito — é o par que só o ordinal distingue. |
| `memo-com-sinal.ofx` | Um `<` dentro do `MEMO`. É o caractere que faz a `ofx-js@1.1.1` **lançar**, perdendo o arquivo inteiro do Dono por um sinal de menor. |
| `cartao.ofx` | Fatura de cartão: ramo `CREDITCARDMSGSRSV1 > CCSTMTTRNRS > CCSTMTRS`, com `CCACCTFROM` que só tem `ACCTID` (não existe `BANKID`). |
| `cora-meia-noite-gmt.ofx` | **Anonimizado de extrato real** (Cora SCD SA, 01/09/2025, Clínica Humana). Todo carimbo é `000000[0:GMT]` — lançamentos, `DTSTART`, `DTEND` e `LEDGERBAL`. Lido como instante, 00:00Z vira 21h do dia **anterior** em Brasília e os três lançamentos de setembro caíam em agosto. Também: `ENCODING:UTF-8` **sem** linha `CHARSET` (fora da spec 1.x, mas é o que chega) e `LEDGERBAL` que não é a soma da janela. |
| `ofx2.xml.ofx` | O **mesmo conteúdo** do `bradesco-like.ofx` em OFX 2.x (XML, tudo fechado, UTF-8, `&amp;`). O teste afirma lançamentos idênticos aos da v1: um tokenizer só lê as duas versões. |

## Por que as fixtures são nossas

Os extratos brasileiros reais anonimizados que circulam vivem em `annacruz/ofx`,
que **não declara licença** (a API do GitHub devolve 404 em `/license`). Sem
licença, sem direito de versionar. Eles serviram de oráculo; o que entra no repo
é escrito por nós, reproduzindo os mesmos defeitos.

O teste **varre esta pasta**. Quando o extrato real da Clínica Humana for
exportado e anonimizado, basta largá-lo aqui: ele entra no gate sem que se toque
numa linha de teste.
