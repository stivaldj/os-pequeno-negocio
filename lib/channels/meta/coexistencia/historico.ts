/**
 * `history`: até 6 meses de conversa que o app já teve, em pedaços. Entra com
 * o `sent_at` original, sem marcar a conversa como "nova", sem efeitos
 * pós-entrada e sem silenciar o Agente — não é mensagem de hoje.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HistoryEvent } from "../webhook";
import { gravarMensagem, type SessaoDaCoexistencia } from "./gravar";

export async function importarHistoricoDoApp(
  admin: SupabaseClient,
  e: HistoryEvent,
  sessao: SessaoDaCoexistencia,
): Promise<{ importadas: number; duplicadas: number }> {
  let importadas = 0;
  let duplicadas = 0;
  for (const m of e.messages) {
    const r = await gravarMensagem(admin, sessao, {
      waId: m.direction === "inbound" ? m.from : m.to,
      direction: m.direction,
      externalId: m.externalId,
      type: m.type,
      text: m.text,
      sentAt: m.sentAt,
      origem: "history",
      marcar: false,
    });
    if (r.status === "ingested") importadas += 1;
    else if (r.status === "duplicate") duplicadas += 1;
  }
  return { importadas, duplicadas };
}
