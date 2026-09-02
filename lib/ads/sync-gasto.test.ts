/**
 * A Verba entra por sincronização diária (Spec 0003): por Conta ativa, os
 * últimos dias por campanha e dia vão para `ad_spend`, upsert por
 * (org, campanha, dia). Erro da API marca a Conta e audita; sucesso audita
 * com a contagem. Nada aqui lê fora da organização da Conta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ads/google/gasto", () => ({ lerGastoPorCampanhaEDia: vi.fn() }));
vi.mock("@/lib/ads/google/config", () => ({ googleAdsDisponivel: vi.fn(() => true) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const { lerGastoPorCampanhaEDia } = await import("@/lib/ads/google/gasto");
const { googleAdsDisponivel } = await import("@/lib/ads/google/config");
const { audit } = await import("@/lib/audit");
const { sincronizarGasto } = await import("@/lib/ads/sync-gasto");

const ops: { tabela: string; op: string; payload?: unknown; filtros: [string, unknown][] }[] = [];
let contas: Record<string, unknown>[] = [];
function chain(tabela: string, op: string, payload?: unknown) {
  const reg = { tabela, op, payload, filtros: [] as [string, unknown][] };
  ops.push(reg);
  const proxy: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: tabela === "ad_accounts" && op === "select" ? contas : [], error: null });
      return (...args: unknown[]) => {
        if (["eq", "in"].includes(String(prop))) reg.filtros.push([String(args[0]), args[1]]);
        return proxy;
      };
    },
  });
  return proxy;
}
const admin = {
  from: (t: string) => ({
    select: () => chain(t, "select"),
    upsert: (p: unknown) => chain(t, "upsert", p),
    update: (p: unknown) => chain(t, "update", p),
  }),
} as never;

const AGORA = new Date("2026-09-03T03:10:00Z");

beforeEach(() => {
  ops.length = 0;
  vi.mocked(audit).mockClear();
  vi.mocked(lerGastoPorCampanhaEDia).mockReset();
  vi.mocked(googleAdsDisponivel).mockReturnValue(true);
  contas = [{ id: "conta-1", organization_id: "org-1", customer_id: "1234567890", status: "active" }];
});

describe("sincronizarGasto", () => {
  it("lê os últimos 3 dias e faz upsert por (org, campanha, dia)", async () => {
    vi.mocked(lerGastoPorCampanhaEDia).mockResolvedValue({
      ok: true,
      valor: [
        { campaignId: "111", campaignName: "Busca", campaignStatus: "ENABLED", date: "2026-09-01", costMicros: 50_000_000, clicks: 10, impressions: 100, conversions: 1, conversionsValue: 200 },
        { campaignId: "111", campaignName: "Busca", campaignStatus: "ENABLED", date: "2026-09-02", costMicros: 30_000_000, clicks: 5, impressions: 60, conversions: 0, conversionsValue: 0 },
      ],
    });
    const r = await sincronizarGasto(admin, { agora: AGORA });
    expect(vi.mocked(lerGastoPorCampanhaEDia).mock.calls[0]?.slice(0, 3)).toEqual(["1234567890", "2026-08-31", "2026-09-02"]);
    const upsert = ops.find((o) => o.tabela === "ad_spend" && o.op === "upsert");
    expect(upsert?.payload).toEqual([
      expect.objectContaining({ organization_id: "org-1", campaign_id: "111", date: "2026-09-01", cost_micros: 50_000_000, clicks: 10 }),
      expect.objectContaining({ organization_id: "org-1", campaign_id: "111", date: "2026-09-02", cost_micros: 30_000_000 }),
    ]);
    expect(r).toEqual({ contas: 1, linhas: 2, falhas: 0 });
    const marca = ops.find((o) => o.tabela === "ad_accounts" && o.op === "update")?.payload as Record<string, unknown>;
    expect(marca.last_error).toBeNull();
    expect(marca.status).toBe("active");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ads.spend_synced", organizationId: "org-1", metadata: expect.objectContaining({ linhas: 2 }) }));
  });

  it("erro da API marca a Conta como error, guarda o motivo e audita a falha", async () => {
    vi.mocked(lerGastoPorCampanhaEDia).mockResolvedValue({ ok: false, code: "USER_PERMISSION_DENIED", motivo: "vincule a conta ao MCC" } as never);
    const r = await sincronizarGasto(admin, { agora: AGORA });
    expect(r).toEqual({ contas: 1, linhas: 0, falhas: 1 });
    const marca = ops.find((o) => o.tabela === "ad_accounts" && o.op === "update")?.payload as Record<string, unknown>;
    expect(marca).toMatchObject({ status: "error", last_error: expect.stringContaining("USER_PERMISSION_DENIED") });
    expect(marca.last_error).toContain("vincule a conta ao MCC");
    expect(ops.find((o) => o.tabela === "ad_spend")).toBeUndefined();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "ads.sync_falhou", organizationId: "org-1" }));
  });

  it("sem credencial do Google na instalação, não faz nada e não audita", async () => {
    vi.mocked(googleAdsDisponivel).mockReturnValue(false);
    const r = await sincronizarGasto(admin, { agora: AGORA });
    expect(r).toEqual({ contas: 0, linhas: 0, falhas: 0 });
    expect(lerGastoPorCampanhaEDia).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("só Contas ativas entram, e cada uma é filtrada pela própria organização", async () => {
    vi.mocked(lerGastoPorCampanhaEDia).mockResolvedValue({ ok: true, valor: [] });
    await sincronizarGasto(admin, { agora: AGORA });
    const sel = ops.find((o) => o.tabela === "ad_accounts" && o.op === "select");
    expect(sel?.filtros).toContainEqual(["status", "active"]);
    const marca = ops.find((o) => o.tabela === "ad_accounts" && o.op === "update");
    expect(marca?.filtros).toContainEqual(["organization_id", "org-1"]);
    expect(audit).not.toHaveBeenCalled(); // zero linhas: nada a auditar
  });
});
