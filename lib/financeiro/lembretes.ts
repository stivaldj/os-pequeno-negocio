/**
 * Lembretes de vencimento — o Dono fica sabendo, de manhã, o que vence hoje e
 * o que já venceu (Spec 0003, "O dinheiro"; migration 0209, Fase 6).
 *
 * ─── O que faz, 1×/dia ──────────────────────────────────────────────────────
 *
 * 1. Lê, de uma vez e para TODAS as Contas, as obrigações `open` com
 *    `due_on <= hoje` que ainda não foram lembradas HOJE.
 * 2. Agrupa por Conta e monta UM texto curto por Conta — não uma mensagem por
 *    boleto: cinco linhas de WhatsApp de manhã é aviso; vinte é ruído que o
 *    Dono aprende a ignorar, e aí o lembrete deixa de existir na prática.
 * 3. Manda por `enviarAoDono` (`lib/dono/`), que resolve contato, conversa e
 *    canal e NUNCA lança — devolve `{ ok: false, motivo }`.
 * 4. Marca `reminder_sent_on = hoje` **só quando o envio deu certo**, e audita
 *    `financeiro.lembrete_enviado` por Conta.
 *
 * ─── A cláusula que não pode ser abreviada ──────────────────────────────────
 *
 * O recorte de "ainda não lembrada hoje" é `reminder_sent_on is null OR
 * reminder_sent_on <> hoje`. A coluna NASCE NULA, e em SQL `NULL <> '2026-09-02'`
 * é `NULL` — que o `WHERE` descarta. Sem o `is null`, a PRIMEIRA rodada de cada
 * obrigação não manda nada, e o modo de falha é mudo: 200 na rota, `job_runs`
 * `ok`, zero candidatos, ninguém avisado. O `comment on column` da migration
 * 0209 diz isso em voz alta, e `lembretes.test.ts` tem o caso com esse nome.
 *
 * ─── Falha de envio NÃO marca ───────────────────────────────────────────────
 *
 * A lição de `lib/agenda/lembretes.ts`: marcar antes de saber que saiu troca
 * "o Dono é avisado amanhã" por "o Dono nunca é avisado desta conta". Canal
 * caído, sessão arquivada, número não configurado — tudo isso é `{ ok: false }`
 * e deixa a obrigação intacta para a rodada seguinte.
 *
 * ─── Sem Conteúdo Clínico ───────────────────────────────────────────────────
 *
 * O texto carrega `description`, valor e dia — o que o Dono digitou no cadastro
 * da conta. Nada é inventado sobre paciente, e nenhuma outra coluna entra
 * (ADR-0004, ADR-0012).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { enviarAoDono } from "@/lib/dono/destinatario";
import { logger } from "@/lib/logger";
import { formatCentsBRL } from "@/lib/money";

import { vencimentosDoDia, type DirecaoDaObrigacao, type Obrigacao, type ResultadoDeVencimentos } from "./vencimentos";

/**
 * Quantos itens cabem numa mensagem antes de ela virar parede de texto. O resto
 * vira "E mais N." — o número, sozinho, já diz ao Dono que ele precisa abrir a
 * tela Financeiro.
 */
const MAX_ITENS = 5;

export interface OpcoesDeLembreteDeVencimento {
  /** `YYYY-MM-DD` resolvido pelo chamador — este módulo nunca chama `new Date()`. */
  hoje: string;
  /** Lista os candidatos sem enviar, sem marcar e sem auditar. */
  dryRun?: boolean;
}

/** O que uma Conta tem a receber de aviso nesta rodada. */
export interface CandidatoDeLembrete {
  organizationId: string;
  vencimentos: ResultadoDeVencimentos;
  texto: string;
}

export interface ContaPulada {
  organizationId: string;
  motivo: string;
}

export interface ResultadoDosLembretesDeVencimento {
  hoje: string;
  /** Contas com pelo menos uma obrigação vencendo hoje ou já vencida. */
  contas: number;
  /** Obrigações que entraram no recorte, somando todas as Contas. */
  obrigacoes: number;
  /** Contas cujo aviso saiu de fato. */
  enviados: number;
  candidatos: CandidatoDeLembrete[];
  pulados: ContaPulada[];
}

