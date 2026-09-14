/**
 * CATEGORIAS DO LIVRO-CAIXA — `GET` lista, `PUT` cria-ou-altera (migration 0244).
 *
 * Uma categoria por organização e `slug` (`unique (organization_id, slug)`),
 * por isso o verbo é `PUT` e a gravação é um upsert: o `slug` é a identidade
 * que o Dono digita, e mandar a mesma categoria duas vezes tem que dar o mesmo
 * resultado. É também o que a ação de audit já declarada diz em voz alta —
 * `financeiro.categoria_salva`, não "criada".
 *
 * `match_terms` é o que `lib/financeiro/categorizar.ts` casa contra a descrição
 * do banco. Ele decide dinheiro, então o Zod recusa termo vazio aqui em vez de
 * deixar entrar um `''` que casaria com tudo.
 *
 * Service role: o `organization_id` vem de `authz.org.orgId`, NUNCA do body.
 * Escrita é `manager` (é dinheiro); leitura é `viewer` — a tela do Financeiro
 * mostra a categoria de cada lançamento a quem só olha.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const COLUNAS = "id, slug, name, kind, match_terms, created_at, updated_at";

/**
 * Os mesmos limites do CHECK da migration 0244 — 422 em vez de 500 de
 * constraint: `slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'`, `length(name) between 1
 * and 120`, `kind in ('income','expense')`.
 *
 * O teto de `match_terms` (50 termos, 80 caracteres cada) NÃO vem de CHECK
 * nenhum: é limite nosso, para que uma lista absurda não vire varredura cara
 * em toda importação. Está dito aqui para não parecer regra de banco.
 */
const salvarSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,60}$/, "O identificador usa minúsculas, números e hífen, de 2 a 61 caracteres."),
  name: z.string().trim().min(1, "A categoria precisa de nome.").max(120),
  kind: z.enum(["income", "expense"]),
  match_terms: z.array(z.string().trim().min(1, "Termo vazio casaria com tudo.").max(80)).max(50).default([]),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("viewer", { requestId, resource: "ledger_categories" });
  if (!authz.ok) return authz.response;

  const { data, error } = await createAdminClient()
    .from("ledger_categories")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .order("slug", { ascending: true });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("manager", { requestId, resource: "ledger_categories" });
  if (!authz.ok) return authz.response;

  const lido = salvarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, { requestId });
  }

  const { data, error } = await createAdminClient()
    .from("ledger_categories")
    .upsert(
      {
        organization_id: authz.org.orgId,
        slug: lido.data.slug,
        name: lido.data.name,
        kind: lido.data.kind,
        match_terms: lido.data.match_terms,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,slug" },
    )
    .select(COLUNAS)
    .single();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  await audit({
    action: "financeiro.categoria_salva",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "ledger_categories",
    resourceId: data.id,
    requestId,
    metadata: { slug: lido.data.slug, kind: lido.data.kind, termos: lido.data.match_terms.length },
  });
  return ok(data, { requestId });
}
