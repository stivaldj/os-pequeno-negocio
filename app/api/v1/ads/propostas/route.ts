/**
 * PROPOSTAS DO AGENTE DE ANÚNCIOS (ADR-0018) — `GET` lista, `PATCH` decide.
 *
 * No nível 1 o agente só PROPÕE: subir orçamento, pausar, palavra-chave,
 * anúncio, observação. Quem decide é o Dono (ou o gerente), aqui. A decisão
 * é `aprovada` ou `recusada` e grava quem e quando. `aplicada` é o estado que
 * o executor da Fase 8 escreve depois de mexer no Google — esta rota não o
 * aceita, para uma tela não afirmar "aplicada" sobre nada.
 *
 * Só proposta PENDENTE se decide: a segunda decisão sobre a mesma proposta é
 * 404, não sobrescrita. E o filtro de org é do gate, nunca do body.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const COLUNAS = "id, campaign_id, kind, level, title, body, payload, status, decided_by, decided_at, created_at";

const STATUS = ["pendente", "aprovada", "recusada", "aplicada"] as const;

const listarSchema = z.object({ status: z.enum(STATUS).default("pendente") });
const decidirSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["aprovada", "recusada"], { message: "status aceita aprovada ou recusada." }),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("manager", { requestId, resource: "ad_proposals" });
  if (!authz.ok) return authz.response;

  const lido = listarSchema.safeParse({ status: req.nextUrl.searchParams.get("status") ?? undefined });
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "consulta inválida", 422, { requestId });
  }

  const { data, error } = await createAdminClient()
    .from("ad_proposals")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .eq("status", lido.data.status)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("manager", { requestId, resource: "ad_proposals" });
  if (!authz.ok) return authz.response;

  const lido = decidirSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, { requestId });
  }

  const { data, error } = await createAdminClient()
    .from("ad_proposals")
    .update({ status: lido.data.status, decided_by: authz.user.id, decided_at: new Date().toISOString() })
    .eq("id", lido.data.id)
    .eq("organization_id", authz.org.orgId)
    .eq("status", "pendente")
    .select("id, status, decided_at")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Proposta não encontrada ou já decidida.", 404, { requestId });

  await audit({
    action: "ads.proposal_decided",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "ad_proposals",
    resourceId: lido.data.id,
    requestId,
    metadata: { status: lido.data.status },
  });
  return ok(data, { requestId });
}
