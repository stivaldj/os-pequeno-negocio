/**
 * O que o Agente de Anúncios lê antes de pensar: por campanha, 7 e 30 dias de
 * Verba, cliques, conversas atribuídas, consultas pagas e Sobra por Real,
 * mais os dias incompletos e as propostas ainda pendentes. Serializado em
 * texto compacto — sem nome de paciente, sem telefone, sem texto de conversa.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { sobraPorRealDaConta } from "../relatorio";
import type { ResultadoDeSobra } from "../sobra";

export interface ContextoDeAnuncios {
  organizationId: string;
  agora: string;
  janelas: { dias: 7 | 30; sobra: ResultadoDeSobra; cliques: Record<string, number> }[];
  propostasPendentes: { id: string; campaign_id: string | null; kind: string; title: string; created_at: string }[];
}

function diaIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function periodoDe(agora: Date, dias: number): { de: string; ate: string } {
  const ate = new Date(agora);
  ate.setUTCDate(ate.getUTCDate() - 1);
  const de = new Date(ate);
  de.setUTCDate(de.getUTCDate() - (dias - 1));
  return { de: diaIso(de), ate: diaIso(ate) };
}

export async function montarContexto(admin: SupabaseClient, organizationId: string, opts: { agora: Date }): Promise<ContextoDeAnuncios> {
  const janelas: ContextoDeAnuncios["janelas"] = [];
  for (const dias of [7, 30] as const) {
    const periodo = periodoDe(opts.agora, dias);
    const sobra = await sobraPorRealDaConta(admin, organizationId, periodo);
    const { data: linhas } = await admin
      .from("ad_spend")
      .select("campaign_id, clicks")
      .eq("organization_id", organizationId)
      .gte("date", periodo.de)
      .lte("date", periodo.ate);
    const cliques: Record<string, number> = {};
    for (const l of (linhas ?? []) as { campaign_id: string; clicks: number | null }[]) {
      cliques[l.campaign_id] = (cliques[l.campaign_id] ?? 0) + (l.clicks ?? 0);
    }
    janelas.push({ dias, sobra, cliques });
  }
  const { data: pendentes } = await admin
    .from("ad_proposals")
    .select("id, campaign_id, kind, title, created_at")
    .eq("organization_id", organizationId)
    .eq("status", "pendente")
    .order("created_at", { ascending: false })
    .limit(20);
  return {
    organizationId,
    agora: opts.agora.toISOString(),
    janelas,
    propostasPendentes: (pendentes ?? []) as ContextoDeAnuncios["propostasPendentes"],
  };
}

function reais(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
}

export function contextoEmTexto(ctx: ContextoDeAnuncios): string {
  const partes: string[] = [`Data: ${ctx.agora.slice(0, 10)}.`];
  for (const j of ctx.janelas) {
    partes.push(`\n## Últimos ${j.dias} dias (${j.sobra.periodo.de} a ${j.sobra.periodo.ate})`);
    if (j.sobra.campanhas.length === 0) partes.push("Sem gasto nem conversa atribuída no período.");
    for (const c of j.sobra.campanhas) {
      const spr = c.sobraPorReal === null ? "sem gasto" : `${c.sobraPorReal.toFixed(2)} por real`;
      partes.push(
        `- Campanha ${c.campaignName ?? c.campaignId} (id ${c.campaignId}): gasto ${reais(c.gastoCents)}, cliques ${j.cliques[c.campaignId] ?? 0}, ` +
          `conversas ${c.contatos}, consultas pagas ${c.vendas}${c.vendasSemMargem ? ` (+${c.vendasSemMargem} sem margem)` : ""}, ` +
          `receita ${reais(c.receitaCents)}, sobra ${reais(c.sobraCents)}, Sobra por Real ${spr}` +
          (c.incompleto ? ` — INCOMPLETO: sem gasto lido em ${c.diasSemGasto.length} dia(s)` : ""),
      );
    }
    const t = j.sobra.total;
    partes.push(`Total: gasto ${reais(t.gastoCents)}, sobra ${reais(t.sobraCents)}, Sobra por Real ${t.sobraPorReal === null ? "sem gasto" : t.sobraPorReal.toFixed(2)}${t.incompleto ? " (incompleto)" : ""}.`);
  }
  if (ctx.propostasPendentes.length > 0) {
    partes.push("\n## Propostas ainda sem resposta do Dono (não repita)");
    for (const p of ctx.propostasPendentes) partes.push(`- [${p.kind}] ${p.title} (campanha ${p.campaign_id ?? "—"}, ${p.created_at.slice(0, 10)})`);
  }
  return partes.join("\n");
}
