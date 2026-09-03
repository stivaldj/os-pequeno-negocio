/**
 * Lê do banco os insumos de caixa e vencimentos de uma Conta e entrega aos
 * cálculos puros (`caixa.ts`, `vencimentos.ts`). Mesmo desenho de
 * `lib/ads/relatorio.ts`: tudo filtrado por `organization_id`, admin client
 * bypassa RLS.
 *
 * Extraído da rota `GET /api/v1/financeiro/caixa`, cujo cabeçalho já
 * antecipava este consumidor: "a tela do Financeiro e o Relatório das 8h
 * (Fase 7) fazem juntas" a mesma leitura. Duplicar o SELECT ali e aqui seria a
 * "duplicação sem fonte declarada" que o CLAUDE.md proíbe — as duas contas de
 * caixa divergiriam no primeiro ajuste.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { calcularCaixa, type EntradaDeCaixa, type LinhaDeLancamento, type LinhaDeSaldo, type ResultadoDeCaixa } from "./caixa";
import type { ContaKind } from "./ofx/tipos";
import { vencimentosDoDia, type Obrigacao, type ResultadoDeVencimentos } from "./vencimentos";

/** Teto de leitura — impede uma Conta com anos de extrato de derrubar a consulta. */
const TETO_DE_LANCAMENTOS = 5000;
const TETO_DE_OBRIGACOES = 1000;

interface LinhaDeSaldoDoBanco {
  bank_id: string | null;
  account_id: string;
  account_kind: string;
  kind: string;
  as_of: string;
  balance_cents: number | string;
}

interface LinhaDeLancamentoDoBanco {
  bank_id: string | null;
  account_id: string;
  account_kind: string;
  posted_on: string;
  amount_cents: number | string;
}

interface LinhaDeObrigacaoDoBanco {
  id: string;
  direction: string;
  description: string;
  amount_cents: number | string;
  due_on: string;
  status: string;
}

/** `bigint` do Postgres chega como número no JSON do PostgREST; `Number` é o cinto. */
const cents = (v: number | string): number => Number(v);

export async function insumosDeCaixa(admin: SupabaseClient, organizationId: string): Promise<EntradaDeCaixa> {
  const { data: saldosBrutos, error: erroDeSaldos } = await admin
    .from("ledger_balances")
    .select("bank_id, account_id, account_kind, kind, as_of, balance_cents")
    .eq("organization_id", organizationId);
  if (erroDeSaldos) throw new Error(`ledger_balances: ${erroDeSaldos.message}`);

  const saldos: LinhaDeSaldo[] = ((saldosBrutos ?? []) as LinhaDeSaldoDoBanco[]).map((s) => ({
    bankId: s.bank_id ?? "",
    acctId: s.account_id,
    kind: s.account_kind as ContaKind,
    tipo: s.kind as LinhaDeSaldo["tipo"],
    saldoEm: s.as_of,
    saldoCents: cents(s.balance_cents),
  }));

  // Só interessa ao caixa o que veio DEPOIS do saldo declarado pelo banco — o
  // corte é o menor `as_of` entre os saldos da organização.
  const corte = saldos.reduce<string | null>((menor, s) => (menor === null || s.saldoEm < menor ? s.saldoEm : menor), null);
  let consultaDeLancamentos = admin
    .from("ledger_entries")
    .select("bank_id, account_id, account_kind, posted_on, amount_cents")
    .eq("organization_id", organizationId);
  if (corte !== null) consultaDeLancamentos = consultaDeLancamentos.gte("posted_on", corte);
  const { data: lancamentosBrutos, error: erroDeLancamentos } = await consultaDeLancamentos
    .order("posted_on", { ascending: false })
    .limit(TETO_DE_LANCAMENTOS);
  if (erroDeLancamentos) throw new Error(`ledger_entries: ${erroDeLancamentos.message}`);

  const lancamentos: LinhaDeLancamento[] = ((lancamentosBrutos ?? []) as LinhaDeLancamentoDoBanco[]).map((l) => ({
    bankId: l.bank_id ?? "",
    acctId: l.account_id,
    kind: l.account_kind as ContaKind,
    dia: l.posted_on,
    valorCents: cents(l.amount_cents),
  }));

  return { saldos, lancamentos };
}

export async function caixaDaConta(admin: SupabaseClient, organizationId: string): Promise<ResultadoDeCaixa> {
  return calcularCaixa(await insumosDeCaixa(admin, organizationId));
}

export async function obrigacoesAbertas(admin: SupabaseClient, organizationId: string): Promise<Obrigacao[]> {
  const { data, error } = await admin
    .from("financial_obligations")
    .select("id, direction, description, amount_cents, due_on, status")
    .eq("organization_id", organizationId)
    .eq("status", "open")
    .order("due_on", { ascending: true })
    .limit(TETO_DE_OBRIGACOES);
  if (error) throw new Error(`financial_obligations: ${error.message}`);

  return ((data ?? []) as LinhaDeObrigacaoDoBanco[]).map((o) => ({
    id: o.id,
    direction: o.direction as Obrigacao["direction"],
    description: o.description,
    amountCents: cents(o.amount_cents),
    dueOn: o.due_on,
    status: o.status as Obrigacao["status"],
  }));
}

export async function vencimentosDaConta(
  admin: SupabaseClient,
  organizationId: string,
  hoje: string,
): Promise<ResultadoDeVencimentos> {
  return vencimentosDoDia(await obrigacoesAbertas(admin, organizationId), hoje);
}
