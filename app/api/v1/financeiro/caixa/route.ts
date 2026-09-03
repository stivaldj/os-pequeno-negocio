/**
 * O CAIXA E O QUE VENCE — `GET /api/v1/financeiro/caixa`.
 *
 * Uma leitura só devolve as duas perguntas que a tela do Financeiro e o
 * Relatório das 8h (Fase 7) fazem juntas: quanto tem em caixa, e o que vence.
 * A rota NÃO calcula nada: ela lê o Postgres, traduz as linhas para as
 * interfaces dos módulos puros e delega a `calcularCaixa` (`lib/financeiro/
 * caixa.ts`) e `vencimentosDoDia` (`lib/financeiro/vencimentos.ts`). Quem
 * decide dinheiro é aquele par de arquivos, testado sem banco; ter uma segunda
 * conta de caixa aqui seria a duplicação sem fonte declarada que o `CLAUDE.md`
 * proíbe — e as duas divergiriam no primeiro ajuste.
 *
 * ⚠️ O `hoje` é resolvido AQUI, não lá dentro. Os módulos puros nunca chamam
 * `new Date()` de propósito (é o que os torna testáveis e determinísticos), e
 * "hoje" depende do fuso: para a clínica de Manaus, às 22h de São Paulo ainda é
 * o dia anterior, e uma conta venceria um dia antes na tela. O fuso sai de
 * `organizations.timezone` — o que a PESSOA escolheu no onboarding, a mesma
 * fonte que `lib/agent-engine/agent/fuso-da-org.ts` documenta —, e degrada para
 * `FUSO_PADRAO` quando a coluna traz algo que o `Intl` recusa (ela não tem
 * CHECK, e nenhum escritor a valida).
 *
 * ⚠️ O corte da leitura de lançamentos. Só interessa ao caixa o que veio DEPOIS
 * do saldo declarado pelo banco, então a consulta filtra por `posted_on >=` o
 * MENOR `as_of` entre os saldos da organização. Conta sem saldo nenhum já sai
 * `incompleto: true` e não entra no total — dela, `lancamentos_depois` é
 * informação, não dinheiro, e pode vir recortada por esse mesmo corte. Está
 * dito aqui para que ninguém leia aquele número como "tudo o que existe".
 *
 * Leitura é `viewer`: caixa é para olhar. Service role filtrando
 * `organization_id` de `authz.org.orgId` à mão, nunca do body.
 *
 * O JSON sai em snake_case (as interfaces dos módulos são camelCase — a
 * tradução é nesta rota, nas duas pontas) e dinheiro sai em `_cents`.
 */
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { calcularCaixa, type LinhaDeLancamento, type LinhaDeSaldo } from "@/lib/financeiro/caixa";
import { vencimentosDoDia, type GrupoDeVencimento, type Obrigacao } from "@/lib/financeiro/vencimentos";
import type { ContaKind } from "@/lib/financeiro/ofx/tipos";
import { diaLocalISO } from "@/lib/agenda/fuso";
import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Tetos de leitura. Não são regra de negócio: são o limite que impede uma
 * organização com anos de extrato de derrubar a tela. `calcularCaixa` só usa o
 * que veio depois do saldo, e essa janela é curta na prática.
 */
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