/** Linha de `financial_obligations` como o PostgREST a devolve. */
interface LinhaDeObrigacao {
  id: string;
  organization_id: string;
  direction: DirecaoDaObrigacao;
  description: string;
  amount_cents: number;
  due_on: string;
  status: "open" | "paid" | "cancelled";
}

/**
 * O dia corrente em UTC, `YYYY-MM-DD`. Serve ao cron das 10:20 UTC (07:20 em
 * Brasília): o Brasil está ATRÁS de UTC, então de manhã ainda é o mesmo dia
 * civil aqui — e `due_on`
 * é `date` (sem fuso) dos dois lados da comparação.
 */
export function diaCorrenteUtc(agora: Date = new Date()): string {
  return agora.toISOString().slice(0, 10);
}

/**
 * As obrigações abertas que vencem hoje ou já venceram e que ainda não foram
 * lembradas hoje — de TODAS as Contas, numa consulta só.
 */
async function obrigacoesALembrar(admin: SupabaseClient, hoje: string): Promise<LinhaDeObrigacao[]> {
  const { data, error } = await admin
    .from("financial_obligations")
    .select("id, organization_id, direction, description, amount_cents, due_on, status")
    .eq("status", "open")
    .lte("due_on", hoje)
    // ⚠️ `is.null` PRIMEIRO e obrigatório: sem ele a primeira rodada é vazia.
    .or(`reminder_sent_on.is.null,reminder_sent_on.neq.${hoje}`)
    .order("due_on", { ascending: true });
  if (error) throw new Error(`financial_obligations: ${error.message}`);
  return (data ?? []) as LinhaDeObrigacao[];
}

function comoObrigacao(linha: LinhaDeObrigacao): Obrigacao {
  return {
    id: linha.id,
    direction: linha.direction,
    description: linha.description,
    amountCents: linha.amount_cents,
    dueOn: linha.due_on,
    status: linha.status,
  };
}

/** Ordem estável por Conta, preservando a ordem de `due_on` que veio do banco. */
function porConta(linhas: LinhaDeObrigacao[]): Map<string, Obrigacao[]> {
  const mapa = new Map<string, Obrigacao[]>();
  for (const linha of linhas) {
    const lista = mapa.get(linha.organization_id) ?? [];
    lista.push(comoObrigacao(linha));
    mapa.set(linha.organization_id, lista);
  }
  return mapa;
}

/** `dd/mm` no mesmo ano; com o ano quando a conta atrasou o bastante para ele importar. */
function diaCurto(dia: string, hoje: string): string {
  const [ano, mes, d] = dia.split("-");
  return ano === hoje.slice(0, 4) ? `${d}/${mes}` : `${d}/${mes}/${ano}`;
}

/** "R$ 1.000,00 a pagar e R$ 200,00 a receber" — nunca um número só: as direções não se somam. */
function totalEmPalavras(total: Record<DirecaoDaObrigacao, number>): string {
  const partes: string[] = [];
  if (total.payable > 0) partes.push(`${formatCentsBRL(total.payable)} a pagar`);
  if (total.receivable > 0) partes.push(`${formatCentsBRL(total.receivable)} a receber`);
  return partes.join(" e ");
}

function contagem(n: number, singular: string, plural: string): string {
  return n === 1 ? `1 ${singular}` : `${n} ${plural}`;
}

/**
 * O texto ao Dono, no molde do vigia (`lib/rotinas/vigia.ts`): direto, curto e
 * SEM instrução de operador. Quem lê é quem paga.
 */
