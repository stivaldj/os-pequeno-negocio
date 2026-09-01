/**
 * Eco do app (`smb_message_echoes`): a recepção respondeu pelo WhatsApp
 * Business no telefone. Entra na Conversa como saída humana e cala o Agente por
 * um intervalo — é a "colisão" que a ADR-0014 aceitou e o mínimo que a torna
 * suportável.
 *
 * O silêncio usa `conversations.bot_silenced_until`, que o motor já respeita
 * (`lib/inbox/comando-da-conversa.ts`): nada de gate novo na cadeia.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppEchoEvent } from "../webhook";
import { gravarMensagem, type GravacaoOutcome, type SessaoDaCoexistencia } from "./gravar";

export const SILENCIO_PADRAO_MINUTOS = 10;

export interface OpcoesDoEco {
  silencioMinutos: number;
  agora?: Date;
  /** Falso para histórico: saída antiga não cala o Agente hoje. */
  silenciar?: boolean;
}

export async function ingerirEcoDoApp(
  admin: SupabaseClient,
  e: AppEchoEvent,
  sessao: SessaoDaCoexistencia,
  opcoes: OpcoesDoEco,
): Promise<GravacaoOutcome> {
  const r = await gravarMensagem(admin, sessao, {
    waId: e.to,
    direction: "outbound",
    externalId: e.externalId,
    type: e.type,
    text: e.text,
    sentAt: e.sentAt,
    origem: "app",
    marcar: true,
  });
  if (r.status !== "ingested") return r;

  if (opcoes.silenciar !== false) {
    const agora = opcoes.agora ?? new Date();
    const ate = new Date(agora.getTime() + opcoes.silencioMinutos * 60_000);
    await admin
      .from("conversations")
      .update({ bot_silenced_until: ate.toISOString() })
      .eq("id", r.conversationId)
      .eq("organization_id", sessao.organizationId);
  }
  return r;
}

/**
 * Intervalo de silêncio da Conta: `organizations.settings.coexistence_silence_minutes`.
 * Configuração tem superfície (doutrina): a tela entra na Fase 4 junto com a
 * configuração da Conta; até lá o default vale.
 */
export async function silencioDaConta(admin: SupabaseClient, organizationId: string): Promise<number> {
  const { data } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  const bruto = (data as { settings?: Record<string, unknown> } | null)?.settings?.coexistence_silence_minutes;
  const n = typeof bruto === "number" ? bruto : Number(bruto);
  return Number.isFinite(n) && n >= 0 ? n : SILENCIO_PADRAO_MINUTOS;
}