function grupoEmSnakeCase(g: GrupoDeVencimento) {
  return {
    itens: g.itens.map((o) => ({
      id: o.id,
      direction: o.direction,
      description: o.description,
      amount_cents: o.amountCents,
      due_on: o.dueOn,
      status: o.status,
    })),
    total_cents: g.totalCents,
  };
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("viewer", { requestId, resource: "ledger_balances" });
  if (!authz.ok) return authz.response;

  const orgId = authz.org.orgId;
  const admin = createAdminClient();

  const { data: saldosBrutos, error: erroDeSaldos } = await admin
    .from("ledger_balances")
    .select("bank_id, account_id, account_kind, kind, as_of, balance_cents")
    .eq("organization_id", orgId);
  if (erroDeSaldos) return fail("internal_error", erroDeSaldos.message, 500, { requestId });

  const saldos: LinhaDeSaldo[] = ((saldosBrutos ?? []) as LinhaDeSaldoDoBanco[]).map((s) => ({
    bankId: s.bank_id ?? "",
    acctId: s.account_id,
    // ⚠️ As duas colunas trocam de nome ao virar `LinhaDeSaldo`: `account_kind`
    // (banco ou cartão) é o `kind` da conta, e a coluna `kind` do saldo
    // (`ledger`/`available`) é o `tipo`.
    kind: s.account_kind as ContaKind,
    tipo: s.kind as LinhaDeSaldo["tipo"],
    saldoEm: s.as_of,
    saldoCents: cents(s.balance_cents),
  }));

  const corte = saldos.reduce<string | null>((menor, s) => (menor === null || s.saldoEm < menor ? s.saldoEm : menor), null);
  let consultaDeLancamentos = admin
    .from("ledger_entries")
    .select("bank_id, account_id, account_kind, posted_on, amount_cents")
    .eq("organization_id", orgId);
  if (corte !== null) consultaDeLancamentos = consultaDeLancamentos.gte("posted_on", corte);
  const { data: lancamentosBrutos, error: erroDeLancamentos } = await consultaDeLancamentos
    .order("posted_on", { ascending: false })
    .limit(TETO_DE_LANCAMENTOS);
  if (erroDeLancamentos) return fail("internal_error", erroDeLancamentos.message, 500, { requestId });

  const lancamentos: LinhaDeLancamento[] = ((lancamentosBrutos ?? []) as LinhaDeLancamentoDoBanco[]).map((l) => ({
    bankId: l.bank_id ?? "",
    acctId: l.account_id,
    kind: l.account_kind as ContaKind,
    dia: l.posted_on,
    valorCents: cents(l.amount_cents),
  }));

  const { data: obrigacoesBrutas, error: erroDeObrigacoes } = await admin
    .from("financial_obligations")
    .select("id, direction, description, amount_cents, due_on, status")
    .eq("organization_id", orgId)
    .eq("status", "open")
    .order("due_on", { ascending: true })
    .limit(TETO_DE_OBRIGACOES);
  if (erroDeObrigacoes) return fail("internal_error", erroDeObrigacoes.message, 500, { requestId });

  const obrigacoes: Obrigacao[] = ((obrigacoesBrutas ?? []) as LinhaDeObrigacaoDoBanco[]).map((o) => ({
    id: o.id,
    direction: o.direction as Obrigacao["direction"],
    description: o.description,
    amountCents: cents(o.amount_cents),
    dueOn: o.due_on,
    status: o.status as Obrigacao["status"],
  }));

  // O fuso da organização, com a mesma degradação que o resto do produto: valor
  // que o `Intl` recusa vira `FUSO_PADRAO` em vez de derrubar a tela do Dono.
  const { data: org } = await admin.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
  const bruto = (org as { timezone: string | null } | null)?.timezone?.trim() ?? "";
  const fuso = bruto !== "" && fusoValido(bruto) ? bruto : FUSO_PADRAO;
  const hoje = diaLocalISO(new Date(), fuso);

  const caixa = calcularCaixa({ saldos, lancamentos });
  const vencimentos = vencimentosDoDia(obrigacoes, hoje);

  return ok(
    {
      hoje,
      fuso,
      caixa: {
        total_cents: caixa.totalCents,
        incompleto: caixa.incompleto,
        contas: caixa.contas.map((c) => ({
          bank_id: c.bankId,
          account_id: c.acctId,
          account_kind: c.kind,
          saldo_cents: c.saldoCents,
          saldo_em: c.saldoEm,
          lancamentos_depois: c.lancamentosDepois,
          soma_depois_cents: c.somaDepoisCents,
          saldo_estimado_cents: c.saldoEstimadoCents,
          incompleto: c.incompleto,
        })),
      },
      vencimentos: {
        hoje: vencimentos.hoje,
        vencem_hoje: grupoEmSnakeCase(vencimentos.vencemHoje),
        vencidas: grupoEmSnakeCase(vencimentos.vencidas),
        proximos_7_dias: grupoEmSnakeCase(vencimentos.proximos7),
      },
    },
    { requestId },
  );
}