export function textoDoLembrete(vencimentos: ResultadoDeVencimentos): string {
  const { hoje, vencemHoje, vencidas } = vencimentos;
  const linhas: string[] = [];

  if (vencemHoje.itens.length > 0) {
    linhas.push(
      `${contagem(vencemHoje.itens.length, "conta vence", "contas vencem")} hoje: ` +
        `${totalEmPalavras(vencemHoje.totalCents)}.`,
    );
  }
  if (vencidas.itens.length > 0) {
    linhas.push(
      `${contagem(vencidas.itens.length, "conta já venceu", "contas já venceram")}: ` +
        `${totalEmPalavras(vencidas.totalCents)}.`,
    );
  }

  // Hoje antes de vencidas: é a decisão do dia. Dentro de vencidas, a mais
  // velha primeiro — `vencimentosDoDia` já entrega assim.
  const itens = [...vencemHoje.itens, ...vencidas.itens];
  for (const item of itens.slice(0, MAX_ITENS)) {
    const sinal = item.direction === "payable" ? "a pagar" : "a receber";
    const quando = item.dueOn === hoje ? "hoje" : `venceu em ${diaCurto(item.dueOn, hoje)}`;
    linhas.push(`- ${item.description}: ${formatCentsBRL(item.amountCents)} ${sinal}, ${quando}`);
  }
  const resto = itens.length - MAX_ITENS;
  if (resto > 0) linhas.push(`E mais ${resto}.`);

  return linhas.join("\n");
}

async function marcarLembradas(
  admin: SupabaseClient,
  orgId: string,
  ids: string[],
  hoje: string,
): Promise<string | null> {
  const { error } = await admin
    .from("financial_obligations")
    .update({ reminder_sent_on: hoje })
    // Service role bypassa RLS: o filtro de Conta é manual e vem do que foi
    // lido acima, nunca de entrada externa.
    .eq("organization_id", orgId)
    .in("id", ids);
  return error ? error.message : null;
}

export async function enviarLembretesDeVencimento(
  admin: SupabaseClient,
  opts: OpcoesDeLembreteDeVencimento,
): Promise<ResultadoDosLembretesDeVencimento> {
  const { hoje, dryRun = false } = opts;
  const linhas = await obrigacoesALembrar(admin, hoje);
  const agrupadas = porConta(linhas);

  const candidatos: CandidatoDeLembrete[] = [];
  const pulados: ContaPulada[] = [];
  let enviados = 0;

  for (const [organizationId, obrigacoes] of agrupadas) {
    const vencimentos = vencimentosDoDia(obrigacoes, hoje);
    const texto = textoDoLembrete(vencimentos);
    candidatos.push({ organizationId, vencimentos, texto });

    if (dryRun) continue;

    const envio = await enviarAoDono(admin, organizationId, texto);
    if (!envio.ok) {
      // Não marca: a rodada de amanhã tenta de novo. `enviarAoDono` já logou.
      pulados.push({ organizationId, motivo: envio.motivo });
      continue;
    }

    const erroDaMarca = await marcarLembradas(
      admin,
      organizationId,
      obrigacoes.map((o) => o.id),
      hoje,
    );
    if (erroDaMarca) {
      // O aviso SAIU; só a marca não. Registrar e seguir para as outras Contas
      // — derrubar a rodada aqui calaria o lembrete de todo mundo por causa do
      // erro de banco de uma Conta só.
      logger.warn("[financeiro-lembretes] reminder_sent_on não marcado", {
        organization_id: organizationId,
        error: erroDaMarca.slice(0, 200),
      });
      pulados.push({ organizationId, motivo: `marca_falhou:${erroDaMarca.slice(0, 80)}` });
    }

    enviados += 1;
    await audit({
      action: "financeiro.lembrete_enviado",
      organizationId,
      resourceType: "organization",
      resourceId: organizationId,
      bypassedRls: true,
      metadata: {
        hoje,
        vencem_hoje: vencimentos.vencemHoje.itens.length,
        vencidas: vencimentos.vencidas.itens.length,
        total_a_pagar_cents:
          vencimentos.vencemHoje.totalCents.payable + vencimentos.vencidas.totalCents.payable,
        total_a_receber_cents:
          vencimentos.vencemHoje.totalCents.receivable + vencimentos.vencidas.totalCents.receivable,
      },
    });
  }

  return {
    hoje,
    contas: agrupadas.size,
    obrigacoes: linhas.length,
    enviados,
    candidatos,
    pulados,
  };
}
