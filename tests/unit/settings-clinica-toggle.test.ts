import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { aplicarConfiguracaoClinica, configuracaoClinica } from "@/lib/clinica/config";
import { tenantSchema } from "@/lib/schemas/settings";

/**
 * O toggle "Conta do setor de saúde" (Fase 3, ADR-0004): o que a tela manda,
 * o que a action grava e o que o módulo clínico lê são o MESMO bit.
 */
const RAIZ = join(__dirname, "..", "..");

const BASE = {
  display_name: "Clínica Humana",
  legal_name: "Clínica Humana LTDA",
  timezone: "America/Sao_Paulo",
  locale: "pt-BR",
  currency: "BRL",
  media_retention_days: 90,
};

describe("tenantSchema.clinica_redacao", () => {
  it("aceita boolean", () => {
    const r = tenantSchema.safeParse({ ...BASE, clinica_redacao: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.clinica_redacao).toBe(true);
  });

  it("default é false — Conta comum não redige nada", () => {
    const r = tenantSchema.safeParse(BASE);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.clinica_redacao).toBe(false);
  });

  it("recusa string: 'true' não é true", () => {
    expect(tenantSchema.safeParse({ ...BASE, clinica_redacao: "true" }).success).toBe(false);
  });
});

describe("a action grava com o merge não destrutivo", () => {
  it("updateTenant usa aplicarConfiguracaoClinica no merge de settings", () => {
    // O merge é a função pura testada em lib/clinica/config.test.ts; aqui a
    // prova é que a action passa por ela, e não por um spread escrito à mão
    // que apagaria settings.clinica de outra fase.
    const fonte = readFileSync(join(RAIZ, "app/actions/settings/updateTenant.ts"), "utf8");
    expect(fonte).toMatch(/aplicarConfiguracaoClinica\(/);
    expect(fonte).toMatch(/clinica_redacao/);
  });

  it("o bit da tela chega inteiro ao leitor do módulo clínico", () => {
    const parsed = tenantSchema.parse({ ...BASE, clinica_redacao: true });
    const settings = aplicarConfiguracaoClinica(
      { lost_reasons_extra: ["x"], clinica: { outra: 1 } },
      { redacao: parsed.clinica_redacao },
    );
    expect(configuracaoClinica(settings)).toEqual({ redacao: true });
    expect(settings.lost_reasons_extra).toEqual(["x"]);
    expect((settings.clinica as Record<string, unknown>).outra).toBe(1);
  });
});

describe("a tela expõe o toggle", () => {
  it("_form.tsx tem o controle ligado a clinica_redacao, e page.tsx passa o valor atual", () => {
    const form = readFileSync(join(RAIZ, "app/app/settings/tenant/_form.tsx"), "utf8");
    expect(form).toMatch(/clinica_redacao/);
    const page = readFileSync(join(RAIZ, "app/app/settings/tenant/page.tsx"), "utf8");
    expect(page).toMatch(/configuracaoClinica\(/);
    expect(page).toMatch(/clinica_redacao/);
  });
});
