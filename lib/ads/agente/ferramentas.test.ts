import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/ads/google/campanhas", () => ({
  lerCampanhas: vi.fn(),
  mutarOrcamento: vi.fn(),
  mutarStatusDaCampanha: vi.fn(),
}));

const { audit } = await import("@/lib/audit");
const { lerCampanhas, mutarOrcamento, mutarStatusDaCampanha } = await import("@/lib/ads/google/campanhas");
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

/** Uma campanha do Google, no formato que `lerCampanhas` devolve. */
const CAMPANHA_DO_GOOGLE = {
  campaignId: "111",
  campaignName: "Busca — Implante",
  campaignResourceName: "customers/1234567890/campaigns/111",
  campaignStatus: "ENABLED",
  biddingStrategyType: "MAXIMIZE_CONVERSIONS",
  budgetResourceName: "customers/1234567890/campaignBudgets/555",
  budgetAmountMicros: 50_000_000, // R$ 50,00/dia
  costMicros: 875_000_000,
  clicks: 420,
  impressions: 13_000,
  conversions: 30,
  conversionsValue: 9000,
  averageCpcMicros: 2_083_333,
  ctr: 0.0323,
  costPerConversionMicros: 29_166_666, // ~R$ 29,17
};

type Exec = { execute: (args: unknown, opts: unknown) => Promise<unknown> };

