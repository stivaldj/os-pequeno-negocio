/**
 * `POST /api/v1/financeiro/extratos` — a rota, FINA.
 *
 * Ela faz três coisas e nenhuma delas é regra: autentica, tira o arquivo do
 * multipart e delega. A decisão mora em `_handler.ts`, e a razão está lá — a
 * prova de realidade roda em vitest e não tem cookie para dar a `requireRole`.
 *
 * `manager`, e não `agent`: isto é dinheiro. Quem atende no WhatsApp não sobe
 * extrato bancário da casa.
 *
 * Service role: `createAdminClient()` bypassa RLS, então o `organization_id`
 * sai de `authz.org.orgId` — do cookie validado contra as memberships — e
 * NUNCA do corpo. O corpo pode até trazer um `organization_id`; ele não é lido
 * por ninguém.
 */
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

import { importarExtratoHandler } from "./_handler";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = req.headers.get("x-request-id") ?? randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ledger_entries" });
  if (!authz.ok) return authz.response;

  // Molde de `app/api/v1/contacts/import/route.ts`: o `formData()` lança quando
  // o corpo não é multipart, e a recusa ensina o nome do campo em vez de sair
  // como 500 de parse.
  let file: File;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (!(f instanceof File)) throw new Error("sem arquivo");
    file = f;
  } catch {
    return fail("validation_failed", "Envie o arquivo como multipart/form-data no campo 'file'.", 422, {
      requestId,
    });
  }

  return importarExtratoHandler(
    createAdminClient(),
    { organizationId: authz.org.orgId, requestId, actorUserId: authz.user.id },
    file,
  );
}
