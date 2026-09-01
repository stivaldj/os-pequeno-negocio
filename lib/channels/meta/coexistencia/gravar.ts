/**
 * O que eco e histórico têm em comum: garantir contato e conversa pelas MESMAS
 * RPCs do ingest de entrada, e inserir a mensagem com o `unique
 * (organization_id, external_id)` fazendo a idempotência.
 *
 * Fica aqui, e não como flag em `meta/ingest.ts`, para a Coexistência não
 * editar código herdado: o ingest de entrada continua intocado e o rebase
 * contra o upstream continua limpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { encontrarContatoPorTelefone } from "../../contato-por-telefone";
import { canonicalPhoneBR } from "../../phone-variants";
import { prepararEntradaDoContato, type EntradaPreparada } from "@/lib/clinica/redacao";

export interface SessaoDaCoexistencia {
  id: string;
  organizationId: string;
}

export type GravacaoOutcome =
  | { status: "ingested"; messageId: string; conversationId: string; contactId: string }
  | { status: "duplicate" }
  | { status: "failed"; reason: string };

export async function garantirContatoEConversa(
  admin: SupabaseClient,
  sessao: SessaoDaCoexistencia,
  waId: string,
  nome: string | null,
): Promise<{ contactId: string; conversationId: string } | { failed: string }> {
  const orgId = sessao.organizationId;
  const existente = await encontrarContatoPorTelefone(admin, orgId, waId);
  const phone = existente?.phone_number
    ? canonicalPhoneBR(existente.phone_number)
    : canonicalPhoneBR(`+${waId.replace(/\D/g, "")}`);

  const { data: contactId, error: erroContato } = await admin.rpc(
    "fn_upsert_wa_contact" as never,
    { p_org: orgId, p_kind: "phone", p_phone: phone, p_lid: null, p_chat_id: waId, p_notify: nome } as never,
  );
  if (erroContato || !contactId) return { failed: `contato: ${erroContato?.message ?? "sem id"}` };

  const { data: conversationId, error: erroConversa } = await admin.rpc(
    "fn_upsert_wa_conversation" as never,
    { p_org: orgId, p_contact: contactId as string, p_session: sessao.id } as never,
  );
  if (erroConversa || !conversationId) return { failed: `conversa: ${erroConversa?.message ?? "sem id"}` };

  return { contactId: contactId as string, conversationId: conversationId as string };
}

export async function gravarMensagem(
  admin: SupabaseClient,
  sessao: SessaoDaCoexistencia,
  input: {
    waId: string;
    nome?: string | null;
    direction: "inbound" | "outbound";
    externalId: string;
    type: string;
    text: string | null;
    sentAt: Date;
    origem: "app" | "history";
    /** Marca a conversa (preview/last_message). Falso para histórico. */
    marcar: boolean;
  },
): Promise<GravacaoOutcome> {
  const ids = await garantirContatoEConversa(admin, sessao, input.waId, input.nome ?? null);
  if ("failed" in ids) return { status: "failed", reason: ids.failed };

  // Redação clínica ANTES de gravar (ADR-0004) — só o que o Contato escreveu.
  // A saída da recepção (eco) não é texto do Contato e passa íntegra.
  const preparada: EntradaPreparada =
    input.direction === "inbound"
      ? await prepararEntradaDoContato(admin, sessao.organizationId, input.text)
      : { body: input.text, preview: (input.text ?? `[${input.type}]`).slice(0, 120), textoParaEfeitos: input.text, redigido: null };

  const { data: inserida, error: erroInsert } = await admin
    .from("messages")
    .insert({
      organization_id: sessao.organizationId,
      conversation_id: ids.conversationId,
      channel_session_id: sessao.id,
      contact_id: ids.contactId,
      direction: input.direction,
      status: "delivered",
      type: input.type === "text" ? "text" : input.type,
      body: preparada.body,
      external_id: input.externalId,
      media_mime: null,
      sent_at: input.sentAt.toISOString(),
      metadata: { origem: input.origem, ...(preparada.redigido ? { redigido: { motivo: preparada.redigido.motivo } } : {}) },
    })
    .select("id")
    .maybeSingle();
  if (erroInsert) {
    if (erroInsert.code === "23505") return { status: "duplicate" };
    return { status: "failed", reason: `mensagem: ${erroInsert.message}` };
  }

  if (input.marcar) {
    await admin.rpc("fn_mark_conversation_message" as never, {
      p_conv: ids.conversationId,
      p_direction: input.direction,
      p_preview: preparada.preview || `[${input.type}]`,
      p_at: input.sentAt.toISOString(),
    } as never);
  }

  return {
    status: "ingested",
    messageId: (inserida as { id: string } | null)?.id ?? "",
    conversationId: ids.conversationId,
    contactId: ids.contactId,
  };
}
