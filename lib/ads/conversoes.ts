/**
 * Conversão offline: a Venda Confirmada volta ao Google.
 *
 * A recepção marca "compareceu" com o valor pago (ADR-0017) e, uma vez por
 * dia, este módulo devolve essa consulta ao Google pelo clique que a trouxe —
 * o `gclid`/`gbraid`/`wbraid` que o Código de Clique gravou em
 * `contacts.source_metadata.ad_raw` (ADR-0016). É o que fecha o ciclo: o
 * lance passa a otimizar para quem PAGOU, não para quem clicou.
 *
 * ─── O que é elegível ───────────────────────────────────────────────────────
 *
 * `calendar_appointments` `completed` com `paid_cents` (nulo é dado faltante,
 * não zero), nos últimos 90 dias (a janela em que o Google ainda aceita o
 * clique), cujo contato tem um identificador de clique, e que ainda não tem
 * linha em `ad_conversion_uploads`. A linha nesta tabela é o livro-razão: um
 * agendamento só sobe uma vez, e `orderId` = id do agendamento é a mesma
 * garantia do lado do Google.
 *
 * ─── O que cada resposta vira ───────────────────────────────────────────────
 *
 * - ok, `ORDER_ID_ALREADY_IN_USE`, `CLICK_CONVERSION_ALREADY_EXISTS` → `enviada`:
 *   o Google tem a conversão; reenviar não muda nada.
 * - `TOO_RECENT_EVENT` → NÃO grava: o clique ainda não assentou do lado deles;
 *   sem linha, amanhã ele é elegível de novo.
 * - qualquer outro → `falhou` com o erro, para a tela mostrar e ninguém tentar
 *   de novo às cegas (clique expirado não deixa de estar expirado).
 * - Conta sem `conversion_action` → `ignorada` com o motivo, uma vez por
 *   agendamento. O Dono vê na tela que falta configurar.
 * - a chamada inteira falhando → `ad_accounts.last_error` + audit
 *   `ads.sync_falhou`; nenhuma linha gravada, tudo volta amanhã.
 *
 * Tudo filtrado por `organization_id` em cada query: o admin bypassa RLS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { subirConversoes, formatarDataHoraDeConversao, type LinhaDeConversao } from "@/lib/ads/google/conversoes";
import { offsetEmMinutos } from "@/lib/agenda/fuso";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/** A janela de atribuição do clique no Google Ads: fora dela, é `EXPIRED_EVENT` na certa. */
const JANELA_DIAS = 90;

/** Motivo gravado quando a Conta ainda não tem a ação de conversão configurada. */
export const MOTIVO_SEM_CONVERSION_ACTION = "sem_conversion_action";

/** O Google já tem essa conversão — para nós é o mesmo que enviada. */
const ERROS_QUE_VALEM_ENVIADA = new Set(["ORDER_ID_ALREADY_IN_USE", "CLICK_CONVERSION_ALREADY_EXISTS"]);
/** O clique ainda não assentou: sem linha, tenta amanhã. */
const ERRO_QUE_ADIA = "TOO_RECENT_EVENT";

export interface OpcoesDeUpload {
  agora: Date;
  /** Máximo de agendamentos por Conta por rodada. */
  limite?: number;
}

export interface ResultadoDoUpload {
  contas: number;
  elegiveis: number;
  enviadas: number;
  falhas: number;
  ignoradas: number;
  adiadas: number;
}

interface ContaLida {
  id: string;
  organization_id: string;
  customer_id: string;
  conversion_customer_id: string | null;
  conversion_action: string | null;
  currency: string | null;
}

interface AgendamentoLido {
  id: string;
  contact_id: string | null;
  paid_cents: number | string;
  starts_at: string;
  time_zone: string;
}

interface Identificador {
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
}

