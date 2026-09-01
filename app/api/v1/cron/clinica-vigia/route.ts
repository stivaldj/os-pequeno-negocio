/**
 * GET /api/v1/cron/clinica-vigia
 *
 * O vigia do "não é ato médico" (ADR-0012), em observação: de hora em hora lê
 * as respostas do Agente da última hora nas Contas com a redação clínica
 * ligada e, quando uma parece prescrição, diagnóstico ou orientação
 * terapêutica, abre um item na Central de avisos e audita. A regra vive em
 * `lib/clinica/vigia.ts`; esta rota só autentica e chama.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (fail-closed quando o
 * segredo falta). Espelha `app/api/v1/cron/storage-redaction/route.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { vigiarAtoMedico } from "@/lib/clinica/vigia";
import { env } from "@/lib/env";
import { comExecucaoDeRotina } from "@/lib/rotinas/registrar";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";

  const cronSecret = env.INTERNAL_CRON_SECRET;
  const fallbackSecret = env.INTERNAL_SECRET;
  const accepted: string[] = [];
  if (cronSecret) accepted.push(cronSecret);
  if (fallbackSecret) accepted.push(fallbackSecret);

  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const resultado = await vigiarAtoMedico(createAdminClient(), { agora: new Date() });

  return ok(resultado, { requestId });
}

export const GET = comExecucaoDeRotina("clinica-vigia", handle);
