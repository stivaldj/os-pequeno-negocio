/**
 * GET /api/v1/cron/agenda-lembretes
 *
 * O lembrete de consulta: a cada 10 min manda, pela conversa do Paciente, o
 * aviso dos agendamentos cujo tipo tem `reminder_enabled` e cuja janela
 * (`reminder_minutes_before`) chegou; marca `reminder_sent_at` e audita. A
 * regra vive em `lib/agenda/lembretes.ts`; esta rota só autentica e chama.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (fail-closed quando o
 * segredo falta). Espelha `app/api/v1/cron/rotinas-vigia/route.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { enviarLembretesDevidos } from "@/lib/agenda/lembretes";
import { ok, fail } from "@/lib/api/wrappers";
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

  const resultado = await enviarLembretesDevidos(createAdminClient(), { agora: new Date() });

  return ok(resultado, { requestId });
}

export const GET = comExecucaoDeRotina("agenda-lembretes", handle);
