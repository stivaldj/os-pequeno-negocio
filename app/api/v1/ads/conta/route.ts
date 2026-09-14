/**
 * A CONTA DE ANÚNCIOS da organização — `GET` lê, `PATCH` cria-ou-altera.
 *
 * Uma Conta por organização e provedor (`unique (organization_id, provider)`),
 * por isso o PATCH é um upsert: a primeira gravação cria, as seguintes alteram.
 *
 * `autonomy_level` e os três limites (`budget_floor_cents`, `budget_ceiling_
 * cents`, `max_cost_per_conversation_cents`) ERAM só leitura na Fase 5 — o
 * comentário de então dizia que o nível subiria "por decisão da LAVRA com o
 * Dono, não por um campo na tela". A Fase 8 (ADR-0018, issue #28) é essa
 * decisão virando painel: "o Dono sobe o nível no painel, auditada; o
 * operador não sobe por ele". `last_sync_at`, `last_error` e `status`
 * continuam só do coletor.
 *
 * Os quatro campos são OPCIONAIS no corpo, e a semântica importa:
 *   - ausente no corpo → não toca a coluna (upsert do PostgREST só grava o
 *     que veio no JSON; `undefined` some no `JSON.stringify` antes de sair);
 *   - `null` explícito nos três limites → limpa o limite;
 *   - `autonomy_level` não aceita `null` — é 1, 2 ou 3, nunca "sem nível".
 *
 * Mudança de NÍVEL audita `ads.nivel_alterado` à parte de `ads.account_
 * updated`: é a única das quatro mudanças que o ADR chama por nome como
 * "ação do Dono, auditada" — as outras são configuração de conta.
 *
 * Service role: o `organization_id` vem do gate, nunca do body.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, customer_id, conversion_customer_id, conversion_action, currency, autonomy_level, budget_floor_cents, budget_ceiling_cents, max_cost_per_conversation_cents, status, last_sync_at, last_error";

/** Os mesmos limites do CHECK: recusa 422 em vez de 500 de constraint. */
const customerId = z.string().regex(/^[0-9]{10}$/, "O ID do cliente do Google Ads tem 10 dígitos.");
/** `bigint ... >= 0`, e `null` limpa o limite — nunca 0 no lugar de "sem limite". */
const limiteCents = z.number().int().min(0).nullable();
const alterarSchema = z
  .object({
    customer_id: customerId,
    conversion_customer_id: customerId.nullish(),
    conversion_action: z.string().trim().min(1).max(200).nullish(),
    autonomy_level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    budget_floor_cents: limiteCents.optional(),
    budget_ceiling_cents: limiteCents.optional(),
    max_cost_per_conversation_cents: limiteCents.optional(),
  })
  // Só pega o caso em que os DOIS vêm no mesmo corpo — um piso maior que o
  // teto faria toda escrita de orçamento do Nível 2 recusar por
  // `fora_dos_limites`, e o Dono não teria como saber por quê.
  .refine(
    (v) => v.budget_floor_cents === undefined || v.budget_ceiling_cents === undefined || v.budget_floor_cents === null || v.budget_ceiling_cents === null || v.budget_floor_cents <= v.budget_ceiling_cents,
    { message: "O piso do orçamento não pode ser maior que o teto.", path: ["budget_floor_cents"] },
  );

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
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("manager", { requestId, resource: "ad_accounts" });
  if (!authz.ok) return authz.response;

  const lido = alterarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, { requestId });
  }

  const admin = createAdminClient();

  // O nível ANTES da gravação — só para o audit de `ads.nivel_alterado` saber
  // `from`/`to`. `null` = Conta ainda não existe (a gravação vai criá-la).
  const { data: existente } = await admin
    .from("ad_accounts")
    .select("autonomy_level")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "google_ads")
    .maybeSingle();
  const nivelAnterior = (existente as { autonomy_level: number } | null)?.autonomy_level ?? null;

  // `conversion_customer_id`/`conversion_action` mantêm o comportamento de
  // sempre: omitido no corpo vira `null` (o formulário da Conta manda o
  // objeto inteiro a cada salvamento). `autonomy_level` e os três limites são
  // OPOSTOS de propósito — omitidos, NÃO entram no payload, e o upsert do
  // PostgREST não toca a coluna (só grava o que está no JSON). `undefined`
  // some no `JSON.stringify`; só `null` explícito limpa um limite.
  const payload: Record<string, unknown> = {
    organization_id: authz.org.orgId,
    provider: "google_ads",
    customer_id: lido.data.customer_id,
    conversion_customer_id: lido.data.conversion_customer_id ?? null,
    conversion_action: lido.data.conversion_action ?? null,
    updated_at: new Date().toISOString(),
  };
  if (lido.data.autonomy_level !== undefined) payload.autonomy_level = lido.data.autonomy_level;
  if (lido.data.budget_floor_cents !== undefined) payload.budget_floor_cents = lido.data.budget_floor_cents;
  if (lido.data.budget_ceiling_cents !== undefined) payload.budget_ceiling_cents = lido.data.budget_ceiling_cents;
  if (lido.data.max_cost_per_conversation_cents !== undefined) payload.max_cost_per_conversation_cents = lido.data.max_cost_per_conversation_cents;

  const { data, error } = await admin
    .from("ad_accounts")
    .upsert(payload as never, { onConflict: "organization_id,provider" })
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
    metadata: {
      customer_id: lido.data.customer_id,
      conversion_action: lido.data.conversion_action ?? null,
      budget_floor_cents: data.budget_floor_cents,
      budget_ceiling_cents: data.budget_ceiling_cents,
      max_cost_per_conversation_cents: data.max_cost_per_conversation_cents,
    },
  });

  // ADR-0018: "subir de nível é ação do Dono no painel, auditada" — à parte
  // do `ads.account_updated` genérico, e só quando o nível DE FATO mudou.
  if (lido.data.autonomy_level !== undefined && lido.data.autonomy_level !== nivelAnterior) {
    await audit({
      action: "ads.nivel_alterado",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "ad_accounts",
      resourceId: data.id,
      requestId,
      metadata: { nivel_anterior: nivelAnterior, nivel_novo: lido.data.autonomy_level },
    });
  }

  return ok(data, { requestId });
}
