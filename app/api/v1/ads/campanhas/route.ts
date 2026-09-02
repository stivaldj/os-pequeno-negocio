/**
 * AS CAMPANHAS DA CONTA nos últimos 7 ou 30 dias — a tabela da tela de Anúncios.
 *
 * O número central é a Sobra por Real, calculada em `lib/ads/relatorio.ts`
 * (gasto do `ad_spend`, contatos atribuídos ao Google, vendas da Agenda com a
 * Margem Declarada). Aqui só se junta a ela o que o cálculo não precisa e a
 * tela quer ver: os CLIQUES que o Google reportou no `ad_spend` — `null` quando
 * nenhum dia do período trouxe o dado, para a tela não mostrar zero onde não
 * mediu nada.
 *
 * `agendamentos` = vendas com margem + vendas sem margem: é o que a clínica
 * atendeu e recebeu, com ou sem margem cadastrada. O que só a margem afeta é a
 * Sobra, e o `incompleto` já avisa.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { periodoDosUltimosDias } from "@/lib/ads/periodo";
import { sobraPorRealDaConta } from "@/lib/ads/relatorio";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const consultaSchema = z.object({
  dias: z
    .enum(["7", "30"], { message: "dias aceita 7 ou 30." })
    .default("30")
    .transform(Number),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("manager", { requestId, resource: "ad_spend" });
  if (!authz.ok) return authz.response;

  const lido = consultaSchema.safeParse({ dias: req.nextUrl.searchParams.get("dias") ?? undefined });
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "consulta inválida", 422, { requestId });
  }

  const admin = createAdminClient();
  const periodo = periodoDosUltimosDias(lido.data.dias);

  let relatorio;
  try {
    relatorio = await sobraPorRealDaConta(admin, authz.org.orgId, periodo);
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : String(err), 500, { requestId });
  }

  const { data: gastoRows, error } = await admin
    .from("ad_spend")
    .select("campaign_id, clicks")
    .eq("organization_id", authz.org.orgId)
    .gte("date", periodo.de)
    .lte("date", periodo.ate);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  const cliquesPorCampanha = new Map<string, number>();
  for (const g of (gastoRows ?? []) as { campaign_id: string; clicks: number | string | null }[]) {
    if (g.clicks === null || g.clicks === undefined) continue;
    cliquesPorCampanha.set(g.campaign_id, (cliquesPorCampanha.get(g.campaign_id) ?? 0) + Number(g.clicks));
  }

  return ok(
    {
      periodo: relatorio.periodo,
      campanhas: relatorio.campanhas.map((c) => ({
        campaign_id: c.campaignId,
        campaign_name: c.campaignName,
        gasto_cents: c.gastoCents,
        cliques: cliquesPorCampanha.get(c.campaignId) ?? null,
        contatos: c.contatos,
        agendamentos: c.vendas + c.vendasSemMargem,
        vendas: c.vendas,
        vendas_sem_margem: c.vendasSemMargem,
        receita_cents: c.receitaCents,
        sobra_cents: c.sobraCents,
        sobra_por_real: c.sobraPorReal,
        dias_sem_gasto: c.diasSemGasto,
        incompleto: c.incompleto,
      })),
      total: {
        gasto_cents: relatorio.total.gastoCents,
        receita_cents: relatorio.total.receitaCents,
        sobra_cents: relatorio.total.sobraCents,
        sobra_por_real: relatorio.total.sobraPorReal,
        incompleto: relatorio.total.incompleto,
      },
    },
    { requestId },
  );
}
