/**
 * OS LANÇAMENTOS DO LIVRO-CAIXA — `GET /api/v1/financeiro/lancamentos`.
 *
 * ⚠️ ACRÉSCIMO AO PLANO DA FASE 6, decidido na Tarefa 8. A Tarefa 6 entregou
 * `categorias`, `obrigacoes` e `caixa`, e nenhuma delas LISTA `ledger_entries`:
 * o `GET /caixa` lê a tabela, mas só para somar o que veio depois do saldo
 * declarado, e devolve contagem, não linha. O bloco "Últimos lançamentos" da
 * tela precisa das linhas — sem esta rota ele mostraria um número sem o extrato
 * que o produziu, que é justamente o que o Dono abre a tela para conferir
 * contra o app do banco.
 *
 * Leitura é `viewer`: extrato é para olhar; quem SOBE arquivo passa por
 * `manager` na rota de extratos. Service role (`createAdminClient()` bypassa
 * RLS), então o `organization_id` sai de `authz.org.orgId` — do gate — e nunca
 * do body nem da query string.
 *
 * JSON snake_case, dinheiro em `_cents` + `currency`, como o resto da
 * `/api/v1/`. Nenhum audit: leitura não muta.
 *
 * `key_source` VIAJA ATÉ A TELA de propósito. `'conteudo'` significa que o
 * banco não mandou FITID confiável e a chave de idempotência é dia + valor +
 * ordinal (decisão 6 do plano) — a linha é frágil, e esconder isso faria o Dono
 * confiar num extrato que pode duplicar ao reimportar período sobreposto.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, bank_id, account_id, account_kind, posted_on, amount_cents, currency, trn_type, description, key_source, source, category_id, created_at";

/**
 * O teto da página. 200 não é regra de negócio: é o que impede uma organização
 * com anos de extrato de derrubar a tela numa leitura só — o mesmo cuidado que
 * `caixa/route.ts` declara nos tetos dele.
 */
const TETO_DA_LISTA = 200;

/**
 * Dia do calendário, `YYYY-MM-DD`, que o Postgres aceitaria como `date`. Mesma
 * forma de `obrigacoes/route.ts`, e a duplicação está declarada lá: `route.ts`
 * do Next não exporta nada além dos verbos e das opções de rota, então não há
 * de onde compartilhar sem inventar um módulo que a fase não pediu.
 */
const dia = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "A data vai no formato AAAA-MM-DD.")
  .refine(
    (s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s,
    "Essa data não existe no calendário.",
  );

const listarSchema = z.object({
  limit: z.coerce.number().int().min(1).max(TETO_DA_LISTA).default(50),
  /** A conta como o OFX a nomeia (`ACCTID`), não um uuid: é a chave do banco. */
  account_id: z.string().trim().min(1).max(64).optional(),
  de: dia.optional(),
  ate: dia.optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("viewer", { requestId, resource: "ledger_entries" });
  if (!authz.ok) return authz.response;

  const lido = listarSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "filtro inválido", 422, { requestId });
  }

  let consulta = createAdminClient()
    .from("ledger_entries")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId);
  if (lido.data.account_id) consulta = consulta.eq("account_id", lido.data.account_id);
  if (lido.data.de) consulta = consulta.gte("posted_on", lido.data.de);
  if (lido.data.ate) consulta = consulta.lte("posted_on", lido.data.ate);

  // `posted_on desc` é a ordem do índice `idx_ledger_entries_org_dia`, e é a
  // ordem em que o Dono lê extrato: o de ontem primeiro.
  const { data, error } = await consulta.order("posted_on", { ascending: false }).limit(lido.data.limit);
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}
