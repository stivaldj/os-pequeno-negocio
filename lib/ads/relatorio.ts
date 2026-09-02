/**
 * Lê do banco os insumos de Sobra por Real de uma Conta num período e entrega
 * ao cálculo puro (`sobra.ts`). Tudo filtrado por `organization_id` — o admin
 * client bypassa RLS.
 *
 * Venda = `calendar_appointments` `completed` com `paid_cents` (ADR-0017), de
 * contato atribuído ao Google (`contacts.source = 'google_ads'`, campanha em
 * `source_metadata->>'ad_source_id'`), com a Margem Declarada do serviço.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { calcularSobraPorReal, type ContatoAtribuido, type GastoDoDia, type ResultadoDeSobra, type VendaAtribuida } from "./sobra";

export interface Periodo {
  de: string;
  ate: string;
}

export interface InsumosDeSobra {
  gastos: GastoDoDia[];
  vendas: VendaAtribuida[];
  contatos: ContatoAtribuido[];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export async function insumosDeSobra(admin: SupabaseClient, organizationId: string, periodo: Periodo): Promise<InsumosDeSobra> {
  const { data: gastoRows, error: erroGasto } = await admin
    .from("ad_spend")
    .select("campaign_id, campaign_name, date, cost_micros")
    .eq("organization_id", organizationId)
    .gte("date", periodo.de)
    .lte("date", periodo.ate);
  if (erroGasto) throw new Error(`ad_spend: ${erroGasto.message}`);

  const { data: contatoRows, error: erroContatos } = await admin
    .from("contacts")
    .select("id, source_metadata")
    .eq("organization_id", organizationId)
    .eq("source", "google_ads");
  if (erroContatos) throw new Error(`contacts: ${erroContatos.message}`);

  const campanhaPorContato = new Map<string, string>();
  for (const c of (contatoRows ?? []) as { id: string; source_metadata: Record<string, unknown> | null }[]) {
    const campanha = str(c.source_metadata?.ad_source_id);
    if (campanha) campanhaPorContato.set(c.id, campanha);
  }

  const vendas: VendaAtribuida[] = [];
  if (campanhaPorContato.size > 0) {
    const { data: agRows, error: erroAg } = await admin
      .from("calendar_appointments")
      .select("id, contact_id, paid_cents, starts_at, calendar_event_types(margin_bps)")
      .eq("organization_id", organizationId)
      .eq("status", "completed")
      .not("paid_cents", "is", null)
      .in("contact_id", [...campanhaPorContato.keys()])
      .gte("starts_at", `${periodo.de}T00:00:00Z`)
      .lt("starts_at", `${proximoDia(periodo.ate)}T00:00:00Z`);
    if (erroAg) throw new Error(`calendar_appointments: ${erroAg.message}`);
    for (const a of (agRows ?? []) as { id: string; contact_id: string; paid_cents: number | string; calendar_event_types: { margin_bps: number | null } | { margin_bps: number | null }[] | null }[]) {
      const campanha = campanhaPorContato.get(a.contact_id);
      if (!campanha) continue;
      const tipo = Array.isArray(a.calendar_event_types) ? a.calendar_event_types[0] : a.calendar_event_types;
      vendas.push({
        campaignId: campanha,
        contactId: a.contact_id,
        appointmentId: a.id,
        paidCents: Number(a.paid_cents),
        marginBps: tipo?.margin_bps === null || tipo?.margin_bps === undefined ? null : Number(tipo.margin_bps),
      });
    }
  }

  return {
    gastos: ((gastoRows ?? []) as { campaign_id: string; campaign_name: string | null; date: string; cost_micros: number | string }[]).map((g) => ({
      campaignId: g.campaign_id,
      campaignName: g.campaign_name,
      date: g.date,
      costMicros: Number(g.cost_micros),
    })),
    vendas,
    contatos: [...campanhaPorContato.entries()].map(([contactId, campaignId]) => ({ contactId, campaignId })),
  };
}

export async function sobraPorRealDaConta(admin: SupabaseClient, organizationId: string, periodo: Periodo): Promise<ResultadoDeSobra> {
  const insumos = await insumosDeSobra(admin, organizationId, periodo);
  return calcularSobraPorReal({ periodo, ...insumos });
}

function proximoDia(dia: string): string {
  const d = new Date(`${dia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
