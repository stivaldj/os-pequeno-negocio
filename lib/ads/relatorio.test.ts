import { describe, expect, it } from "vitest";
import { insumosDeSobra, sobraPorRealDaConta } from "@/lib/ads/relatorio";

/** Dublê encadeável por tabela: devolve as linhas programadas e registra os filtros. */
function duble(linhas: Record<string, unknown[]>) {
  const filtros: Record<string, [string, unknown][]> = {};
  function chain(tabela: string) {
    filtros[tabela] = [];
    const proxy: Record<string, unknown> = new Proxy({}, {
      get(_t, prop) {
        if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: linhas[tabela] ?? [], error: null });
        return (...args: unknown[]) => {
          if (["eq", "gte", "lte", "lt", "in", "not"].includes(String(prop))) filtros[tabela]!.push([String(prop), args]);
          return proxy;
        };
      },
    });
    return proxy;
  }
  return { admin: { from: (t: string) => ({ select: () => chain(t) }) } as never, filtros };
}

const ORG = "org-1";
const PERIODO = { de: "2026-09-01", ate: "2026-09-02" };

describe("insumosDeSobra", () => {
  it("junta gasto, contatos atribuídos ao Google e consultas pagas com a margem do serviço", async () => {
    const d = duble({
      ad_spend: [{ campaign_id: "111", campaign_name: "Busca", date: "2026-09-01", cost_micros: "50000000" }],
      contacts: [
        { id: "c1", source_metadata: { ad_platform: "google_ads", ad_source_id: "111" } },
        { id: "c2", source_metadata: { ad_platform: "google_ads", ad_source_id: "222" } },
        { id: "c3", source_metadata: {} },
      ],
      calendar_appointments: [
        { id: "a1", contact_id: "c1", paid_cents: "20000", starts_at: "2026-09-01T12:00:00Z", calendar_event_types: { margin_bps: 6000 } },
        { id: "a2", contact_id: "c2", paid_cents: 9000, starts_at: "2026-09-02T12:00:00Z", calendar_event_types: [{ margin_bps: null }] },
      ],
    });
    const r = await insumosDeSobra(d.admin, ORG, PERIODO);
    expect(r.gastos).toEqual([{ campaignId: "111", campaignName: "Busca", date: "2026-09-01", costMicros: 50_000_000 }]);
    expect(r.contatos).toEqual([{ contactId: "c1", campaignId: "111" }, { contactId: "c2", campaignId: "222" }]);
    expect(r.vendas).toEqual([
      { campaignId: "111", contactId: "c1", appointmentId: "a1", paidCents: 20000, marginBps: 6000 },
      { campaignId: "222", contactId: "c2", appointmentId: "a2", paidCents: 9000, marginBps: null },
    ]);
    // Toda tabela filtrada pela organização (o admin bypassa RLS).
    for (const t of ["ad_spend", "contacts", "calendar_appointments"]) {
      expect(d.filtros[t]!.some(([op, args]) => op === "eq" && (args as unknown[])[0] === "organization_id"), t).toBe(true);
    }
  });

  it("sem contato atribuído não consulta agendamentos", async () => {
    const d = duble({ ad_spend: [], contacts: [] });
    const r = await insumosDeSobra(d.admin, ORG, PERIODO);
    expect(r.vendas).toEqual([]);
    expect(d.filtros.calendar_appointments).toBeUndefined();
  });

  it("sobraPorRealDaConta fecha a conta", async () => {
    const d = duble({
      ad_spend: [
        { campaign_id: "111", campaign_name: "Busca", date: "2026-09-01", cost_micros: 50_000_000 },
        { campaign_id: "111", campaign_name: "Busca", date: "2026-09-02", cost_micros: 30_000_000 },
      ],
      contacts: [{ id: "c1", source_metadata: { ad_source_id: "111" } }],
      calendar_appointments: [{ id: "a1", contact_id: "c1", paid_cents: 20000, starts_at: "2026-09-01T12:00:00Z", calendar_event_types: { margin_bps: 6000 } }],
    });
    const r = await sobraPorRealDaConta(d.admin, ORG, PERIODO);
    expect(r.campanhas[0]).toMatchObject({ campaignId: "111", gastoCents: 8000, sobraCents: 12000, incompleto: false });
    expect(r.campanhas[0]!.sobraPorReal).toBeCloseTo(1.5, 5);
  });
});
