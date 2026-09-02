/**
 * O vigia do "não é ato médico" — em OBSERVAÇÃO (ADR-0012).
 *
 * Roda de hora em hora (`app/api/v1/cron/clinica-vigia`). Para cada Conta com a
 * redação clínica ligada, lê as respostas do Agente da última hora
 * (`direction = 'outbound'`, `sent_via = 'ai'` — a autoria do Agente é o CHECK
 * do baseline), passa cada uma por `pareceAtoMedico` e, a cada acerto:
 *
 *   - abre um item `other`/`critical` na Central de avisos da Conta, apontando
 *     para a mensagem (`ref_kind = 'message'`) — quem julga é uma pessoa;
 *   - audita `clinica.ato_medico_suspeito` com o motivo;
 *   - avisa o Dono pelo WhatsApp (`enviarAoDono`, `lib/dono/`), uma frase.
 *
 * Nem o item, nem o audit, nem o aviso ao Dono carregam o TEXTO da resposta:
 * ela fica em `messages`, que é o único lugar dela. Copiar para a Central (ou
 * para o WhatsApp do Dono) seria persistir de novo o Conteúdo Clínico que a
 * resposta provavelmente cita (ADR-0004).
 *
 * Não bloqueia, não apaga, não responde de volta. O gate na cadeia
 * `before_send` é fase posterior — exigiria contexto montado em
 * `inbound-turn.ts`, que módulo próprio não edita.
 *
 * Dedup por `ref_kind`/`ref_id`: a mesma resposta pode cair em duas rodadas
 * (a janela é de uma hora, o cron também), e um aviso basta.
 */
import { configuracaoClinica } from "./config";
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { enviarAoDono } from "@/lib/dono/destinatario";

import { pareceAtoMedico } from "./ato-medico";

const JANELA_MINUTOS = 60;

export const TITULO_DO_AVISO = "Possível ato médico na resposta do Agente";

/** Sem id, sem motivo, sem texto: o Dono abre a Central e vê o resto lá. */
export const AVISO_AO_DONO =
  "Uma resposta do assistente pareceu ato médico; veja a Central de avisos.";

export interface ResultadoDaVigiaClinica {
  organizacoes: number;
  mensagens: number;
  suspeitas: number;
}


interface Org {
  id: string;
  settings: unknown;
}

interface Resposta {
  id: string;
  body: string | null;
}

async function contasComRedacao(admin: SupabaseClient): Promise<Org[]> {
  const { data, error } = await admin.from("organizations").select("id, settings");
  if (error) throw new Error(`organizations: ${error.message}`);
  return ((data ?? []) as Org[]).filter((o) => configuracaoClinicaLigada(o.settings));
}

async function respostasDoAgente(admin: SupabaseClient, orgId: string, desde: Date): Promise<Resposta[]> {
  const { data, error } = await admin
    .from("messages")
    .select("id, body")
    .eq("organization_id", orgId)
    .eq("direction", "outbound")
    .eq("sent_via", "ai")
    .gt("created_at", desde.toISOString());
  if (error) throw new Error(`messages (${orgId}): ${error.message}`);
  return (data ?? []) as Resposta[];
}

async function jaApontada(admin: SupabaseClient, orgId: string, messageId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", orgId)
    .eq("ref_kind", "message")
    .eq("ref_id", messageId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`agent_inbox_items (${messageId}): ${error.message}`);
  return data !== null;
}

async function apontar(admin: SupabaseClient, orgId: string, messageId: string, motivo: string): Promise<void> {
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: orgId,
    kind: "other",
    severity: "critical",
    title: TITULO_DO_AVISO,
    body: `Motivo: ${motivo}. Mensagem ${messageId}.`,
    ref_kind: "message",
    ref_id: messageId,
  });
  if (error) throw new Error(`agent_inbox_items (${messageId}): ${error.message}`);

  await audit({
    action: "clinica.ato_medico_suspeito",
    organizationId: orgId,
    resourceType: "message",
    resourceId: messageId,
    bypassedRls: true,
    metadata: { motivo },
  });

  await enviarAoDono(admin, orgId, AVISO_AO_DONO);
}

export async function vigiarAtoMedico(
  admin: SupabaseClient,
  { agora }: { agora: Date },
): Promise<ResultadoDaVigiaClinica> {
  const desde = new Date(agora.getTime() - JANELA_MINUTOS * 60_000);
  const contas = await contasComRedacao(admin);

  let mensagens = 0;
  let suspeitas = 0;
  for (const conta of contas) {
    const respostas = await respostasDoAgente(admin, conta.id, desde);
    mensagens += respostas.length;
    for (const resposta of respostas) {
      const suspeita = pareceAtoMedico(resposta.body);
      if (!suspeita.parece || suspeita.motivo === null) continue;
      if (await jaApontada(admin, conta.id, resposta.id)) continue;
      await apontar(admin, conta.id, resposta.id, suspeita.motivo);
      suspeitas += 1;
    }
  }

  return { organizacoes: contas.length, mensagens, suspeitas };
}

function configuracaoClinicaLigada(settings: unknown): boolean {
  return configuracaoClinica(settings).redacao;
}
