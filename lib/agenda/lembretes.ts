/**
 * O lembrete de consulta — quem finalmente LÊ as colunas `reminder_*`.
 *
 * ─── O buraco que este arquivo fecha ────────────────────────────────────────
 *
 * `calendar_event_types.reminder_enabled` / `reminder_minutes_before` e
 * `calendar_appointments.reminder_sent_at` vieram do upstream sem consumidor
 * nenhum: a tela deixava o Dono ligar o lembrete, e nada o mandava. O fork fez
 * o lembrete nascer desligado (migration 0194) justamente para a promessa não
 * ser falsa; este cron é o que a torna verdadeira quando o Dono liga.
 *
 * ─── O que faz, a cada 10 min ───────────────────────────────────────────────
 *
 * 1. Lê os agendamentos `pending`/`confirmed`, sem `reminder_sent_at`, que
 *    começam DEPOIS de agora e dentro do horizonte máximo (30 dias — o CHECK de
 *    `reminder_minutes_before`). O recorte fino — tipo ligado e
 *    `starts_at - reminder_minutes_before <= agora` — é por linha, porque o
 *    PostgREST não compara duas colunas entre si.
 * 2. Para cada candidato, acha a conversa: `conversation_id` do agendamento
 *    quando houver; senão a ÚLTIMA conversa do contato. Nos dados de hoje a
 *    coluna está sempre nula, então o segundo caminho é o primário.
 * 3. Manda pelo `sendMessageHandler` — o MESMO caminho de saída de tela, MCP e
 *    agente, que recusa contato bloqueado e despacha pelo adapter do canal (o
 *    provider é decisão do seam, não deste arquivo). Copia o que
 *    `avisarLeadDoCrm` (`lib/ai/handoff/aviso-ao-lead.ts`) já faz.
 * 4. Marca `reminder_sent_at` (só onde ainda é nulo — dois crons concorrentes
 *    não mandam dois) e audita `agenda.reminder_sent`.
 *
 * Envio que falha NÃO marca: a próxima rodada tenta de novo enquanto a janela
 * durar. Sem conversa não há canal — pula e diz `sem_canal`.
 *
 * ─── O texto (ADR-0012) ────────────────────────────────────────────────────
 *
 * "Lembrete: sua consulta de <serviço> é <dia> às <hora> com <Profissional>.
 * Responda SIM para confirmar ou avise se precisar remarcar." Sem motivo, sem
 * especialidade além do nome do serviço que o próprio Paciente escolheu. O
 * Profissional é o `full_name` do `owner_user_id` (GoTrue, como
 * `lib/users/nome-do-atendente.ts`); sem nome, a frase sai sem o "com".
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { rotuloLocal } from "@/lib/tempo/agora";

/** Ator do envio — é o automático falando, não uma pessoa. */
const ATOR_DO_LEMBRETE = "agenda-lembretes";

/** O maior `reminder_minutes_before` que o CHECK do baseline aceita: 30 dias. */
const HORIZONTE_MINUTOS = 43_200;

const STATUS_QUE_LEMBRA = ["pending", "confirmed"] as const;

export interface OpcoesDeLembrete {
  agora: Date;
  /** Lista os candidatos e o que seria pulado, sem enviar, marcar nem auditar. */
  dryRun?: boolean;
}

export interface Pulado {
  appointment_id: string;
  motivo: string;
}

export interface ResultadoDosLembretes {
  candidatos: number;
  enviados: number;
  pulados: Pulado[];
}

interface TipoLido {
  name: string;
  reminder_enabled: boolean;
  reminder_minutes_before: number;
}

interface AgendamentoLido {
  id: string;
  organization_id: string;
  starts_at: string;
  time_zone: string;
  contact_id: string | null;
  conversation_id: string | null;
  owner_user_id: string | null;
  calendar_event_types: TipoLido | TipoLido[] | null;
}

interface Candidato {
  agendamento: AgendamentoLido;
  tipo: TipoLido;
}

function tipoDe(a: AgendamentoLido): TipoLido | null {
  const t = a.calendar_event_types;
  return Array.isArray(t) ? (t[0] ?? null) : t;
}

