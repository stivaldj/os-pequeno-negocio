/**
 * ALTERAR UMA CONTA A PAGAR OU A RECEBER — `PATCH /api/v1/financeiro/obrigacoes/[id]`.
 *
 * É por aqui que a BAIXA acontece: a conciliação automática entre lançamento e
 * obrigação não nasce nesta fase, então quem dá a conta por paga é o Dono, na
 * tela.
 *
 * ⚠️ `status: "paid"` EXIGE `paid_on` no mesmo corpo. A constraint
 * `financial_obligations_baixa_coerente` (`status <> 'paid' or paid_on is not
 * null`) recusaria a gravação de qualquer jeito — mas recusaria como erro do
 * Postgres, que chegaria ao Dono como 500 e "algo deu errado". O Zod recusa
 * antes, com 422 e uma frase que diz o que falta. É a mesma disciplina do
 * resto da API: os limites do CHECK repetidos no schema de entrada.
 *
 * `direction` não se altera: a direção é a identidade do compromisso ("pagar"
 * e "receber" são entradas diferentes do caixa). Quem errou a direção cancela e
 * cadastra de novo — trocar em silêncio moveria dinheiro de lado no Relatório
 * das 8h sem nada registrar.
 *
 * Service role: o `organization_id` vem de `authz.org.orgId` e entra como
 * FILTRO do update. Obrigação de outra organização é 404, nunca 403 — a
 * resposta não confirma que aquele id existe em outro tenant.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const COLUNAS =
  "id, direction, description, amount_cents, currency, due_on, status, paid_on, paid_cents, category_id, reminder_sent_on, created_at, updated_at";

/**
 * Dia do calendário, `YYYY-MM-DD`. Mesma forma do irmão `../route.ts`, e a
 * duplicação está declarada lá: `route.ts` do Next não exporta nada além dos
 * verbos, então não há de onde compartilhar sem um módulo que o plano da Fase 6
 * não pediu.
 */
const dia = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "A data vai no formato AAAA-MM-DD.")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, "Essa data não existe no calendário.");

/** Os mesmos limites dos CHECK da 0244 — 422 em vez de 500 de constraint. */
const alterarSchema = z
  .object({
    description: z.string().trim().min(1).max(200).optional(),
    amount_cents: z.number().int().positive("O valor é positivo: quem diz pagar ou receber é a direção, não o sinal.").optional(),
    due_on: dia.optional(),
    status: z.enum(["open", "paid", "cancelled"]).optional(),
    paid_on: dia.nullish(),
    paid_cents: z.number().int().min(0).nullish(),
    category_id: z.string().uuid().nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, "Não veio nada para alterar.")
  .refine(
    (v) => v.status !== "paid" || (typeof v.paid_on === "string" && v.paid_on.length > 0),
    "Para dar a conta por paga é preciso dizer o dia do pagamento (paid_on).",
  );

const idSchema = z.string().uuid("O identificador da conta é um uuid.");

interface Contexto {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, ctx: Contexto): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("manager", { requestId, resource: "financial_obligations" });
  if (!authz.ok) return authz.response;

  const { id: idBruto } = await ctx.params;
  const idLido = idSchema.safeParse(idBruto);
  if (!idLido.success) {
    return fail("validation_failed", idLido.error.issues[0]?.message ?? "id inválido", 422, { requestId });
  }
  // O nome importa: `tests/unit/audit-resource-id-e-uuid.test.ts` varre o campo
  // de recurso de todo audit e cobra que a expressão se pareça com um id — a
  // coluna `api_audit_log.resource_id` é `uuid`, e chave natural ali estoura o
  // INSERT do audit sem bloquear a mutação (a trilha some em silêncio).
  const id = idLido.data;

  const lido = alterarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, { requestId });
  }

  // Só o que veio no corpo entra no update: `undefined` significa "não mexa",
  // e `null` significa "apague" — os dois chegam aqui distinguidos de propósito
  // (`paid_on: null` é como se desfaz uma baixa errada).
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const campo of ["description", "amount_cents", "due_on", "status", "paid_on", "paid_cents", "category_id"] as const) {
    if (lido.data[campo] !== undefined) patch[campo] = lido.data[campo];
  }

  const { data, error } = await createAdminClient()
    .from("financial_obligations")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select(COLUNAS)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Conta não encontrada.", 404, { requestId });

  await audit({
    action: "financeiro.obrigacao_alterada",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "financial_obligations",
    resourceId: id,
    requestId,
    metadata: { campos: Object.keys(patch).filter((k) => k !== "updated_at"), status: data.status },
  });
  return ok(data, { requestId });
}
