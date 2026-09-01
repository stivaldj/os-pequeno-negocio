/**
 * GET /api/v1/cron/rotinas-vigia
 *
 * O vigia das rotinas: de hora em hora, confere em `job_runs` se cada rotina
 * de `ROTINAS_ESPERADAS` rodou dentro da tolerância e, quando não, grava
 * `missing`, abre um `job_dead` na Central de avisos e audita. A regra vive em
 * `lib/rotinas/vigia.ts`; esta rota só autentica e chama.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (fail-closed quando o
 * segredo falta). Espelha `app/api/v1/cron/storage-redaction/route.ts`.
 *
 * Embrulhada em `comExecucaoDeRotina` como toda rotina — o vigia vigia a si
 * mesmo pela mesma tabela.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { comExecucaoDeRotina } from "@/lib/rotinas/registrar";
import { vigiar } from "@/lib/rotinas/vigia";
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

  const resultado = await vigiar(createAdminClient(), new Date());

  return ok(resultado, { requestId });
}

export const GET = comExecucaoDeRotina("rotinas-vigia", handle);
