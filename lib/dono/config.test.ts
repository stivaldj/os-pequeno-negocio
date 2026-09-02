import { describe, expect, it } from "vitest";

import { aplicarConfiguracaoDoDono, ehWhatsappValido, whatsappDoDono } from "./config";

describe("ehWhatsappValido", () => {
  it("aceita E.164: + e 8 a 15 dígitos, sem zero à esquerda", () => {
    expect(ehWhatsappValido("+5511999999999")).toBe(true);
    expect(ehWhatsappValido("+12125551234")).toBe(true);
    expect(ehWhatsappValido("+12345678")).toBe(true);
  });

  it("recusa o que não é E.164: sem +, com espaço, com zero inicial, curto ou longo demais", () => {
    expect(ehWhatsappValido("5511999999999")).toBe(false);
    expect(ehWhatsappValido("+55 11 99999-9999")).toBe(false);
    expect(ehWhatsappValido("+0511999999999")).toBe(false);
    expect(ehWhatsappValido("+1234567")).toBe(false);
    expect(ehWhatsappValido("+1234567890123456")).toBe(false);
    expect(ehWhatsappValido("")).toBe(false);
  });
});

describe("whatsappDoDono", () => {
  it("lê settings.dono.whatsapp quando é E.164", () => {
    expect(whatsappDoDono({ dono: { whatsapp: "+5511999999999" } })).toBe("+5511999999999");
  });

  it("qualquer outra forma é null: ausente, null, bloco inválido, número inválido", () => {
    expect(whatsappDoDono(null)).toBeNull();
    expect(whatsappDoDono(undefined)).toBeNull();
    expect(whatsappDoDono({})).toBeNull();
    expect(whatsappDoDono({ dono: null })).toBeNull();
    expect(whatsappDoDono({ dono: "sim" })).toBeNull();
    expect(whatsappDoDono({ dono: [] })).toBeNull();
    expect(whatsappDoDono({ dono: { whatsapp: null } })).toBeNull();
    expect(whatsappDoDono({ dono: { whatsapp: 5511999999999 } })).toBeNull();
    expect(whatsappDoDono({ dono: { whatsapp: "11 99999-9999" } })).toBeNull();
  });
});

describe("aplicarConfiguracaoDoDono", () => {
  it("grava o WhatsApp sem apagar as outras chaves de settings nem de settings.dono", () => {
    const antes = {
      lost_reasons_extra: ["Sem orçamento"],
      clinica: { redacao_clinica: true },
      dono: { outra_chave: "fica", whatsapp: null },
    };
    const depois = aplicarConfiguracaoDoDono(antes, { whatsapp: "+5511999999999" });
    expect(depois).toEqual({
      lost_reasons_extra: ["Sem orçamento"],
      clinica: { redacao_clinica: true },
      dono: { outra_chave: "fica", whatsapp: "+5511999999999" },
    });
    // não muta a entrada
    expect(antes.dono.whatsapp).toBeNull();
  });

  it("apaga com null sem perder as outras chaves", () => {
    const depois = aplicarConfiguracaoDoDono(
      { dono: { whatsapp: "+5511999999999", x: 1 }, y: 2 },
      { whatsapp: null },
    );
    expect(depois).toEqual({ dono: { whatsapp: null, x: 1 }, y: 2 });
  });

  it("settings null ou sem dono nasce com o bloco", () => {
    expect(aplicarConfiguracaoDoDono(null, { whatsapp: "+5511999999999" })).toEqual({
      dono: { whatsapp: "+5511999999999" },
    });
    expect(aplicarConfiguracaoDoDono({ a: 1 }, { whatsapp: null })).toEqual({
      a: 1,
      dono: { whatsapp: null },
    });
  });

  it("dono que não é objeto é substituído pelo bloco, sem quebrar", () => {
    expect(aplicarConfiguracaoDoDono({ dono: "lixo" }, { whatsapp: "+5511999999999" })).toEqual({
      dono: { whatsapp: "+5511999999999" },
    });
  });

  it("o que grava é o que se lê de volta", () => {
    const gravado = aplicarConfiguracaoDoDono({ dono: { z: 0 } }, { whatsapp: "+5511999999999" });
    expect(whatsappDoDono(gravado)).toBe("+5511999999999");
  });
});
