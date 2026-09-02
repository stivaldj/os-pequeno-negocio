/**
 * Todo ingestor de ENTRADA passa pelo preparador de Conteúdo Clínico antes de
 * gravar (ADR-0004). Cinco pontos gravam `messages.body` a partir do texto do
 * Contato; um que esqueça a chamada volta a persistir sintoma e medicação —
 * e nenhum teste de banco pega, porque o texto cru é DDL válida.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const INGESTORES = [
  "lib/channels/meta/ingest.ts",
  "lib/channels/fake/ingest.ts",
  "lib/channels/meta/coexistencia/gravar.ts",
  "lib/channels/zernio/ingest.ts",
  "lib/waha/ingest.ts",
];

/**
 * Os QUATRO que chamam `aplicarEfeitosPosEntrada` entregam o Código de Clique
 * (ADR-0016) que o preparador extraiu do texto cru. O eco da coexistência
 * (`gravar.ts`) fica de fora de propósito: é histórico e mensagem do app, e
 * consumir código em mensagem antiga gastaria cliques de outra época.
 */
const INGESTORES_COM_EFEITOS = INGESTORES.filter((a) => !a.endsWith("coexistencia/gravar.ts"));

describe("ingestores passam pela redação clínica", () => {
  for (const arquivo of INGESTORES) {
    it(`${arquivo} chama prepararEntradaDoContato e grava preparada.body`, () => {
      const fonte = readFileSync(arquivo, "utf8");
      expect(fonte, "sem chamada ao preparador").toContain("prepararEntradaDoContato(");
      expect(fonte, "body ainda vem do texto cru").toMatch(/body:\s*(preparada|entrada|input)\.body/);
    });
  }
});

describe("ingestores entregam o Código de Clique aos efeitos pós-entrada", () => {
  for (const arquivo of INGESTORES_COM_EFEITOS) {
    it(`${arquivo} passa codigoDeClique: preparada.codigoDeClique`, () => {
      const fonte = readFileSync(arquivo, "utf8");
      expect(fonte, "chama os efeitos pós-entrada").toContain("aplicarEfeitosPosEntrada(");
      expect(fonte, "o código do preparador não chega aos efeitos").toMatch(/codigoDeClique:\s*preparada(\?\.|\.)codigoDeClique/);
    });
  }

  it("o eco da coexistência NÃO consome código (mensagem antiga não gasta clique)", () => {
    const fonte = readFileSync("lib/channels/meta/coexistencia/gravar.ts", "utf8");
    expect(fonte).not.toContain("codigoDeClique");
  });
});
