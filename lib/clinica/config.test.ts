import { describe, expect, it } from "vitest";

import { aplicarConfiguracaoClinica, configuracaoClinica } from "./config";

describe("configuracaoClinica", () => {
  it("lê settings.clinica.redacao_clinica === true", () => {
    expect(configuracaoClinica({ clinica: { redacao_clinica: true } })).toEqual({ redacao: true });
  });

  it("qualquer outra coisa é desligado: ausente, null, string, número", () => {
    expect(configuracaoClinica(null)).toEqual({ redacao: false });
    expect(configuracaoClinica(undefined)).toEqual({ redacao: false });
    expect(configuracaoClinica({})).toEqual({ redacao: false });
    expect(configuracaoClinica({ clinica: null })).toEqual({ redacao: false });
    expect(configuracaoClinica({ clinica: "sim" })).toEqual({ redacao: false });
    expect(configuracaoClinica({ clinica: { redacao_clinica: "true" } })).toEqual({ redacao: false });
    expect(configuracaoClinica({ clinica: { redacao_clinica: 1 } })).toEqual({ redacao: false });
    expect(configuracaoClinica({ clinica: { redacao_clinica: false } })).toEqual({ redacao: false });
  });
});

describe("aplicarConfiguracaoClinica", () => {
  it("liga a redação sem apagar as outras chaves de settings nem de settings.clinica", () => {
    const antes = {
      lost_reasons_extra: ["Sem orçamento"],
      ai_dispatch_mode: "native",
      clinica: { outra_chave: "fica", redacao_clinica: false },
    };
    const depois = aplicarConfiguracaoClinica(antes, { redacao: true });
    expect(depois).toEqual({
      lost_reasons_extra: ["Sem orçamento"],
      ai_dispatch_mode: "native",
      clinica: { outra_chave: "fica", redacao_clinica: true },
    });
    // não muta a entrada
    expect(antes.clinica.redacao_clinica).toBe(false);
  });

  it("desliga sem perder as outras chaves", () => {
    const depois = aplicarConfiguracaoClinica(
      { clinica: { redacao_clinica: true, x: 1 }, y: 2 },
      { redacao: false },
    );
    expect(depois).toEqual({ clinica: { redacao_clinica: false, x: 1 }, y: 2 });
  });

  it("settings null ou sem clinica nasce com o bloco", () => {
    expect(aplicarConfiguracaoClinica(null, { redacao: true })).toEqual({
      clinica: { redacao_clinica: true },
    });
    expect(aplicarConfiguracaoClinica({ a: 1 }, { redacao: false })).toEqual({
      a: 1,
      clinica: { redacao_clinica: false },
    });
  });

  it("clinica que não é objeto é substituída pelo bloco, sem quebrar", () => {
    expect(aplicarConfiguracaoClinica({ clinica: "lixo" }, { redacao: true })).toEqual({
      clinica: { redacao_clinica: true },
    });
  });

  it("o que grava é o que se lê de volta", () => {
    const gravado = aplicarConfiguracaoClinica({ clinica: { z: 0 } }, { redacao: true });
    expect(configuracaoClinica(gravado)).toEqual({ redacao: true });
  });
});
