/**
 * CONTAS A PAGAR E A RECEBER — `GET` lista, `POST` cadastra (migration 0244).
 *
 * Uma tabela só para as duas contas, com `direction` (decisão 4 do plano da
 * Fase 6: o `CONTEXT.md` define "Compromisso financeiro com data" numa entrada
 * única de glossário). O sinal do compromisso é a `direction`, NUNCA o valor —
 * por isso o CHECK do banco é `amount_cents > 0` e o Zod aqui repete o mesmo
 * limite, para que valor zero ou negativo volte 422 e não 500 de constraint.
 *
 * `ledger_entry_id` existe no schema e NÃO entra nesta API: a conciliação entre
 * lançamento e obrigação não nasce nesta fase (ver "O que este plano não faz").
 * A coluna espera; a rota não finge que ela já funciona.
 *
 * Service role: o `organization_id` vem de `authz.org.orgId`, NUNCA do body.
 * Escrita é `manager` (é dinheiro); leitura é `viewer`.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, direction, description, amount_cents, currency, due_on, status, paid_on, paid_cents, category_id, reminder_sent_on, created_at, updated_at";

/** Um teto para a listagem: a tela pagina, e `select *` sem limite não é API. */
const TETO_DA_LISTA = 500;

/**
 * Dia do calendário, `YYYY-MM-DD`, que o Postgres aceitaria como `date`.
 *
 * A forma é a mesma do irmão `obrigacoes/[id]/route.ts`. A duplicação é
 * declarada e deliberada: `route.ts` do Next não pode exportar nada além dos
 * verbos e das opções de rota (o type-check do build reprova export estranho),
 * então não há de onde compartilhar sem inventar um módulo que a Fase 6 não
 * pediu. Sete linhas repetidas com a fonte escrita valem menos dívida que um
 * arquivo a mais fora do plano.
 */
const dia = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "A data vai no formato AAAA-MM-DD.")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, "Essa data não existe no calendário.");

/** Os mesmos limites dos CHECK da 0244: `direction`, `length(description) between 1 and 200`, `amount_cents > 0`, `currency char(3)`. */
const criarSchema = z.object({
  direction: z.enum(["payable", "receivable"]),
  description: z.string().trim().min(1, "A conta precisa de descrição.").max(200),
  amount_cents: z.number().int().positive("O valor é positivo: quem diz pagar ou receber é a direção, não o sinal."),
  currency: z.string().trim().toUpperCase().length(3).default("BRL"),
  due_on: dia,
  category_id: z.string().uuid().nullish(),
});

const listarSchema = z.object({
  status: z.enum(["open", "paid", "cancelled", "todas"]).default("open"),
  direction: z.enum(["payable", "receivable"]).optional(),
  limit: z.coerce.number().int().min(1).max(TETO_DA_LISTA).default(200),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("viewer", { requestId, resource: "financial_obligations" });
  if (!authz.ok) return authz.response;

  const lido = listarSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "filtro inválido", 422, { requestId });
  }

  let consulta = createAdminClient()
    .from("financial_obligations")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId);
  if (lido.data.status !== "todas") consulta = consulta.eq("status", lido.data.status);
  if (lido.data.direction) consulta = consulta.eq("direction", lido.data.direction);

  const { data, error } = await consulta.order("due_on", { ascending: true }).limit(lido.data.limit);
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("manager", { requestId, resource: "financial_obligations" });
  if (!authz.ok) return authz.response;

  const lido = criarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, { requestId });
  }

  const { data, error } = await createAdminClient()
    .from("financial_obligations")
    .insert({
      organization_id: authz.org.orgId,
      direction: lido.data.direction,
      description: lido.data.description,
      amount_cents: lido.data.amount_cents,
      currency: lido.data.currency,
      due_on: lido.data.due_on,
      category_id: lido.data.category_id ?? null,
    })
    .select(COLUNAS)
    .single();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  await audit({
    action: "financeiro.obrigacao_criada",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "financial_obligations",
    resourceId: data.id,
    requestId,
    metadata: {
      direction: lido.data.direction,
      amount_cents: lido.data.amount_cents,
      currency: lido.data.currency,
      due_on: lido.data.due_on,
    },
  });
  return ok(data, { status: 201, requestId });
}
