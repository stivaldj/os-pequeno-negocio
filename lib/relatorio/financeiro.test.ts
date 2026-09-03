import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/financeiro/relatorio", () => ({ caixaDaConta: vi.fn(), vencimentosDaConta: vi.fn() }));

import { caixaDaConta, vencimentosDaConta } from "@/lib/financeiro/relatorio";

import { financeiroDeHoje } from "./financeiro";
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

describe("financeiroDeHoje", () => {
  it("caixaTotalCents null (incompleto) nunca vira zero", async () => {
    vi.mocked(caixaDaConta).mockResolvedValue({ contas: [], totalCents: null, incompleto: true });
    vi.mocked(vencimentosDaConta).mockResolvedValue({
      hoje: JANELA.hoje,
      vencemHoje: { itens: [], totalCents: { payable: 0, receivable: 0 } },
      vencidas: { itens: [], totalCents: { payable: 0, receivable: 0 } },
      proximos7: { itens: [], totalCents: { payable: 0, receivable: 0 } },
    });
    const r = await financeiroDeHoje({} as never, JANELA);
    expect(r.caixaTotalCents).toBeNull();
    expect(r.incompleto).toBe(true);
    expect(vencimentosDaConta).toHaveBeenCalledWith(expect.anything(), "org-1", "2026-09-03");
  });

  it("soma vencidos e vence-hoje separados por direção, e traz a descrição de cada item — não só a contagem", async () => {
    vi.mocked(caixaDaConta).mockResolvedValue({ contas: [], totalCents: 500_000, incompleto: false });
    vi.mocked(vencimentosDaConta).mockResolvedValue({
      hoje: JANELA.hoje,
      vencemHoje: {
        itens: [{ id: "o1", direction: "payable", description: "Aluguel", amountCents: 10_000, dueOn: "2026-09-03", status: "open" }],
        totalCents: { payable: 10_000, receivable: 0 },
      },
      vencidas: { itens: [], totalCents: { payable: 0, receivable: 5_000 } },
      proximos7: { itens: [], totalCents: { payable: 0, receivable: 0 } },
    });
    const r = await financeiroDeHoje({} as never, JANELA);
    expect(r).toEqual({
      caixaTotalCents: 500_000,
      vencemHojeCents: { payable: 10_000, receivable: 0 },
      vencidasCents: { payable: 0, receivable: 5_000 },
      vencemHojeItens: [{ description: "Aluguel", amountCents: 10_000, direction: "payable", dueOn: "2026-09-03" }],
      vencidasItens: [],
      incompleto: false,
    });
  });
});
