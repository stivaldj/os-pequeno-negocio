/**
 * POST /api/v1/channels/official/embedded-signup — o Número entra por
 * Coexistência (ADR-0015).
 *
 * O popup da Meta devolve `code` + (por postMessage) `waba_id` e
 * `phone_number_id`. Aqui: código → token, webhook assinado na WABA, sessão
 * gravada pelo MESMO caminho do formulário manual, com `meta_coexistence`.
 * Sem app da Meta na instalação a rota responde 404: o recurso não existe.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  appDaMetaDoAmbiente,
  assinarWebhookNaWaba,
  trocarCodigoPorToken,
} from "@/lib/channels/meta/coexistencia/embedded-signup";
import { conectarCanalOficial } from "@/lib/channels/meta/conectar";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const corpoSchema = z.object({
  code: z.string().min(1),
  waba_id: z.string().min(5),
  phone_number_id: z.string().min(5),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const userId = authz.user.id;

  const app = appDaMetaDoAmbiente();
  if (!app) {
    return fail("embedded_signup_unavailable", "esta instalação não declara app da Meta", 404, { requestId });
  }

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", "code, waba_id e phone_number_id são obrigatórios", 422, { requestId });
  }
  const { code, waba_id, phone_number_id } = parsed.data;

  const troca = await trocarCodigoPorToken(code, app);
  if (!troca.ok) return fail("invalid_request", `Meta recusou o código: ${troca.motivo}`, 422, { requestId });

  const assinatura = await assinarWebhookNaWaba(troca.token, waba_id);
  if (!assinatura.ok) {
    return fail("invalid_request", `Meta recusou assinar o webhook: ${assinatura.motivo}`, 422, { requestId });
  }

  const desfecho = await conectarCanalOficial(createAdminClient(), {
    organizationId: orgId,
    userId,
    requestId,
    phoneNumberId: phone_number_id,
    wabaId: waba_id,
    token: troca.token,
    coexistence: true,
  });
  if (!desfecho.ok) return fail(desfecho.code, desfecho.message, desfecho.status, { requestId });

  void audit({
    action: "channels.official.embedded_signup",
    actorUserId: userId,
    organizationId: orgId,
    resourceType: "channel_session",
    requestId,
    metadata: { waba_id, phone_number_id, coexistence: true },
  });

  return ok({
    connected: true,
    coexistence: true,
    displayName: desfecho.displayName,
    phoneNumber: desfecho.phoneNumber,
  });
}
