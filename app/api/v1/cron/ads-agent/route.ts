/**
 * Cron diário às 7h: o Agente de Anúncios lê a Verba e as consultas pagas e
 * PROPÕE ao Dono (ADR-0018, nível 1). Pool do processo (`getRequestPool`) e
 * config do seam de LLM por env, como o rascunho de resposta faz.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { ok, fail } from "@/lib/api/wrappers";
import { rodarParaTodasAsContas } from "@/lib/ads/agente/rodar";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/run-model-call";
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
  let pool;
  try {
    pool = getRequestPool();
  } catch {
    return fail("unavailable", "Agente de Anúncios indisponível (SUPABASE_DB_URL).", 503, { requestId });
  }
  const rodadas = await rodarParaTodasAsContas(createAdminClient(), pool, llmEdgeConfigFromEnv(env), { agora: new Date(), requestId });
  return ok({ contas: rodadas.length, rodadas }, { requestId });
}

export const GET = comExecucaoDeRotina("ads-agent", handle);
