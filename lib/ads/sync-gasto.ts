/**
 * Sincronização diária da Verba (Spec 0003): para cada Conta ativa em
 * `ad_accounts`, lê os últimos dias por campanha e dia na API do Google Ads e
 * faz upsert em `ad_spend` por (org, campanha, dia). Reler 3 dias absorve o
 * ajuste que o Google faz no gasto de ontem.
 *
 * Erro da API não derruba a rotina: marca a Conta (`status = 'error'`,
 * `last_error` legível para o operador) e audita `ads.sync_falhou`. Sucesso
 * com linhas audita `ads.spend_synced`; rodada vazia não audita.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { googleAdsDisponivel } from "./google/config";
import { lerGastoPorCampanhaEDia } from "./google/gasto";

export interface OpcoesDeSync {
  agora: Date;
  /** Quantos dias para trás (o dia de "agora" fica de fora: ainda está em curso). */
  diasParaTras?: number;
}

export interface ResultadoDoSync {
  contas: number;
  linhas: number;
  falhas: number;
}

function diaIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function janela(agora: Date, diasParaTras: number): { de: string; ate: string } {
  const ate = new Date(agora);
  ate.setUTCDate(ate.getUTCDate() - 1);
  const de = new Date(ate);
  de.setUTCDate(de.getUTCDate() - (diasParaTras - 1));
  return { de: diaIso(de), ate: diaIso(ate) };
}

export async function sincronizarGasto(admin: SupabaseClient, opts: OpcoesDeSync): Promise<ResultadoDoSync> {
  if (!googleAdsDisponivel(env)) return { contas: 0, linhas: 0, falhas: 0 };
  const { de, ate } = janela(opts.agora, opts.diasParaTras ?? 3);

  const { data: contas, error } = await admin
    .from("ad_accounts")
    .select("id, organization_id, customer_id, status")
    .eq("status", "active");
  if (error) throw new Error(`ad_accounts: ${error.message}`);

  let linhas = 0;
  let falhas = 0;
  for (const conta of (contas ?? []) as { id: string; organization_id: string; customer_id: string }[]) {
    const orgId = conta.organization_id;
    const r = await lerGastoPorCampanhaEDia(conta.customer_id, de, ate);
    if (!r.ok) {
      falhas += 1;
      const motivo = `${r.code}: ${r.motivo}`.slice(0, 500);
      await admin
        .from("ad_accounts")
        .update({ status: "error", last_error: motivo, updated_at: opts.agora.toISOString() })
        .eq("organization_id", orgId)
        .eq("id", conta.id);
      logger.error("[ads.sync] leitura de gasto falhou", { organization_id: orgId, code: r.code });
      void audit({
        action: "ads.sync_falhou",
        organizationId: orgId,
        resourceType: "ad_account",
        resourceId: conta.id,
        bypassedRls: true,
        metadata: { code: r.code, de, ate },
      });
      continue;
    }

    if (r.valor.length > 0) {
      const payload = r.valor.map((l) => ({
        organization_id: orgId,
        campaign_id: l.campaignId,
        campaign_name: l.campaignName,
        date: l.date,
        cost_micros: l.costMicros,
        clicks: l.clicks,
        impressions: l.impressions,
        conversions: l.conversions,
        conversions_value: l.conversionsValue,
        synced_at: opts.agora.toISOString(),
      }));
      const { error: erroUpsert } = await admin.from("ad_spend").upsert(payload, { onConflict: "organization_id,campaign_id,date" });
      if (erroUpsert) {
        falhas += 1;
        logger.error("[ads.sync] upsert em ad_spend falhou", { organization_id: orgId, detail: erroUpsert.message });
        continue;
      }
      linhas += payload.length;
    }

    await admin
      .from("ad_accounts")
      .update({ status: "active", last_error: null, last_sync_at: opts.agora.toISOString(), updated_at: opts.agora.toISOString() })
      .eq("organization_id", orgId)
      .eq("id", conta.id);

    if (r.valor.length > 0) {
      void audit({
        action: "ads.spend_synced",
        organizationId: orgId,
        resourceType: "ad_account",
        resourceId: conta.id,
        bypassedRls: true,
        metadata: { linhas: r.valor.length, de, ate },
      });
    }
  }
  return { contas: (contas ?? []).length, linhas, falhas };
}
