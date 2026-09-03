/**
 * Caixa e vencimentos — lê `lib/financeiro/relatorio.ts` (a mesma leitura que
 * `GET /api/v1/financeiro/caixa` usa). `hoje` já vem calculado no fuso da
 * Conta por `janela.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { caixaDaConta, vencimentosDaConta } from "@/lib/financeiro/relatorio";
import type { Obrigacao } from "@/lib/financeiro/vencimentos";

import type { JanelaDoRelatorio } from "./janela";
import type { ItemDeVencimento, SecaoFinanceiro } from "./tipos";

function comoItem(o: Obrigacao): ItemDeVencimento {
  return { description: o.description, amountCents: o.amountCents, direction: o.direction, dueOn: o.dueOn };
}

export async function financeiroDeHoje(admin: SupabaseClient, janela: JanelaDoRelatorio): Promise<SecaoFinanceiro> {
  const caixa = await caixaDaConta(admin, janela.organizationId);
  const vencimentos = await vencimentosDaConta(admin, janela.organizationId, janela.hoje);

  return {
    caixaTotalCents: caixa.totalCents,
    vencemHojeCents: vencimentos.vencemHoje.totalCents,
    vencidasCents: vencimentos.vencidas.totalCents,
    vencemHojeItens: vencimentos.vencemHoje.itens.map(comoItem),
    vencidasItens: vencimentos.vencidas.itens.map(comoItem),
    incompleto: caixa.incompleto,
  };
}