interface Elegivel {
  agendamento: AgendamentoLido;
  clique: Identificador;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** O identificador de clique gravado em `source_metadata.ad_raw`, ou `null` sem nenhum. */
function identificadorDe(sourceMetadata: unknown): Identificador | null {
  const meta = sourceMetadata && typeof sourceMetadata === "object" ? (sourceMetadata as Record<string, unknown>) : null;
  const raw = meta?.ad_raw && typeof meta.ad_raw === "object" ? (meta.ad_raw as Record<string, unknown>) : null;
  if (!raw) return null;
  const id = { gclid: str(raw.gclid), gbraid: str(raw.gbraid), wbraid: str(raw.wbraid) };
  return id.gclid || id.gbraid || id.wbraid ? id : null;
}

async function contasAtivas(admin: SupabaseClient): Promise<ContaLida[]> {
  const { data, error } = await admin
    .from("ad_accounts")
    .select("id, organization_id, customer_id, conversion_customer_id, conversion_action, currency")
    .eq("status", "active");
  if (error) throw new Error(`ad_accounts: ${error.message}`);
  return (data ?? []) as ContaLida[];
}

/** Os agendamentos pagos da Conta cujo contato veio de um clique e que ainda não subiram. */
async function elegiveisDa(admin: SupabaseClient, conta: ContaLida, agora: Date, limite: number): Promise<Elegivel[]> {
  const org = conta.organization_id;
  const inicioDaJanela = new Date(agora.getTime() - JANELA_DIAS * 86_400_000);

  const { data: agRows, error: erroAg } = await admin
    .from("calendar_appointments")
    .select("id, contact_id, paid_cents, starts_at, time_zone")
    .eq("organization_id", org)
    .eq("status", "completed")
    .not("paid_cents", "is", null)
    .not("contact_id", "is", null)
    .gte("starts_at", inicioDaJanela.toISOString())
    .order("starts_at", { ascending: true });
  if (erroAg) throw new Error(`calendar_appointments: ${erroAg.message}`);
  const agendamentos = (agRows ?? []) as AgendamentoLido[];
  if (agendamentos.length === 0) return [];

  const contactIds = [...new Set(agendamentos.map((a) => a.contact_id).filter((c): c is string => c !== null))];
  const { data: contatoRows, error: erroContatos } = await admin
    .from("contacts")
    .select("id, source_metadata")
    .eq("organization_id", org)
    .in("id", contactIds);
  if (erroContatos) throw new Error(`contacts: ${erroContatos.message}`);
  const cliquePorContato = new Map<string, Identificador>();
  for (const c of (contatoRows ?? []) as { id: string; source_metadata: unknown }[]) {
    const id = identificadorDe(c.source_metadata);
    if (id) cliquePorContato.set(c.id, id);
  }
  if (cliquePorContato.size === 0) return [];

  const candidatos = agendamentos.filter((a) => a.contact_id !== null && cliquePorContato.has(a.contact_id));
  const { data: subidas, error: erroSubidas } = await admin
    .from("ad_conversion_uploads")
    .select("appointment_id")
    .eq("organization_id", org)
    .in("appointment_id", candidatos.map((a) => a.id));
  if (erroSubidas) throw new Error(`ad_conversion_uploads: ${erroSubidas.message}`);
  const jaSubiu = new Set(((subidas ?? []) as { appointment_id: string }[]).map((s) => s.appointment_id));

  return candidatos
    .filter((a) => !jaSubiu.has(a.id))
    .slice(0, limite)
    .map((agendamento) => ({ agendamento, clique: cliquePorContato.get(agendamento.contact_id as string)! }));
}

interface LinhaDeUpload {
  organization_id: string;
  appointment_id: string;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  conversion_value_cents: number;
  uploaded_at: string | null;
  status: "enviada" | "falhou" | "ignorada";
  error: string | null;
}

function linhaDeUpload(org: string, e: Elegivel, status: LinhaDeUpload["status"], erro: string | null, uploadedAt: string | null): LinhaDeUpload {
  return {
    organization_id: org,
    appointment_id: e.agendamento.id,
    ...e.clique,
    conversion_value_cents: Number(e.agendamento.paid_cents),
    uploaded_at: uploadedAt,
    status,
    error: erro,
  };
}

async function gravar(admin: SupabaseClient, linhas: LinhaDeUpload[]): Promise<void> {
  if (linhas.length === 0) return;
  const { error } = await admin.from("ad_conversion_uploads").insert(linhas);
  if (error) throw new Error(`ad_conversion_uploads (insert): ${error.message}`);
}

function linhaDeConversao(conta: ContaLida, e: Elegivel): LinhaDeConversao {
  const instante = new Date(e.agendamento.starts_at);
  return {
    ...e.clique,
    conversionAction: conta.conversion_action as string,
    conversionDateTime: formatarDataHoraDeConversao(instante, offsetEmMinutos(instante, e.agendamento.time_zone)),
    conversionValue: Number(e.agendamento.paid_cents) / 100,
    currencyCode: conta.currency ?? "BRL",
    orderId: e.agendamento.id,
  };
}

async function subirDaConta(admin: SupabaseClient, conta: ContaLida, agora: Date, limite: number): Promise<Omit<ResultadoDoUpload, "contas">> {
  const org = conta.organization_id;
  const elegiveis = await elegiveisDa(admin, conta, agora, limite);
  const parcial = { elegiveis: elegiveis.length, enviadas: 0, falhas: 0, ignoradas: 0, adiadas: 0 };
  if (elegiveis.length === 0) return parcial;

  if (!conta.conversion_action) {
    await gravar(admin, elegiveis.map((e) => linhaDeUpload(org, e, "ignorada", MOTIVO_SEM_CONVERSION_ACTION, null)));
    parcial.ignoradas = elegiveis.length;
    return parcial;
  }

  const r = await subirConversoes(
    conta.conversion_customer_id ?? conta.customer_id,
    elegiveis.map((e) => linhaDeConversao(conta, e)),
  );
  if (!r.ok) {
    const motivo = `${r.code}: ${r.motivo}`.slice(0, 500);
    logger.warn("[ads-conversion-upload] chamada ao Google falhou", { organization_id: org, ad_account_id: conta.id, code: r.code });
    const { error } = await admin
      .from("ad_accounts")
      .update({ last_error: motivo, updated_at: agora.toISOString() })
      .eq("id", conta.id)
      .eq("organization_id", org);
    if (error) throw new Error(`ad_accounts (last_error): ${error.message}`);
    await audit({
      action: "ads.sync_falhou",
      organizationId: org,
      resourceType: "ad_account",
      resourceId: conta.id,
      bypassedRls: true,
      metadata: { rotina: "ads-conversion-upload", code: r.code, motivo },
    });
    return parcial;
  }

  const gravadas: LinhaDeUpload[] = [];
  elegiveis.forEach((e, i) => {
    const resultado = r.valor[i] ?? { ok: false, erro: "SEM_RESULTADO" };
    if (resultado.ok || ERROS_QUE_VALEM_ENVIADA.has(resultado.erro)) {
      gravadas.push(linhaDeUpload(org, e, "enviada", null, agora.toISOString()));
      parcial.enviadas += 1;
    } else if (resultado.erro === ERRO_QUE_ADIA) {
      parcial.adiadas += 1;
    } else {
      gravadas.push(linhaDeUpload(org, e, "falhou", resultado.erro, null));
      parcial.falhas += 1;
    }
  });
  await gravar(admin, gravadas);

  if (parcial.enviadas > 0) {
    await audit({
      action: "ads.conversion_uploaded",
      organizationId: org,
      resourceType: "ad_account",
      resourceId: conta.id,
      bypassedRls: true,
      metadata: { enviadas: parcial.enviadas, falhas: parcial.falhas, ignoradas: parcial.ignoradas },
    });
  }
  return parcial;
}

/** Uma rodada: cada Conta ativa, na sua organização. Chamado pelo cron `ads-conversion-upload`. */
export async function subirConversoesDevidas(admin: SupabaseClient, opcoes: OpcoesDeUpload): Promise<ResultadoDoUpload> {
  const { agora, limite = 200 } = opcoes;
  const contas = await contasAtivas(admin);
  const total: ResultadoDoUpload = { contas: contas.length, elegiveis: 0, enviadas: 0, falhas: 0, ignoradas: 0, adiadas: 0 };
  for (const conta of contas) {
    const parcial = await subirDaConta(admin, conta, agora, limite);
    total.elegiveis += parcial.elegiveis;
    total.enviadas += parcial.enviadas;
    total.falhas += parcial.falhas;
    total.ignoradas += parcial.ignoradas;
    total.adiadas += parcial.adiadas;
  }
  return total;
}
