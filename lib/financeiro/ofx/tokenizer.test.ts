/**
 * Tokenizer: SGML e XML no mesmo laço, e o `<` do MEMO que derruba a `ofx-js`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { asArray, filho, filhos, texto, tokenizar, type No } from "@/lib/financeiro/ofx/tokenizer";
import { lerCabecalho } from "@/lib/financeiro/ofx/header";

/** Relativo à raiz do repo, como o resto da casa faz — o `vitest run` roda de lá. */
const FIXTURES = "tests/fixtures/ofx/";
const arvoreDe = (nome: string): No => tokenizar(lerCabecalho(readFileSync(FIXTURES + nome)).corpo);

describe("tokenizar", () => {
  it("folha sem fechamento e folha fechada convivem no MESMO arquivo", () => {
    // O Bradesco manda o primeiro `<STATUS>` com os filhos abertos e o segundo
    // com os filhos fechados. Um tokenizer que escolha um dos dois estilos
    // perde metade do arquivo.
    const arvore = tokenizar(
      "<OFX>\r\n<A>\r\n<CODE>0\r\n<SEVERITY>INFO\r\n</A>\r\n<B>\r\n<CODE>0</CODE>\r\n<SEVERITY>WARN</SEVERITY>\r\n</B>\r\n</OFX>\r\n",
    );
    const ofx = filho(arvore, "OFX");
    expect(texto(filho(ofx, "A"), "CODE")).toBe("0");
    expect(texto(filho(ofx, "A"), "SEVERITY")).toBe("INFO");
    expect(texto(filho(ofx, "B"), "CODE")).toBe("0");
    expect(texto(filho(ofx, "B"), "SEVERITY")).toBe("WARN");
  });

  it("um `<` solto no MEMO é TEXTO e não derruba o arquivo", () => {
    // É o defeito medido da `ofx-js@1.1.1`: ela LANÇA, e o extrato inteiro do
    // Dono se perde por causa de um sinal de menor numa descrição.
    const arvore = arvoreDe("memo-com-sinal.ofx");
    const trans = filhos(
      filho(filho(filho(filho(filho(arvore, "OFX"), "BANKMSGSRSV1"), "STMTTRNRS"), "STMTRS"), "BANKTRANLIST"),
      "STMTTRN",
    );
    expect(trans).toHaveLength(2);
    expect(texto(trans[0], "MEMO")).toBe("TARIFA < 5 REAIS & SEM IOF");
    expect(texto(trans[1], "MEMO")).toBe("PIX ENVIADO 10 < 20 > 5");
  });

  it("só é tag o que casa <TAG> ou </TAG> — `<5`, `< A>` e `<R$` são texto", () => {
    const arvore = tokenizar("<OFX>\r\n<MEMO>a <5 b < A> c <R$ d\r\n</OFX>\r\n");
    expect(texto(filho(arvore, "OFX"), "MEMO")).toBe("a <5 b < A> c <R$ d");
  });

  it("`&` cru sobrevive e `&amp;` vira `&` (v1 e v2 dizem a mesma coisa)", () => {
    expect(texto(filho(tokenizar("<OFX>\r\n<M>A & B\r\n</OFX>"), "OFX"), "M")).toBe("A & B");
    expect(texto(filho(tokenizar("<OFX><M>A &amp; B</M></OFX>"), "OFX"), "M")).toBe("A & B");
    // Entidade que não existe fica literal: `&NOME;` de descrição de banco é
    // texto que o Dono vai ler, não entidade a resolver.
    expect(texto(filho(tokenizar("<OFX><M>A &FOO; B</M></OFX>"), "OFX"), "M")).toBe("A &FOO; B");
  });

  it("CRLF, tabulação e padding de espaços não entram no valor", () => {
    const arvore = tokenizar("<OFX>\r\n<TRNAMT>\t          -530,86  \r\n</OFX>\r\n");
    expect(texto(filho(arvore, "OFX"), "TRNAMT")).toBe("-530,86");
  });

  it("folha VAZIA não engole a tag seguinte", () => {
    // A única ambiguidade real do SGML sem DTD. Se `<MEMO>` vazio virasse
    // agregado, o `<FITID>` seguinte cairia dentro dele e a transação perderia
    // a chave — falha silenciosa, a espécie que este módulo existe para não ter.
    const arvore = tokenizar("<OFX>\r\n<STMTTRN>\r\n<MEMO>\r\n<FITID>123\r\n</STMTTRN>\r\n</OFX>\r\n");
    const trn = filho(filho(arvore, "OFX"), "STMTTRN");
    expect(texto(trn, "FITID")).toBe("123");
  });

  it("fechamento de agregado que ninguém abriu é ignorado, não fatal", () => {
    const arvore = tokenizar("<OFX>\r\n</NADA>\r\n<A>1\r\n</OFX>\r\n");
    expect(texto(filho(arvore, "OFX"), "A")).toBe("1");
  });
});

describe("asArray", () => {
  it("um filho vira objeto, dois viram array — os dois sentidos no mesmo arquivo", () => {
    // `duas-contas.ofx` existe exatamente para isto: a primeira conta tem duas
    // transações (array) e a segunda tem uma só (objeto). Sem `asArray`, ou o
    // código quebra na conta com uma, ou perde a segunda transação da outra.
    const arvore = arvoreDe("duas-contas.ofx");
    const contas = filhos(filho(filho(arvore, "OFX"), "BANKMSGSRSV1"), "STMTTRNRS");
    expect(contas).toHaveLength(2);

    const listaDe = (i: number): No[] => filhos(filho(filho(contas[i], "STMTRS"), "BANKTRANLIST"), "STMTTRN");
    expect(listaDe(0)).toHaveLength(2);
    expect(listaDe(1)).toHaveLength(1);
  });

  it.each([
    [undefined, []],
    [null, []],
    ["a", ["a"]],
    [["a", "b"], ["a", "b"]],
    [[], []],
  ])("%s → %s", (entrada, esperado) => {
    expect(asArray(entrada)).toEqual(esperado);
  });
});

describe("acessores de nó", () => {
  it("texto devolve null para ausente, vazio e agregado", () => {
    const arvore = tokenizar("<OFX>\r\n<A>\r\n<B>x\r\n</A>\r\n<C>\r\n</C>\r\n</OFX>\r\n");
    const ofx = filho(arvore, "OFX");
    expect(texto(ofx, "NAOEXISTE")).toBeNull();
    expect(texto(ofx, "A")).toBeNull(); // agregado, não folha
    expect(texto(ofx, "C")).toBeNull(); // folha vazia
    expect(texto(undefined, "A")).toBeNull();
  });

  it("filho devolve undefined para ausente e para folha de texto", () => {
    const ofx = filho(tokenizar("<OFX>\r\n<A>x\r\n</OFX>\r\n"), "OFX");
    expect(filho(ofx, "A")).toBeUndefined();
    expect(filho(ofx, "NAOEXISTE")).toBeUndefined();
  });
});
