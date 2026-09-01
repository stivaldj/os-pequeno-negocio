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

describe("ingestores passam pela redação clínica", () => {
  for (const arquivo of INGESTORES) {
    it(`${arquivo} chama prepararEntradaDoContato e grava preparada.body`, () => {
      const fonte = readFileSync(arquivo, "utf8");
      expect(fonte, "sem chamada ao preparador").toContain("prepararEntradaDoContato(");
      expect(fonte, "body ainda vem do texto cru").toMatch(/body:\s*(preparada|entrada|input)\.body/);
    });
  }
});
