import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ads/relatorio", () => ({
  sobraPorRealDaConta: vi.fn(async (_a: unknown, _o: string, periodo: { de: string; ate: string }) => ({
    periodo,
    campanhas: [{ campaignId: "111", campaignName: "Busca", gastoCents: 8000, contatos: 2, vendas: 1, vendasSemMargem: 0, receitaCents: 20000, sobraCents: 12000, sobraPorReal: 1.5, diasSemGasto: periodo.de === "2026-08-04" ? ["2026-08-10"] : [], incompleto: periodo.de === "2026-08-04" }],
    total: { gastoCents: 8000, receitaCents: 20000, sobraCents: 12000, sobraPorReal: 1.5, incompleto: false },
  })),
}));

const { montarContexto, contextoEmTexto } = await import("@/lib/ads/agente/contexto");

const admin = {
  from: (t: string) => {
    const proxy: Record<string, unknown> = new Proxy({}, {
      get(_x, prop) {
        if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: t === "ad_spend" ? [{ campaign_id: "111", clicks: 10 }, { campaign_id: "111", clicks: 5 }] : [{ id: "p1", campaign_id: "111", kind: "orcamento", title: "Subir 20%", created_at: "2026-09-01T07:00:00Z" }], error: null });
        return () => proxy;
      },
    });
    return { select: () => proxy };
  },
} as never;

describe("montarContexto + contextoEmTexto", () => {
  it("duas janelas com sobra, cliques somados e propostas pendentes; texto sem dado pessoal", async () => {
    const ctx = await montarContexto(admin, "org-1", { agora: new Date("2026-09-03T07:00:00Z") });
    expect(ctx.janelas.map((j) => j.dias)).toEqual([7, 30]);
    expect(ctx.janelas[0]!.sobra.periodo).toEqual({ de: "2026-08-27", ate: "2026-09-02" });
    expect(ctx.janelas[1]!.sobra.periodo).toEqual({ de: "2026-08-04", ate: "2026-09-02" });
    expect(ctx.janelas[0]!.cliques).toEqual({ "111": 15 });
    const texto = contextoEmTexto(ctx);
    expect(texto).toContain("Últimos 7 dias");
    expect(texto).toContain("Sobra por Real 1.50 por real");
    expect(texto).toContain("INCOMPLETO");
    expect(texto).toContain("Subir 20%");
    expect(texto).not.toMatch(/\+55|Paciente/);
  });
});
