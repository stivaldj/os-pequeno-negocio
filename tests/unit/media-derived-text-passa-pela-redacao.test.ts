/**
 * Quem grava `messages.media_derived_text` (transcrição de áudio, OCR, visão)
 * passa pelo preparador de Conteúdo Clínico antes (ADR-0004, ADR-0019).
 *
 * A coluna é lida pelo contexto do lead como se fosse o texto do Contato; um
 * escritor que a preencha com a transcrição crua persiste sintoma e medicação
 * pela porta dos fundos — e nenhum teste de banco pega, porque texto cru é
 * texto válido. Mesma cerca de `ingestores-passam-pela-redacao.test.ts`, mas
 * sem lista fixa: a varredura acha o escritor onde ele estiver (`lib/`, `app/`
 * e `workers/`, que é onde o worker herdado do upstream vive).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZES = ["lib", "app", "workers"];

function arquivosFonte(dir: string): string[] {
  const saida: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      if (nome === "node_modules") continue;
      saida.push(...arquivosFonte(caminho));
      continue;
    }
    if (!/\.tsx?$/.test(nome) || /\.test\.tsx?$/.test(nome)) continue;
    saida.push(caminho);
  }
  return saida;
}

/**
 * "Escreve" = a coluna aparece dentro de um `.update({...})` / `.insert({...})`
 * / `.upsert({...})` do cliente Supabase, ou num `update ... set` / `insert into`
 * em SQL cru. Ler a coluna num `select` (get-lead-context, drain) não casa.
 */
const ESCRITA_SUPABASE = /\.(update|insert|upsert)\(\s*\{[^}]*\bmedia_derived_text\b/s;
const ESCRITA_SQL = /\b(update\s+(public\.)?messages\b[\s\S]*?\bset\b[\s\S]*?\bmedia_derived_text\b|insert\s+into\s+(public\.)?messages\b[^;]*\bmedia_derived_text\b)/i;

function escreveMediaDerivedText(fonte: string): boolean {
  return ESCRITA_SUPABASE.test(fonte) || ESCRITA_SQL.test(fonte);
}

describe("quem grava media_derived_text passa pela redação clínica", () => {
  const fontes = RAIZES.flatMap(arquivosFonte);
  const escritores = fontes.filter((f) => escreveMediaDerivedText(readFileSync(f, "utf8")));

  it("a varredura enxerga o worker de derivação (senão a cerca está cega)", () => {
    expect(escritores).toContain(join("workers", "media-derive-worker.ts"));
  });

  for (const arquivo of escritores) {
    it(`${arquivo} chama prepararEntradaDoContato e grava preparada.body`, () => {
      const fonte = readFileSync(arquivo, "utf8");
      expect(fonte, "sem chamada ao preparador").toContain("prepararEntradaDoContato(");
      expect(fonte, "media_derived_text ainda vem do texto cru").toMatch(
        /media_derived_text:\s*(preparada|entrada|derivada)\.body/,
      );
    });
  }
});
