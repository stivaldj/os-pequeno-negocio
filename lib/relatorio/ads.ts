/**
 * Verba, Sobra por Real e propostas pendentes — lê `sobraPorRealDaConta`
 * (`lib/ads/relatorio.ts`, o mesmo cálculo puro de `sobra.ts`) para o dia de
 * ONTEM, e `ad_proposals` direto para as propostas ainda `pendente` (não
 * recorta por data: uma proposta de três dias atrás ainda pendente continua
 * sendo decisão do Dono, não histórico).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sobraPorRealDaConta } from "@/lib/ads/relatorio";

import type { JanelaDoRelatorio } from "./janela";
import type { CampanhaDeOntem, PropostaPendente, SecaoAds } from "./tipos";

const TETO_DE_PROPOSTAS = 20;

interface LinhaDeProposta {
  id: string;
  title: string;
  kind: string;
}

async function propostasPendentes(admin: SupabaseClient, organizationId: string): Promise<PropostaPendente[]> {
  const { data, error } = await admin
    .from("ad_proposals")
    .select("id, title, kind")
    .eq("organization_id", organizationId)
    .eq("status", "pendente")
    .order("created_at", { ascending: true })
    .limit(TETO_DE_PROPOSTAS);
  if (error) throw new Error(`ad_proposals: ${error.message}`);
  return (data ?? []) as LinhaDeProposta[];
}

export async function adsDeOntem(admin: SupabaseClient, janela: JanelaDoRelatorio): Promise<SecaoAds> {
  const [sobra, propostas] = await Promise.all([
    sobraPorRealDaConta(admin, janela.organizationId, { de: janela.ontem, ate: janela.ontem }),
    propostasPendentes(admin, janela.organizationId),
  ]);

  const campanhas: CampanhaDeOntem[] = sobra.campanhas.map((c) => ({
    campaignId: c.campaignId,
    campaignName: c.campaignName,
    gastoCents: c.gastoCents,
    sobraPorReal: c.sobraPorReal,
    incompleto: c.incompleto,
  }));

  return {
    campanhas,
    gastoTotalCents: sobra.total.gastoCents,
    sobraPorRealTotal: sobra.total.sobraPorReal,
    propostasPendentes: propostas,
    incompleto: sobra.total.incompleto,
  };
}
