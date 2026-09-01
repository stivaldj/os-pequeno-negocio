/**
 * `smb_app_state_sync`: os contatos que o app do telefone tem. Quem já existe
 * no CRM não é tocado — nome editado à mão vale mais que o do app.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { encontrarContatoPorTelefone } from "../../contato-por-telefone";
import { canonicalPhoneBR } from "../../phone-variants";
import type { ChannelTenantScope } from "../../types";
import type { AppStateSyncEvent } from "../webhook";

export async function sincronizarContatosDoApp(
  admin: SupabaseClient,
  e: AppStateSyncEvent,
  dono: ChannelTenantScope,
): Promise<{ criados: number; existentes: number }> {
  let criados = 0;
  let existentes = 0;
  for (const c of e.contacts) {
    const existente = await encontrarContatoPorTelefone(admin, dono.organizationId, c.phone);
    if (existente) {
      existentes += 1;
      continue;
    }
    const { error } = await admin.rpc("fn_upsert_wa_contact" as never, {
      p_org: dono.organizationId,
      p_kind: "phone",
      p_phone: canonicalPhoneBR(`+${c.phone}`),
      p_lid: null,
      p_chat_id: c.phone,
      p_notify: c.name,
    } as never);
    if (!error) criados += 1;
  }
  return { criados, existentes };
}