async function candidatosEm(admin: SupabaseClient, agora: Date): Promise<Candidato[]> {
  const horizonte = new Date(agora.getTime() + HORIZONTE_MINUTOS * 60_000);
  const { data, error } = await admin
    .from("calendar_appointments")
    .select(
      "id, organization_id, starts_at, time_zone, contact_id, conversation_id, owner_user_id, " +
        "calendar_event_types:event_type_id(name, reminder_enabled, reminder_minutes_before)",
    )
    .in("status", [...STATUS_QUE_LEMBRA])
    .is("reminder_sent_at", null)
    .gt("starts_at", agora.toISOString())
    .lte("starts_at", horizonte.toISOString());
  if (error) throw new Error(`calendar_appointments: ${error.message}`);

  const candidatos: Candidato[] = [];
  // `as unknown`: o client tipado tenta ler o select embutido e não reconhece o
  // alias `calendar_event_types:event_type_id(...)` — a forma é a de cima.
  for (const agendamento of (data ?? []) as unknown as AgendamentoLido[]) {
    const tipo = tipoDe(agendamento);
    if (!tipo?.reminder_enabled) continue;
    const abreEm = new Date(agendamento.starts_at).getTime() - tipo.reminder_minutes_before * 60_000;
    if (abreEm > agora.getTime()) continue;
    candidatos.push({ agendamento, tipo });
  }
  return candidatos;
}

/** `conversation_id` do agendamento, senão a última conversa do contato. */
async function conversaDe(admin: SupabaseClient, a: AgendamentoLido): Promise<string | null> {
  if (a.conversation_id) return a.conversation_id;
  if (!a.contact_id) return null;
  const { data, error } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", a.organization_id)
    .eq("contact_id", a.contact_id)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`conversations (${a.id}): ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * O nome do Profissional, do GoTrue — a mesma fonte de `lib/users/nome-do-atendente.ts`.
 * Aqui pelo client INJETADO, e não pelo helper: o cron recebe o admin de fora,
 * e o teste com dublê precisa que todo acesso passe por ele. Falha → sem nome,
 * nunca sem lembrete.
 */
async function nomeDoProfissional(admin: SupabaseClient, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) {
      logger.warn("[agenda-lembretes] nome do Profissional não lido", { user_id: userId, erro: error.message });
      return null;
    }
    const nome = data?.user?.user_metadata?.full_name;
    return typeof nome === "string" && nome.trim() !== "" ? nome.trim() : null;
  } catch (err) {
    logger.warn("[agenda-lembretes] lookup do Profissional lançou", {
      user_id: userId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function textoDoLembrete(servico: string, quando: string, profissional: string | null): string {
  const com = profissional ? ` com ${profissional}` : "";
  return `Lembrete: sua consulta de ${servico} é ${quando}${com}. Responda SIM para confirmar ou avise se precisar remarcar.`;
}

export async function enviarLembretesDevidos(
  admin: SupabaseClient,
  opts: OpcoesDeLembrete,
): Promise<ResultadoDosLembretes> {
  const { agora, dryRun = false } = opts;
  const candidatos = await candidatosEm(admin, agora);
  const pulados: Pulado[] = [];
  let enviados = 0;

  for (const { agendamento, tipo } of candidatos) {
    const conversationId = await conversaDe(admin, agendamento);
    if (!conversationId) {
      pulados.push({ appointment_id: agendamento.id, motivo: "sem_canal" });
      continue;
    }
    if (dryRun) continue;

    const body = textoDoLembrete(
      tipo.name,
      rotuloLocal(new Date(agendamento.starts_at), agendamento.time_zone),
      await nomeDoProfissional(admin, agendamento.owner_user_id),
    );

    try {
      await sendMessageHandler(
        admin,
        {
          organization_id: agendamento.organization_id,
          actor: { type: "ai_agent", id: ATOR_DO_LEMBRETE, role: "manager" },
          requestId: `agenda-lembrete-${agendamento.id}`,
        },
        {
          conversation_id: conversationId,
          type: "text",
          body,
          // A linha se DECLARA: é texto de sistema, não fala do agente.
          metadata: { lembrete_de_agendamento: true, appointment_id: agendamento.id },
        },
      );
    } catch (err) {
      const nome = err instanceof Error ? err.name : "erro_desconhecido";
      logger.warn("[agenda-lembretes] lembrete não saiu", {
        appointment_id: agendamento.id,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
      pulados.push({ appointment_id: agendamento.id, motivo: `envio_falhou:${nome}` });
      continue;
    }

    const { error: marcaErr } = await admin
      .from("calendar_appointments")
      .update({ reminder_sent_at: agora.toISOString() })
      .eq("id", agendamento.id)
      .is("reminder_sent_at", null);
    if (marcaErr) throw new Error(`calendar_appointments (marca ${agendamento.id}): ${marcaErr.message}`);

    enviados += 1;
    await audit({
      action: "agenda.reminder_sent",
      organizationId: agendamento.organization_id,
      resourceType: "calendar_appointment",
      resourceId: agendamento.id,
      bypassedRls: true,
      metadata: {
        appointment_id: agendamento.id,
        conversation_id: conversationId,
        minutos_antes: tipo.reminder_minutes_before,
      },
    });
  }

  return { candidatos: candidatos.length, enviados, pulados };
}
