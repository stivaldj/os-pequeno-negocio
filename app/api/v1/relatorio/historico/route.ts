/**
 * HISTÓRICO DO RELATÓRIO DAS 8h — `GET /api/v1/relatorio/historico`.
 *
 * Lê `daily_reports` (migration 0245): uma linha por Conta e dia, com o texto
 * que saiu e as seções que ficaram incompletas naquele dia. Leitura pura —
 * quem grava é `lib/relatorio/enviar.ts`, chamado pelo cron.
 *
 * Leitura é `viewer`, como o Financeiro (é o mesmo tipo de dado — caixa e
 * agenda aparecem no texto). `organization_id` vem de `authz.org.orgId`.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const TETO_DA_LISTA = 90;

const listarSchema = z.object({
  limit: z.coerce.number().int().min(1).max(TETO_DA_LISTA).default(30),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("viewer", { requestId, resource: "daily_reports" });
  if (!authz.ok) return authz.response;

  const lido = listarSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "filtro inválido", 422, { requestId });
  }

  const { data, error } = await createAdminClient()
    .from("daily_reports")
    .select("id, report_date, sent_at, incomplete_sections, body, status, failure_reason")
    .eq("organization_id", authz.org.orgId)
    .order("report_date", { ascending: false })
    .limit(lido.data.limit);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  return ok(data ?? [], { requestId });
}
