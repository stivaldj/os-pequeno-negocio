/**
 * Cron diário: a Verba do Google Ads entra em `ad_spend` (Spec 0003, Fase 5).
 * Mesma auth fail-closed das outras rotas de cron; registra `job_runs`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { sincronizarGasto } from "@/lib/ads/sync-gasto";
import { env } from "@/lib/env";
import { comExecucaoDeRotina } from "@/lib/rotinas/registrar";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted: string[] = [];
  if (env.INTERNAL_CRON_SECRET) accepted.push(env.INTERNAL_CRON_SECRET);
  if (env.INTERNAL_SECRET) accepted.push(env.INTERNAL_SECRET);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  const resultado = await sincronizarGasto(createAdminClient(), { agora: new Date() });
  return ok(resultado, { requestId });
}

export const GET = comExecucaoDeRotina("ads-spend-sync", handle);
