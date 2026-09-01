/**
 * Entrada do `fake_channel`: espelha `lib/channels/meta/ingest.ts` sem a
 * busca de sessão (a rota genérica já resolveu a sessão pelo token do
 * caminho). A cadeia é a mesma dos canais reais de propósito — contato,
 * conversa, mensagem, marca na conversa, efeitos pós-entrada — porque é isso
 * que uma prova local precisa exercitar.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { encontrarContatoPorTelefone } from "../contato-por-telefone";
import { canonicalPhoneBR } from "../phone-variants";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";
import { prepararEntradaDoContato } from "@/lib/clinica/redacao";

export interface FakeInboundEvent {
  from: string;
  text: string;
  externalId: string;
  sentAt: Date;
  profileName?: string | null;
}

export type FakeIngestOutcome =
  | { status: "ingested"; messageId: string; conversationId: string }
  | { status: "duplicate" }
  | { status: "failed"; reason: string };

export async function ingestFakeInbound(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string; evento: FakeInboundEvent },
): Promise<FakeIngestOutcome> {
  const { organizationId: orgId, channelSessionId, evento: e } = input;

  const existente = await encontrarContatoPorTelefone(admin, orgId, e.from);
  const phone = existente?.phone_number
    ? canonicalPhoneBR(existente.phone_number)
    : canonicalPhoneBR(`+${e.from.replace(/\D/g, "")}`);

  const { data: contactId, error: erroContato } = await admin.rpc(
    "fn_upsert_wa_contact" as never,
    {
      p_org: orgId,
      p_kind: "phone",
      p_phone: phone,
      p_lid: null,
      p_chat_id: e.from,
      p_notify: e.profileName ?? null,
    } as never,
  );
  if (erroContato || !contactId) {
    return { status: "failed", reason: `contato: ${erroContato?.message ?? "sem id"}` };
  }

  const { data: conversationId, error: erroConversa } = await admin.rpc(
    "fn_upsert_wa_conversation" as never,
    { p_org: orgId, p_contact: contactId as string, p_session: channelSessionId } as never,
  );
  if (erroConversa || !conversationId) {
    return { status: "failed", reason: `conversa: ${erroConversa?.message ?? "sem id"}` };
  }

  // Redação clínica ANTES de gravar (ADR-0004).
  const preparada = await prepararEntradaDoContato(admin, orgId, e.text);

  const { data: inserida, error: erroInsert } = await admin
    .from("messages")
    .insert({
      organization_id: orgId,
      conversation_id: conversationId as string,
      channel_session_id: channelSessionId,
      contact_id: contactId as string,
      direction: "inbound",
      status: "delivered",
      type: "text",
      body: preparada.body,
      external_id: e.externalId,
      media_mime: null,
      sent_at: e.sentAt.toISOString(),
      metadata: { origem: "fake_channel", ...(preparada.redigido ? { redigido: { motivo: preparada.redigido.motivo } } : {}) },
    })
    .select("id")
    .maybeSingle();
  if (erroInsert) {
    if (erroInsert.code === "23505") return { status: "duplicate" };
    return { status: "failed", reason: `mensagem: ${erroInsert.message}` };
  }

  await admin.rpc("fn_mark_conversation_message" as never, {
    p_conv: conversationId as string,
    p_direction: "inbound",
    p_preview: preparada.preview,
    p_at: e.sentAt.toISOString(),
  } as never);

  const messageId = (inserida as { id: string } | null)?.id ?? "";
  await aplicarEfeitosPosEntrada(admin, {
    organizationId: orgId,
    contactId: contactId as string,
    conversationId: conversationId as string,
    messageId: messageId || null,
    channelSessionId,
    texto: preparada.textoParaEfeitos,
    redigido: preparada.redigido,
    nomeDoContato: e.profileName ?? null,
    origem: "fake_webhook",
  });

  return { status: "ingested", messageId, conversationId: conversationId as string };
}
