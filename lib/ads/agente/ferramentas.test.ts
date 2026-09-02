import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const { audit } = await import("@/lib/audit");
const { ferramentasDoAgente } = await import("@/lib/ads/agente/ferramentas");

const inserts: Record<string, unknown>[] = [];
const admin = {
  from: () => ({
    insert: (p: Record<string, unknown>) => {
      inserts.push(p);
      return { select: () => ({ single: async () => ({ data: { id: "prop-1" }, error: null }) }) };
    },
  }),
} as never;
const CONTA = { id: "conta-1", organization_id: "org-1", customer_id: "1234567890", autonomy_level: 1, budget_floor_cents: null, budget_ceiling_cents: null, max_cost_per_conversation_cents: null };
const CTX = { organizationId: "org-1", agora: "2026-09-03T07:00:00.000Z", janelas: [], propostasPendentes: [] };

type Exec = { execute: (args: unknown, opts: unknown) => Promise<unknown> };

beforeEach(() => {
  inserts.length = 0;
  vi.mocked(audit).mockClear();
});

describe("ferramentas do Agente de Anúncios", () => {
  it("propor grava em ad_proposals com o nível da Conta e audita", async () => {
    const estado = { propostas: [], recusas: [] };
    const tools = ferramentasDoAgente(admin, CONTA, CTX, estado, "req-1");
    const r = await (tools.propor as unknown as Exec).execute({ campaign_id: "111", kind: "orcamento", title: "Subir 20%", body: "Sobra por Real de 2,3 nos 7 dias, com teto folgado." }, {});
    expect(r).toEqual({ gravada: true, id: "prop-1" });
    expect(inserts[0]).toMatchObject({ organization_id: "org-1", campaign_id: "111", kind: "orcamento", level: 1, title: "Subir 20%" });
    expect(estado.propostas).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ads.proposta_criada", metadata: expect.objectContaining({ autonomy_level: 1 }) }));
  });

  it("nível 1: as escritas recusam, auditam com o nível e nada vai ao Google", async () => {
    const estado = { propostas: [], recusas: [] };
    const tools = ferramentasDoAgente(admin, CONTA, CTX, estado, "req-1");
    const r1 = await (tools.ajustar_orcamento as unknown as Exec).execute({ campaign_id: "111", novo_orcamento_cents: 5000 }, {});
    const r2 = await (tools.pausar_campanha as unknown as Exec).execute({ campaign_id: "111", motivo: "caro" }, {});
    expect(r1).toMatchObject({ recusado: true, motivo: "nivel_insuficiente", nivel: 1 });
    expect(r2).toMatchObject({ recusado: true });
    expect(estado.recusas).toEqual([{ acao: "orcamento", campaign_id: "111" }, { acao: "pausar", campaign_id: "111" }]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ads.escrita_recusada", metadata: expect.objectContaining({ acao: "orcamento", autonomy_level: 1 }) }));
    expect(inserts).toHaveLength(0);
  });

  it("nível 2: orçamento passa pelo gate (e nesta fase ainda não aplica)", async () => {
    const tools = ferramentasDoAgente(admin, { ...CONTA, autonomy_level: 2 }, CTX, { propostas: [], recusas: [] }, "req-1");
    const r = await (tools.ajustar_orcamento as unknown as Exec).execute({ campaign_id: "111", novo_orcamento_cents: 5000 }, {});
    expect(r).toEqual({ aplicado: false, motivo: "escrita_chega_na_fase_8" });
  });
});
