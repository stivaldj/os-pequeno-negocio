/**
 * Garante a `channel_sessions` do `fake_channel` de uma organização — o que
 * uma prova local chama antes de mandar a primeira mensagem pelo webhook
 * genérico (`/api/v1/webhooks/channel/<webhook_path_token>`).
 *
 * Reusa `waha_session_name` como ref (ver `session-ref.ts`), idempotente por
 * `(organization_id, waha_session_name)`.
 */
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export function nomeDaSessaoFake(organizationId: string): string {
  return `fake-${organizationId.replace(/-/g, "").slice(0, 8)}`;
}

export async function garantirSessaoFake(
  admin: SupabaseClient,
  organizationId: string,
): Promise<{ sessionId: string; webhookPathToken: string }> {
  const nome = nomeDaSessaoFake(organizationId);
  const { data: existente, error: erroBusca } = await admin
    .from("channel_sessions")
    .select("id, webhook_path_token")
    .eq("organization_id", organizationId)
    .eq("waha_session_name", nome)
    .is("archived_at", null)
    .maybeSingle();
  if (erroBusca) throw new Error(`sessao_fake: ${erroBusca.message}`);
  if (existente?.id && existente.webhook_path_token) {
    return { sessionId: existente.id, webhookPathToken: existente.webhook_path_token };
  }

  const webhookPathToken = randomBytes(24).toString("hex");
  const { data: criada, error: erroInsert } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: organizationId,
      provider: "fake_channel",
      waha_session_name: nome,
      display_name: "Canal de prova",
      status: "WORKING",
      webhook_path_token: webhookPathToken,
      webhook_secret_encrypted: Buffer.from([0]),
    })
    .select("id")
    .single();
  if (erroInsert || !criada) throw new Error(`sessao_fake: ${erroInsert?.message ?? "sem id"}`);
  return { sessionId: criada.id, webhookPathToken };
}
