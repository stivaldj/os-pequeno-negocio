import { beforeEach, describe, expect, it, vi } from "vitest";

const chamadas: unknown[] = [];
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({
  tool: (d: unknown) => d,
  LlmBudgetExceededError: class LlmBudgetExceededError extends Error {
    constructor() {
      super("teto");
    }
  },
  runModelCall: vi.fn(async (_pool: unknown, _cfg: unknown, input: { tools: Record<string, { execute: (a: unknown, o: unknown) => Promise<unknown> }> }) => {
    chamadas.push(input);
    // O modelo falso tenta escrever (deve ser recusado) e depois propõe.
    await input.tools.ajustar_orcamento!.execute({ campaign_id: "111", novo_orcamento_cents: 9000 }, {});
    await input.tools.propor!.execute({ campaign_id: "111", kind: "orcamento", title: "Subir orçamento da Busca em 20%", body: "Sobra por Real 2,25 nos 7 dias; 2 consultas pagas." }, {});
    return { result: { text: "Busca está saudável; proponho subir 20%." } };
  }),
}));
vi.mock("@/lib/dono/destinatario", () => ({ enviarAoDono: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/ads/agente/contexto", () => ({
  montarContexto: vi.fn(async () => ({ organizationId: "org-1", agora: "2026-09-03T07:00:00.000Z", janelas: [], propostasPendentes: [] })),
  contextoEmTexto: () => "contexto",
}));

const { runModelCall, LlmBudgetExceededError } = await import("@/lib/agent-engine/edge/llm/run-model-call");
const { enviarAoDono } = await import("@/lib/dono/destinatario");
const { audit } = await import("@/lib/audit");
const { rodarAgenteDeAnuncios } = await import("@/lib/ads/agente/rodar");

const inserts: { tabela: string; payload: Record<string, unknown> }[] = [];
const admin = {
  from: (tabela: string) => ({
    insert: (p: Record<string, unknown>) => {
      inserts.push({ tabela, payload: p });
      return { select: () => ({ single: async () => ({ data: { id: "prop-1" }, error: null }) }), then: (ok: (v: unknown) => unknown) => ok({ error: null }) };
    },
  }),
} as never;
const CONTA = { id: "conta-1", organization_id: "org-1", customer_id: "1234567890", autonomy_level: 1, budget_floor_cents: null, budget_ceiling_cents: null, max_cost_per_conversation_cents: null };
const OPTS = { agora: new Date("2026-09-03T07:00:00Z"), requestId: "req-1" };

beforeEach(() => {
  inserts.length = 0;
  chamadas.length = 0;
  vi.mocked(audit).mockClear();
  vi.mocked(enviarAoDono).mockClear();
});

describe("rodarAgenteDeAnuncios — nível 1", () => {
  it("usa o ponto ads_agent com maxSteps 6, grava a proposta, recusa a escrita, avisa o Dono e audita", async () => {
    const r = await rodarAgenteDeAnuncios(admin, {} as never, {} as never, CONTA, OPTS);
    expect(r).toMatchObject({ status: "ok", propostas: 1, recusas: 1 });
    const input = chamadas[0] as { purpose: string; maxSteps: number; tenantId: string };
    expect(input.purpose).toBe("ads_agent");
    expect(input.maxSteps).toBe(6);
    expect(input.tenantId).toBe("org-1");
    expect(inserts.find((i) => i.tabela === "ad_proposals")?.payload).toMatchObject({ level: 1, kind: "orcamento" });
    expect(enviarAoDono).toHaveBeenCalledWith(admin, "org-1", expect.stringContaining("Subir orçamento da Busca"));
    expect(inserts.find((i) => i.tabela === "agent_inbox_items")?.payload).toMatchObject({ organization_id: "org-1", kind: "other" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ads.escrita_recusada" }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ads.agent_rodou", metadata: expect.objectContaining({ propostas: 1, recusas: 1, autonomy_level: 1 }) }));
  });

  it("orçamento de IA estourado: pula e audita, sem avisar o Dono", async () => {
    vi.mocked(runModelCall).mockRejectedValueOnce(new (LlmBudgetExceededError as unknown as new () => Error)());
    const r = await rodarAgenteDeAnuncios(admin, {} as never, {} as never, CONTA, OPTS);
    expect(r).toMatchObject({ status: "pulado", motivo: "orcamento_de_ia" });
    expect(enviarAoDono).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ads.agent_pulado" }));
  });
});
