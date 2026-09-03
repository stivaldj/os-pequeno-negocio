import { describe, expect, it } from "vitest";

import { atendimentosDaNoite } from "./atendimentos";
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

function adminComRpc(resposta: { data: unknown; error: { message: string } | null }) {
  return { rpc: async () => resposta } as never;
}

describe("atendimentosDaNoite", () => {
  it("lê escopo.demandas e cliente.pedidos_de_humano de fn_atrito_metrics", async () => {
    const admin = adminComRpc({
      data: { escopo: { demandas: 12 }, cliente: { pedidos_de_humano: 3 } },
      error: null,
    });
    const r = await atendimentosDaNoite(admin, JANELA);
    expect(r).toEqual({ atendidos: 12, passadosParaHumano: 3, incompleto: false });
  });

  it("RPC com erro vira seção incompleta, nunca zero disfarçado", async () => {
    const admin = adminComRpc({ data: null, error: { message: "boom" } });
    const r = await atendimentosDaNoite(admin, JANELA);
    expect(r.incompleto).toBe(true);
    expect(r.atendidos).toBe(0);
  });

  it("payload sem os campos esperados também vira incompleto", async () => {
    const admin = adminComRpc({ data: { escopo: {} }, error: null });
    const r = await atendimentosDaNoite(admin, JANELA);
    expect(r.incompleto).toBe(true);
  });
});