beforeEach(() => {
  inserts.length = 0;
  vi.mocked(audit).mockClear();
  vi.mocked(lerCampanhas).mockReset().mockResolvedValue({ ok: true, valor: [CAMPANHA_DO_GOOGLE] });
  vi.mocked(mutarOrcamento).mockReset().mockResolvedValue({ ok: true, valor: { resourceName: CAMPANHA_DO_GOOGLE.budgetResourceName } });
  vi.mocked(mutarStatusDaCampanha).mockReset().mockResolvedValue({ ok: true, valor: { resourceName: CAMPANHA_DO_GOOGLE.campaignResourceName } });
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

  describe("nível 2 — ajustar_orcamento escreve DE VERDADE, dentro de piso e teto", () => {
    const CONTA_N2 = { ...CONTA, autonomy_level: 2, budget_floor_cents: 3000, budget_ceiling_cents: 8000 };

    it("dentro do intervalo: releva a campanha no Google, muta o orçamento e audita com o valor anterior", async () => {
      const tools = ferramentasDoAgente(admin, CONTA_N2, CTX, { propostas: [], recusas: [] }, "req-1");
      const r = await (tools.ajustar_orcamento as unknown as Exec).execute({ campaign_id: "111", novo_orcamento_cents: 5000 }, {});
      expect(r).toEqual({ aplicado: true, campaign_id: "111", orcamento_anterior_cents: 5000, novo_orcamento_cents: 5000 });
      expect(lerCampanhas).toHaveBeenCalledWith("1234567890", 7);
      expect(mutarOrcamento).toHaveBeenCalledWith("1234567890", CAMPANHA_DO_GOOGLE.budgetResourceName, 50_000_000);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "ads.orcamento_ajustado",
          metadata: expect.objectContaining({ campaign_id: "111", orcamento_anterior_cents: 5000, novo_orcamento_cents: 5000, autonomy_level: 2 }),
        }),
      );
    });

    it("sem piso/teto configurados: recusa `limites_nao_configurados` e NÃO chama o Google", async () => {
      const tools = ferramentasDoAgente(admin, { ...CONTA, autonomy_level: 2 }, CTX, { propostas: [], recusas: [] }, "req-1");
      const r = await (tools.ajustar_orcamento as unknown as Exec).execute({ campaign_id: "111", novo_orcamento_cents: 5000 }, {});
      expect(r).toMatchObject({ recusado: true, motivo: "limites_nao_configurados" });
      expect(lerCampanhas).not.toHaveBeenCalled();
      expect(mutarOrcamento).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ads.escrita_recusada", metadata: expect.objectContaining({ motivo: "limites_nao_configurados" }) }));
    });

    it("fora do intervalo: recusa `fora_dos_limites` com piso/teto/pedido no motivo, e NÃO chama o Google", async () => {
      const tools = ferramentasDoAgente(admin, CONTA_N2, CTX, { propostas: [], recusas: [] }, "req-1");
      const r = await (tools.ajustar_orcamento as unknown as Exec).execute({ campaign_id: "111", novo_orcamento_cents: 9000 }, {});
      expect(r).toMatchObject({ recusado: true, motivo: "fora_dos_limites", piso_cents: 3000, teto_cents: 8000, pedido_cents: 9000 });
      expect(mutarOrcamento).not.toHaveBeenCalled();
    });

    it("Google Ads recusa a escrita: não lança, audita ads.escrita_falhou e devolve aplicado:false", async () => {
      vi.mocked(mutarOrcamento).mockResolvedValue({ ok: false, code: "http", motivo: "PolicyViolationError" });
      const tools = ferramentasDoAgente(admin, CONTA_N2, CTX, { propostas: [], recusas: [] }, "req-1");
      const r = await (tools.ajustar_orcamento as unknown as Exec).execute({ campaign_id: "111", novo_orcamento_cents: 5000 }, {});
      expect(r).toEqual({ aplicado: false, motivo: "http" });
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ads.escrita_falhou", metadata: expect.objectContaining({ code: "http" }) }));
    });

    it("campanha não existe mais no Google: falha nomeada, não uma exceção", async () => {
      vi.mocked(lerCampanhas).mockResolvedValue({ ok: true, valor: [] });
      const tools = ferramentasDoAgente(admin, CONTA_N2, CTX, { propostas: [], recusas: [] }, "req-1");
      const r = await (tools.ajustar_orcamento as unknown as Exec).execute({ campaign_id: "111", novo_orcamento_cents: 5000 }, {});
      expect(r).toEqual({ aplicado: false, motivo: "campanha_nao_encontrada" });
    });
  });

  describe("nível 2 — pausar_campanha escreve DE VERDADE, sem trava de piso/teto", () => {
    it("muta o status para PAUSED e audita com o custo por conversa da campanha", async () => {
      const tools = ferramentasDoAgente(admin, { ...CONTA, autonomy_level: 2 }, CTX, { propostas: [], recusas: [] }, "req-1");
      const r = await (tools.pausar_campanha as unknown as Exec).execute({ campaign_id: "111", motivo: "custo por conversa acima do teto" }, {});
      expect(r).toEqual({ aplicado: true, campaign_id: "111" });
      expect(mutarStatusDaCampanha).toHaveBeenCalledWith("1234567890", CAMPANHA_DO_GOOGLE.campaignResourceName, "PAUSED");
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "ads.campanha_pausada",
          metadata: expect.objectContaining({ campaign_id: "111", motivo: "custo por conversa acima do teto", custo_por_conversa_cents: 2917 }),
        }),
      );
    });

    it("pausar não exige piso/teto configurado — só o nível", async () => {
      const tools = ferramentasDoAgente(admin, { ...CONTA, autonomy_level: 2 }, CTX, { propostas: [], recusas: [] }, "req-1");
      const r = await (tools.pausar_campanha as unknown as Exec).execute({ campaign_id: "111", motivo: "caro" }, {});
      expect(r).toMatchObject({ aplicado: true });
    });
  });

  it("nível 3: as duas ações de nível 2 continuam escrevendo — nível 3 é superset, não um caminho à parte", async () => {
    const tools = ferramentasDoAgente(admin, { ...CONTA, autonomy_level: 3, budget_floor_cents: 3000, budget_ceiling_cents: 8000 }, CTX, { propostas: [], recusas: [] }, "req-1");
    const r = await (tools.ajustar_orcamento as unknown as Exec).execute({ campaign_id: "111", novo_orcamento_cents: 5000 }, {});
    expect(r).toMatchObject({ aplicado: true });
  });
});
