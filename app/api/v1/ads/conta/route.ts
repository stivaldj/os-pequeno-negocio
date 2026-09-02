/**
 * A CONTA DE ANÚNCIOS da organização — `GET` lê, `PATCH` cria-ou-altera.
 *
 * Uma Conta por organização e provedor (`unique (organization_id, provider)`),
 * por isso o PATCH é um upsert: a primeira gravação cria, as seguintes alteram.
 *
 * `autonomy_level` é SÓ LEITURA nesta fase (ADR-0018): o nível sobe por
 * decisão da LAVRA com o Dono, não por um campo na tela. O Zod não o aceita,
 * então mesmo que o body traga, ele não chega ao banco. `last_sync_at`,
 * `last_error` e `status` são do coletor, também só leitura.
 *
 * Service role: o `organization_id` vem do gate, nunca do body.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, customer_id, conversion_customer_id, conversion_action, currency, autonomy_level, status, last_sync_at, last_error";

/** Os mesmos limites do CHECK: recusa 422 em vez de 500 de constraint. */
const customerId = z.string().regex(/^[0-9]{10}$/, "O ID do cliente do Google Ads tem 10 dígitos.");
const alterarSchema = z.object({
  customer_id: customerId,
  conversion_customer_id: customerId.nullish(),
  conversion_action: z.string().trim().min(1).max(200).nullish(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("manager", { requestId, resource: "ad_accounts" });
  if (!authz.ok) return authz.response;

  const { data, error } = await createAdminClient()
    .from("ad_accounts")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "google_ads")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? null, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("manager", { requestId, resource: "ad_accounts" });
  if (!authz.ok) return authz.response;

  const lido = alterarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, { requestId });
  }

  const { data, error } = await createAdminClient()
    .from("ad_accounts")
    .upsert(
      {
        organization_id: authz.org.orgId,
        provider: "google_ads",
        customer_id: lido.data.customer_id,
        conversion_customer_id: lido.data.conversion_customer_id ?? null,
        conversion_action: lido.data.conversion_action ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,provider" },
    )
    .select(COLUNAS)
    .single();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  await audit({
    action: "ads.account_updated",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "ad_accounts",
    resourceId: data.id,
    requestId,
    metadata: { customer_id: lido.data.customer_id, conversion_action: lido.data.conversion_action ?? null },
  });
  return ok(data, { requestId });
}
