import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ads/relatorio", () => ({ sobraPorRealDaConta: vi.fn() }));

import { sobraPorRealDaConta } from "@/lib/ads/relatorio";

import { adsDeOntem } from "./ads";
import type { JanelaDoRelatorio } from "./janela";

const JANELA: JanelaDoRelatorio = {
  organizationId: "org-1",
  fuso: "America/Sao_Paulo",
  hoje: "2026-09-03",
  ontem: "2026-09-02",
  hojeInicioISO: "2026-09-03T03:00:00.000Z",
  hojeFimISO: "2026-09-04T03:00:00.000Z",
  ontemInicioISO: "2026-09-02T03:00:00.000Z",
};

function adminComPropostas(linhas: unknown[]) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: async () => ({ data: linhas, error: null }),
            }),
          }),
        }),
      }),
    }),
  } as never;
}

describe("adsDeOntem", () => {
  it("pede o período DE ONTEM a sobraPorRealDaConta, nunca hoje", async () => {
    vi.mocked(sobraPorRealDaConta).mockResolvedValue({
      periodo: { de: JANELA.ontem, ate: JANELA.ontem },
      campanhas: [],
      total: { gastoCents: 0, receitaCents: 0, sobraCents: 0, sobraPorReal: null, incompleto: false },
    });
    await adsDeOntem(adminComPropostas([]), JANELA);
    expect(sobraPorRealDaConta).toHaveBeenCalledWith(expect.anything(), "org-1", { de: "2026-09-02", ate: "2026-09-02" });
  });

  it("repassa o incompleto por campanha e o total, sem recalcular nada", async () => {
    vi.mocked(sobraPorRealDaConta).mockResolvedValue({
      periodo: { de: JANELA.ontem, ate: JANELA.ontem },
      campanhas: [
        { campaignId: "111", campaignName: "Busca", gastoCents: 8000, contatos: 1, vendas: 1, vendasSemMargem: 0, receitaCents: 12000, sobraCents: 4000, sobraPorReal: 0.5, diasSemGasto: [], incompleto: false },
        { campaignId: "222", campaignName: null, gastoCents: 0, contatos: 0, vendas: 0, vendasSemMargem: 0, receitaCents: 0, sobraCents: 0, sobraPorReal: null, diasSemGasto: ["2026-09-02"], incompleto: true },
      ],
      total: { gastoCents: 8000, receitaCents: 12000, sobraCents: 4000, sobraPorReal: 0.5, incompleto: true },
    });
    const r = await adsDeOntem(adminComPropostas([{ id: "p1", title: "Suba o orçamento", kind: "orcamento" }]), JANELA);
    expect(r.incompleto).toBe(true);
    expect(r.gastoTotalCents).toBe(8000);
    expect(r.campanhas[1]!.incompleto).toBe(true);
    expect(r.propostasPendentes).toEqual([{ id: "p1", title: "Suba o orçamento", kind: "orcamento" }]);
  });
});
