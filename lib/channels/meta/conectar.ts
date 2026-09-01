/**
 * Grava (ou reativa) a sessão do canal oficial de UMA organização.
 *
 * Extraído do `POST /api/v1/channels/official` para que o caminho manual (BYO,
 * o padrão) e o Embedded Signup em Coexistência (ADR-0015) gravem a sessão do
 * MESMO jeito: credencial validada na Meta antes de qualquer escrita, token
 * cifrado por sessão, linha arquivada ressuscitada em vez de duplicada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "../archived";
import { CHANNEL_PROVIDER_META } from "../capabilities";
import { reactivateChannelSession } from "../reactivate";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { validateMetaCredentials } from "./validate-credentials";

export interface ConexaoOficial {
  organizationId: string;
  userId: string;
  requestId: string;
  phoneNumberId: string;
  wabaId: string;
  token: string;
  /** `true` quando o número entrou por Embedded Signup em Coexistência. */
  coexistence: boolean;
}

export type DesfechoDaConexao =
  | { ok: true; displayName: string; phoneNumber: string | null }
  | { ok: false; code: "invalid_request" | "internal_error"; message: string; status: 422 | 500 };

export async function conectarCanalOficial(
  admin: SupabaseClient,
  input: ConexaoOficial,
): Promise<DesfechoDaConexao> {
  const validacao = await validateMetaCredentials({ phoneNumberId: input.phoneNumberId, token: input.token });
  if (!validacao.ok) {
    return { ok: false, code: "invalid_request", message: validacao.motivo, status: 422 };
  }

  const cifrado = await encryptWebhookSecret(admin, input.token);
  if (!cifrado) {
    return {
      ok: false,
      code: "invalid_request",
      message:
        "cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado",
      status: 422,
    };
  }

  const buscarExistente = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", input.organizationId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .maybeSingle();
  const { data: existenteRaw } = await queryTolerantToMissingArchived(
    () => buscarExistente(`id, ${ARCHIVED_AT}`),
    () => buscarExistente("id"),
  );
  const existente = existenteRaw as { id: string; archived_at?: string | null } | null;

  const linha = {
    organization_id: input.organizationId,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: input.phoneNumberId,
    meta_waba_id: input.wabaId,
    meta_token_encrypted: cifrado,
    meta_coexistence: input.coexistence,
    phone_number: validacao.displayPhoneNumber
      ? `+${validacao.displayPhoneNumber.replace(/\D/g, "")}`
      : null,
    display_name: validacao.verifiedName ?? "Canal oficial",
    status: "WORKING",
  };

  const { error } = existente
    ? await reactivateChannelSession(
        admin,
        {
          organizationId: input.organizationId,
          channelSessionId: existente.id,
          archivedAt: existente.archived_at ?? null,
        },
        linha,
        {
          userId: input.userId,
          requestId: input.requestId,
          metadata: { provider: CHANNEL_PROVIDER_META, phone_number: linha.phone_number, coexistence: input.coexistence },
        },
      )
    : await admin.from("channel_sessions").insert({ ...linha, webhook_secret_encrypted: cifrado });
  if (error) {
    return { ok: false, code: "internal_error", message: error.message ?? "channel_session_write_failed", status: 500 };
  }
  return { ok: true, displayName: linha.display_name, phoneNumber: linha.phone_number };
}
