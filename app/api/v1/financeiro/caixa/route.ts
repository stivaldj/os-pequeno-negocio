/**
 * O CAIXA E O QUE VENCE — `GET /api/v1/financeiro/caixa`.
 *
 * Uma leitura só devolve as duas perguntas que a tela do Financeiro e o
 * Relatório das 8h (Fase 7) fazem juntas: quanto tem em caixa, e o que vence.
 * A rota NÃO calcula nada e, desde a Fase 7, NÃO lê o Postgres diretamente:
 * ela chama `caixaDaConta`/`vencimentosDaConta` (`lib/financeiro/relatorio.ts`,
 * a MESMA leitura que `lib/relatorio/financeiro.ts` usa para o relatório das
 * 8h) e só traduz o resultado para JSON. Ter uma segunda conta de caixa aqui
 * seria a duplicação sem fonte declarada que o `CLAUDE.md` proíbe — e as duas
 * divergiriam no primeiro ajuste.
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
import { caixaDaConta, vencimentosDaConta } from "@/lib/financeiro/relatorio";
import type { GrupoDeVencimento } from "@/lib/financeiro/vencimentos";
import { diaLocalISO } from "@/lib/agenda/fuso";
import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

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

  // O fuso da organização, com a mesma degradação que o resto do produto: valor
  // que o `Intl` recusa vira `FUSO_PADRAO` em vez de derrubar a tela do Dono.
  const { data: org } = await admin.from("organizations").select("timezone").eq("id", orgId).maybeSingle();
  const bruto = (org as { timezone: string | null } | null)?.timezone?.trim() ?? "";
  const fuso = bruto !== "" && fusoValido(bruto) ? bruto : FUSO_PADRAO;
  const hoje = diaLocalISO(new Date(), fuso);

  let caixa;
  let vencimentos;
  try {
    caixa = await caixaDaConta(admin, orgId);
    vencimentos = await vencimentosDaConta(admin, orgId, hoje);
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "erro ao ler o financeiro", 500, { requestId });
  }

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
