import { describe, expect, it } from "vitest";
import { nivelValido, podeEscrever, type AcaoDeEscrita } from "@/lib/ads/agente/niveis";

const ACOES: AcaoDeEscrita[] = ["orcamento", "pausar", "anuncio", "palavra_chave"];

describe("podeEscrever — os 3 níveis × 4 ações", () => {
  it("nível 1 nunca escreve", () => {
    for (const a of ACOES) expect(podeEscrever({ autonomy_level: 1 }, a), a).toBe(false);
  });
  it("nível 2 só orçamento e pausar", () => {
    expect(podeEscrever({ autonomy_level: 2 }, "orcamento")).toBe(true);
    expect(podeEscrever({ autonomy_level: 2 }, "pausar")).toBe(true);
    expect(podeEscrever({ autonomy_level: 2 }, "anuncio")).toBe(false);
    expect(podeEscrever({ autonomy_level: 2 }, "palavra_chave")).toBe(false);
  });
  it("nível 3 tudo", () => {
    for (const a of ACOES) expect(podeEscrever({ autonomy_level: 3 }, a), a).toBe(true);
  });
  it("nível desconhecido vale 1 — errar para o lado seguro", () => {
    expect(nivelValido(undefined)).toBe(1);
    expect(nivelValido("3")).toBe(1);
    expect(podeEscrever({ autonomy_level: 9 }, "orcamento")).toBe(false);
  });
});
