import { describe, expect, it } from "vitest";

import { fusoDaConta, janelaDoRelatorio } from "./janela";

function adminComFuso(timezone: string | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { timezone }, error: null }),
        }),
      }),
    }),
  } as never;
}

describe("fusoDaConta", () => {
  it("usa o fuso da organização quando é válido", async () => {
    expect(await fusoDaConta(adminComFuso("America/Cuiaba"), "org-1")).toBe("America/Cuiaba");
  });

  it("degrada para o padrão quando o valor é inválido, vazio ou ausente", async () => {
    expect(await fusoDaConta(adminComFuso("não-é-um-fuso"), "org-1")).toBe("America/Sao_Paulo");
    expect(await fusoDaConta(adminComFuso(""), "org-1")).toBe("America/Sao_Paulo");
    expect(await fusoDaConta(adminComFuso(null), "org-1")).toBe("America/Sao_Paulo");
  });
});

describe("janelaDoRelatorio", () => {
  it("hoje/ontem batem com o fuso, e a janela de hoje cobre exatamente o dia local", async () => {
    // 2026-09-03T02:00:00Z é 2026-09-02 23:00 em São Paulo (-3): ainda é 02/09 lá.
    const agora = new Date("2026-09-03T02:00:00Z");
    const j = await janelaDoRelatorio(adminComFuso("America/Sao_Paulo"), "org-1", agora);
    expect(j.hoje).toBe("2026-09-02");
    expect(j.ontem).toBe("2026-09-01");
    // Início de hoje em SP (-3) é 2026-09-02T03:00:00Z; fim é 2026-09-03T03:00:00Z.
    expect(j.hojeInicioISO).toBe("2026-09-02T03:00:00.000Z");
    expect(j.hojeFimISO).toBe("2026-09-03T03:00:00.000Z");
    expect(j.ontemInicioISO).toBe("2026-09-01T03:00:00.000Z");
  });

  it("a janela de ontem termina exatamente onde a de hoje começa — sem buraco nem sobreposição", async () => {
    const agora = new Date("2026-01-15T18:00:00Z");
    const j = await janelaDoRelatorio(adminComFuso("America/Sao_Paulo"), "org-1", agora);
    expect(j.ontemInicioISO < j.hojeInicioISO).toBe(true);
    expect(j.hojeInicioISO < j.hojeFimISO).toBe(true);
  });
});
