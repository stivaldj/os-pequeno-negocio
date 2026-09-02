/**
 * O vigia — transforma uma rotina que NÃO rodou em barulho.
 *
 * Roda de hora em hora (`app/api/v1/cron/rotinas-vigia`) e, para cada rotina
 * de `ROTINAS_ESPERADAS`, olha a última linha em `job_runs`. Se a rotina está
 * calada há mais que a tolerância, três coisas acontecem, uma para cada
 * leitor:
 *
 *   - linha `missing` em `job_runs` — o histórico registra a ausência;
 *   - item `job_dead` em `agent_inbox_items`, com `organization_id` nulo —
 *     a Central de avisos da instalação (o `kind` é do CHECK fechado da tabela;
 *     inventar um passa no dublê e reprova no banco real);
 *   - `audit` `rotinas.nao_rodou` — a trilha;
 *   - uma linha curta ao Dono de cada Conta com WhatsApp configurado
 *     (`enviarAosDonos`, `lib/dono/`) — quem paga fica sabendo.
 *
 * A tolerância é `2 × período + 5 min`, inclusiva: um tick atrasado não é
 * ausência; dois seguidos, é. O que se compara é `started_at`, não
 * `finished_at`: uma linha `running` que nunca fechou (processo morreu no
 * meio) tem de contar como ausência, senão ela esconde o defeito para sempre.
 *
 * Rotina SEM linha nenhuma: a referência é quando o histórico começou (a linha
 * mais antiga da tabela). Instalação recém-subida ainda não tem a diária —
 * nada a gritar; instalação com três dias de histórico e uma rotina que nunca
 * apareceu — essa nunca rodou, e é justamente o caso que o teste de
 * agendamento não alcança (a linha está no crontab; o crond é que não a
 * dispara).
 *
 * Dedup: última linha já `missing` dentro da tolerância não gera segunda.
 * Passada a tolerância, grita de novo — um aviso por janela, até alguém
 * consertar.
 *
 * Limitação conhecida: o aviso ao Dono sai pelo MESMO canal de WhatsApp que a
 * rotina caída pode ter derrubado (`channel-health` calada costuma significar
 * exatamente isso). Quando o canal está de pé, o Dono sabe na hora; quando não
 * está, ficam a Central de avisos e o audit — e o motivo `sem_canal` no log.
 * Um segundo canal (e-mail, SMS) é decisão de fase posterior.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { enviarAosDonos } from "@/lib/dono/destinatario";
import { logger } from "@/lib/logger";

import { ROTINAS_ESPERADAS, type RotinaEsperada } from "./esperadas";

const FOLGA_MINUTOS = 5;

/** `2 × período + 5 min`. */
export function toleranciaMinutos(periodoMinutos: number): number {
  return 2 * periodoMinutos + FOLGA_MINUTOS;
}

export interface ResultadoDaVigia {
  verificadas: number;
  ausentes: string[];
}

interface UltimaLinha {
  id: string;
  status: string;
  started_at: string;
}

async function ultimaLinhaDe(admin: SupabaseClient, nome: string): Promise<UltimaLinha | null> {
  const { data, error } = await admin
    .from("job_runs")
    .select("id, status, started_at")
    .eq("job_name", nome)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`job_runs (${nome}): ${error.message}`);
  return (data as UltimaLinha | null) ?? null;
}

async function inicioDoHistorico(admin: SupabaseClient): Promise<string | null> {
  const { data, error } = await admin
    .from("job_runs")
    .select("started_at")
    .order("started_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`job_runs (início): ${error.message}`);
  return (data as { started_at: string } | null)?.started_at ?? null;
}

function minutosEntre(depois: Date, antes: string): number {
  return (depois.getTime() - new Date(antes).getTime()) / 60_000;
}

async function registrarAusencia(
  admin: SupabaseClient,
  rotina: RotinaEsperada,
  agora: Date,
  silencioMinutos: number,
): Promise<void> {
  const tolerancia = toleranciaMinutos(rotina.periodoMinutos);
  const silencio = Math.round(silencioMinutos);
  const erro =
    `Esperada a cada ${rotina.periodoMinutos} min; calada há ${silencio} min ` +
    `(tolerância ${tolerancia} min).`;

  const { data, error } = await admin
    .from("job_runs")
    .insert({
      job_name: rotina.nome,
      status: "missing",
      started_at: agora.toISOString(),
      finished_at: agora.toISOString(),
      error: erro,
    })
    .select("id")
    .single();
  if (error) throw new Error(`job_runs (missing ${rotina.nome}): ${error.message}`);
  const runId = String((data as { id: string }).id);

  const { error: inboxErr } = await admin.from("agent_inbox_items").insert({
    organization_id: null,
    kind: "job_dead",
    severity: "critical",
    title: `Rotina ${rotina.nome} não rodou`,
    body:
      `${erro} Confira se o serviço scheduler está de pé (docker compose ps) e se ` +
      `INTERNAL_SECRET no .env bate com o do app — um 401 em silêncio tem exatamente esta cara.`,
    ref_kind: "job_run",
    ref_id: runId,
  });
  if (inboxErr) throw new Error(`agent_inbox_items (${rotina.nome}): ${inboxErr.message}`);

  logger.warn("[rotinas-vigia] rotina não rodou", {
    job_name: rotina.nome,
    silencio_min: silencio,
    tolerancia_min: tolerancia,
  });

  await audit({
    action: "rotinas.nao_rodou",
    organizationId: null,
    resourceType: "job_run",
    resourceId: runId,
    bypassedRls: true,
    metadata: {
      job_name: rotina.nome,
      periodo_min: rotina.periodoMinutos,
      silencio_min: silencio,
      tolerancia_min: tolerancia,
    },
  });

  // Curto e sem instrução de operador: o `body` do inbox cita INTERNAL_SECRET
  // e docker compose, e isso não é conversa para o WhatsApp do Dono.
  await enviarAosDonos(
    admin,
    `A rotina ${rotina.nome} não rodou nas últimas ${horasOuMinutos(silencio)}. Veja a Central de avisos.`,
  );
}

function horasOuMinutos(minutos: number): string {
  if (minutos < 120) return `${minutos} min`;
  return `${Math.floor(minutos / 60)} h`;
}

export async function vigiar(admin: SupabaseClient, agora: Date = new Date()): Promise<ResultadoDaVigia> {
  const ausentes: string[] = [];
  let inicio: string | null | undefined; // lido uma vez, só se alguma rotina não tiver linha

  for (const rotina of ROTINAS_ESPERADAS) {
    const tolerancia = toleranciaMinutos(rotina.periodoMinutos);
    const ultima = await ultimaLinhaDe(admin, rotina.nome);

    let referencia: string | null;
    if (ultima) {
      referencia = ultima.started_at;
    } else {
      if (inicio === undefined) inicio = await inicioDoHistorico(admin);
      referencia = inicio;
    }
    if (referencia === null) continue; // histórico vazio: nada a comparar

    const silencio = minutosEntre(agora, referencia);
    if (silencio <= tolerancia) continue; // em dia — ou `missing` recém-escrito (dedup)

    await registrarAusencia(admin, rotina, agora, silencio);
    ausentes.push(rotina.nome);
  }

  return { verificadas: ROTINAS_ESPERADAS.length, ausentes };
}
