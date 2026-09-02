import { describe, expect, it } from "vitest";
import { classificarConteudoClinico } from "@/lib/clinica/classificar";
import { CLINICOS, NAO_CLINICOS } from "@/lib/clinica/corpus";

describe("classificarConteudoClinico", () => {
  it("reconhece todo o corpus clínico, com motivo", () => {
    const falhas = CLINICOS.filter((f) => {
      const r = classificarConteudoClinico(f);
      return !(r.clinico && ["sintoma", "condicao", "medicacao"].includes(String(r.motivo)));
    });
    expect(falhas).toEqual([]);
  });

  it("deixa passar todo o corpus não clínico — escolher especialidade não é Conteúdo Clínico", () => {
    const falhas = NAO_CLINICOS.filter((f) => classificarConteudoClinico(f).clinico);
    expect(falhas).toEqual([]);
  });

  it("é indiferente a caixa e acento", () => {
    expect(classificarConteudoClinico("FEBRE").clinico).toBe(true);
    expect(classificarConteudoClinico("fébre").clinico).toBe(true);
    expect(classificarConteudoClinico("Tomo LOSARTANA").motivo).toBe("medicacao");
  });

  it("é pura e determinística", () => {
    const a = classificarConteudoClinico("tô com dor no peito");
    const b = classificarConteudoClinico("tô com dor no peito");
    expect(a).toEqual(b);
  });

  it("texto vazio ou nulo não é clínico", () => {
    expect(classificarConteudoClinico("").clinico).toBe(false);
    expect(classificarConteudoClinico(null).clinico).toBe(false);
  });

  it("termos devolvidos são chaves do léxico, para uso em memória", () => {
    const r = classificarConteudoClinico("tomo losartana 50mg");
    expect(r.termos.length).toBeGreaterThan(0);
    expect(r.termos.join(" ")).not.toContain("tomo");
  });
});
