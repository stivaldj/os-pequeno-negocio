import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { aplicarConfiguracaoDoDono, whatsappDoDono } from "@/lib/dono/config";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { tenantSchema } from "@/lib/schemas/settings";

/**
 * O campo "WhatsApp do Dono" (Fase 5): o que a tela manda, o que a action
 * grava em `settings.dono.whatsapp` e o que `lib/dono/` lê são o MESMO número.
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

describe("tenantSchema.dono_whatsapp", () => {
  it("aceita E.164", () => {
    const r = tenantSchema.safeParse({ ...BASE, dono_whatsapp: "+5511999999999" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.dono_whatsapp).toBe("+5511999999999");
  });

  it("vazio vira null (o campo foi limpo na tela); ausente é aceito", () => {
    const vazio = tenantSchema.safeParse({ ...BASE, dono_whatsapp: "" });
    expect(vazio.success).toBe(true);
    if (vazio.success) expect(vazio.data.dono_whatsapp).toBeNull();
    expect(tenantSchema.safeParse(BASE).success).toBe(true);
    expect(tenantSchema.safeParse({ ...BASE, dono_whatsapp: null }).success).toBe(true);
  });

  it("recusa o que não é E.164: sem +, com máscara, com espaço", () => {
    expect(tenantSchema.safeParse({ ...BASE, dono_whatsapp: "5511999999999" }).success).toBe(false);
    expect(tenantSchema.safeParse({ ...BASE, dono_whatsapp: "(11) 99999-9999" }).success).toBe(false);
    expect(tenantSchema.safeParse({ ...BASE, dono_whatsapp: "+55 11 99999 9999" }).success).toBe(false);
  });
});

describe("a action grava com o merge não destrutivo", () => {
  it("updateTenant usa aplicarConfiguracaoDoDono no merge de settings", () => {
    const fonte = readFileSync(join(RAIZ, "app/actions/settings/updateTenant.ts"), "utf8");
    expect(fonte).toMatch(/aplicarConfiguracaoDoDono\(/);
    expect(fonte).toMatch(/dono_whatsapp/);
  });

  it("o número da tela chega inteiro ao leitor de lib/dono", () => {
    const parsed = tenantSchema.parse({ ...BASE, dono_whatsapp: "+5511999999999" });
    const settings = aplicarConfiguracaoDoDono(
      { lost_reasons_extra: ["x"], clinica: { redacao_clinica: true }, dono: { outra: 1 } },
      { whatsapp: parsed.dono_whatsapp ?? null },
    );
    expect(whatsappDoDono(settings)).toBe("+5511999999999");
    expect(settings.lost_reasons_extra).toEqual(["x"]);
    expect(settings.clinica).toEqual({ redacao_clinica: true });
    expect((settings.dono as Record<string, unknown>).outra).toBe(1);
  });
});

describe("a tela expõe o campo", () => {
  it("_form.tsx tem o campo ligado a dono_whatsapp, e page.tsx passa o valor atual", () => {
    const form = readFileSync(join(RAIZ, "app/app/settings/tenant/_form.tsx"), "utf8");
    expect(form).toMatch(/dono_whatsapp/);
    expect(form).toMatch(/t\("WhatsApp do Dono"\)/);
    const page = readFileSync(join(RAIZ, "app/app/settings/tenant/page.tsx"), "utf8");
    expect(page).toMatch(/whatsappDoDono\(/);
    expect(page).toMatch(/dono_whatsapp/);
  });

  it("o rótulo tem espanhol", () => {
    expect(DICIONARIO["WhatsApp do Dono"]?.es).toBeTruthy();
  });
});
