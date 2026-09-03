/**
 * Cabeçalho do OFX: o encoding sai do arquivo, não de quem chama.
 *
 * Cada caso aqui é um defeito medido em biblioteca de terceiro ou em extrato
 * brasileiro real — não há teste de forma.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { lerCabecalho } from "@/lib/financeiro/ofx/header";
import { OFX_MAX_BYTES } from "@/lib/financeiro/ofx/tipos";

/** Relativo à raiz do repo, como o resto da casa faz — o `vitest run` roda de lá. */
const FIXTURES = "tests/fixtures/ofx/";
const ler = (nome: string): Buffer => readFileSync(FIXTURES + nome);

const CABECALHO_MINIMO = [
  "OFXHEADER:100",
  "DATA:OFXSGML",
  "VERSION:102",
  "SECURITY:NONE",
  "ENCODING:USASCII",
  "CHARSET:1252",
  "",
].join("\r\n");

describe("lerCabecalho", () => {
  it("cp1252: o MEMO sai CARTÃO, não sujeira", () => {
    // O defeito da `ofx-js@1.1.1`: ela recebe `string`, então quem chama já
    // decidiu o encoding antes de o arquivo dizer qual é. `Ã` é UM byte (0xC3)
    // num arquivo `CHARSET:1252`; lido como utf-8 vira U+FFFD, e o Dono lê a
    // sujeira na tela do financeiro.
    const { corpo, charset } = lerCabecalho(ler("bradesco-like.ofx"));
    expect(charset).toBe("windows-1252");
    expect(corpo).toContain("PAGTO CARTÃO & COBRANÇA");
    expect(corpo).not.toContain("�");
  });

  it("linha em branco antes do OFXHEADER não confunde a versão (o Bradesco manda assim)", () => {
    const { versao } = lerCabecalho(ler("bradesco-like.ofx"));
    expect(versao).toBe("1");
  });

  it("OFX 2.x é reconhecido pela declaração XML e decodificado em utf-8", () => {
    const { versao, charset, corpo } = lerCabecalho(ler("ofx2.xml.ofx"));
    expect(versao).toBe("2");
    expect(charset).toBe("utf-8");
    expect(corpo).toContain("CARTÃO");
    // O corpo começa em `<OFX>` — a declaração XML e o `<?OFX?>` ficaram fora.
    expect(corpo.startsWith("<OFX>")).toBe(true);
  });

  it("CHARSET:NONE cai para o ENCODING declarado", () => {
    const cru =
      "OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nENCODING:UTF-8\r\nCHARSET:NONE\r\n\r\n<OFX>\r\n</OFX>\r\n";
    expect(lerCabecalho(Buffer.from(cru, "utf8")).charset).toBe("utf-8");
  });

  it("ISO-8859-1 também é resolvido (nem todo banco manda 1252)", () => {
    const cru = CABECALHO_MINIMO.replace("CHARSET:1252", "CHARSET:ISO-8859-1") + "\r\n<OFX>\r\n</OFX>\r\n";
    expect(lerCabecalho(Buffer.from(cru, "latin1")).charset).toBe("iso-8859-1");
  });

  it("come o BOM de UTF-8 sem levá-lo para dentro do corpo", () => {
    const cru = "OFXHEADER:100\r\nVERSION:102\r\nENCODING:UTF-8\r\n\r\n<OFX>\r\n<A>ã\r\n</OFX>\r\n";
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(cru, "utf8")]);
    const { charset, corpo } = lerCabecalho(buf);
    expect(charset).toBe("utf-8");
    expect(corpo).toContain("ã");
    expect(corpo).not.toContain("﻿");
  });

  it("arquivo maior que o teto é recusado com mensagem que ENSINA", () => {
    // Recusa aberta, no molde do `CSV_MAX_BYTES`: melhor que meia-leitura.
    const gigante = Buffer.alloc(OFX_MAX_BYTES + 1, 0x20);
    expect(() => lerCabecalho(gigante)).toThrow(/excede o teto/);
    expect(() => lerCabecalho(gigante)).toThrow(/período menor/);
  });

  it("arquivo sem <OFX> é recusado dizendo o que exportar no lugar", () => {
    // Quem exporta PDF ou CSV por engano precisa ler o que fazer, não um
    // "cannot read property of undefined".
    expect(() => lerCabecalho(Buffer.from("data,valor\n2026-01-01,10", "utf8"))).toThrow(
      /não parece um extrato OFX/,
    );
    expect(() => lerCabecalho(Buffer.from("%PDF-1.4", "utf8"))).toThrow(/não em PDF nem CSV/);
  });
});

describe("as fixtures têm os bytes que o teste precisa", () => {
  // Esta suíte guarda a entrada `tests/fixtures/ofx/*.ofx -text` do
  // `.gitattributes`. Sem ela, o git normaliza o CRLF no checkout e o teste de
  // tolerância a CRLF fica VERDE por vacuidade — um gate que não pode reprovar
  // não é gate. Se isto ficar vermelho: rode `node tests/fixtures/ofx/gerar.mjs`
  // e confira se a entrada do `.gitattributes` continua lá.
  it.each([
    "bradesco-like.ofx",
    "duas-contas.ofx",
    "caixa-decimal-quebrado.ofx",
    "fitid-repetido.ofx",
    "memo-com-sinal.ofx",
    "cartao.ofx",
    "ofx2.xml.ofx",
  ])("%s está em CRLF", (nome) => {
    expect(ler(nome).includes(Buffer.from("\r\n"))).toBe(true);
  });

  it("bradesco-like.ofx guarda Ã e Ç como UM byte cp1252, não como par utf-8", () => {
    const buf = ler("bradesco-like.ofx");
    expect(buf.includes(Buffer.from([0xc3]))).toBe(true); // Ã
    expect(buf.includes(Buffer.from([0xc7]))).toBe(true); // Ç
    // O par utf-8 de `Ã` é C3 83. Se ele estiver aqui, a fixture nasceu em
    // utf-8 e a asserção de acento passa por acaso, provando nada.
    expect(buf.includes(Buffer.from([0xc3, 0x83]))).toBe(false);
  });
});
