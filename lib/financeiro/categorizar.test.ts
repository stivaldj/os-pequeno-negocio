import { describe, expect, it } from "vitest";

import { categoriaDe, type Categoria } from "./categorizar";

const FARMACIA: Categoria = { id: "cat-farmacia", slug: "farmacia", match_terms: ["FARMÁCIA", "DROGARIA"] };
const ALUGUEL: Categoria = { id: "cat-aluguel", slug: "aluguel", match_terms: ["ALUGUEL"] };

describe("categoriaDe", () => {
  it("casa sem acento e sem caixa, nos dois sentidos", () => {
    // Termo acentuado × descrição sem acento (o mesmo banco manda os dois).
    expect(categoriaDe("PAGTO FARMACIA CENTRO", [FARMACIA])).toBe("cat-farmacia");
    // Descrição acentuada × termo sem acento.
    expect(categoriaDe("COMPRA FARMÁCIA", [{ ...FARMACIA, match_terms: ["farmacia"] }])).toBe("cat-farmacia");
    expect(categoriaDe("débito drogaria pague menos", [FARMACIA])).toBe("cat-farmacia");
  });

  it("casa por substring: a descrição do banco vem colada", () => {
    expect(categoriaDe("PAGTOFARMACIA01", [FARMACIA])).toBe("cat-farmacia");
  });

  it("devolve null quando nada casa", () => {
    expect(categoriaDe("TARIFA PACOTE SERVICOS", [FARMACIA, ALUGUEL])).toBeNull();
    expect(categoriaDe("QUALQUER COISA", [])).toBeNull();
    expect(categoriaDe("", [FARMACIA])).toBeNull();
  });

  it("empate é resolvido pelo slug em ordem alfabética, não pela ordem do select", () => {
    // As duas casam "ALUGUEL". O `select` do Postgres não promete ordem: se a
    // classificação dependesse dela, o mesmo lançamento cairia em categorias
    // diferentes entre duas importações do MESMO arquivo.
    const a: Categoria = { id: "cat-a", slug: "aluguel-sala", match_terms: ["ALUGUEL"] };
    const z: Categoria = { id: "cat-z", slug: "zeladoria", match_terms: ["ALUGUEL"] };
    expect(categoriaDe("ALUGUEL SETEMBRO", [z, a])).toBe("cat-a");
    expect(categoriaDe("ALUGUEL SETEMBRO", [a, z])).toBe("cat-a");
    // E não mexe no array do chamador (que é o `data` do select).
    const lista = [z, a];
    categoriaDe("ALUGUEL SETEMBRO", lista);
    expect(lista[0]).toBe(z);
  });

  it("termo vazio não casa com tudo", () => {
    // Categoria mal cadastrada não pode virar o destino do Extrato inteiro:
    // "".includes é verdadeiro em toda descrição.
    const vazia: Categoria = { id: "cat-vazia", slug: "aaa-vazia", match_terms: ["", "   "] };
    expect(categoriaDe("TARIFA PACOTE SERVICOS", [vazia])).toBeNull();
    expect(categoriaDe("ALUGUEL SETEMBRO", [vazia, ALUGUEL])).toBe("cat-aluguel");
  });

  it("categoria sem termos nenhum não casa", () => {
    expect(categoriaDe("ALUGUEL", [{ id: "x", slug: "aaa", match_terms: [] }])).toBeNull();
  });
});
