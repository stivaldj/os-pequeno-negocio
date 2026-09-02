/**
 * GET /api/v1/cron/ads-conversion-upload
 *
 * Uma vez por dia, devolve ao Google as consultas pagas (ADR-0017) pelo clique
 * que as trouxe — a conversão offline. A regra vive em `lib/ads/conversoes.ts`;
 * esta rota só autentica e chama. Sem as credenciais do Google Ads na
 * instalação (`googleAdsDisponivel`), não toca no banco: responde `pulado`.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (fail-closed quando o
 * segredo falta). Espelha `app/api/v1/cron/rotinas-vigia/route.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { subirConversoesDevidas } from "@/lib/ads/conversoes";
import { googleAdsDisponivel } from "@/lib/ads/google/config";
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

  if (!googleAdsDisponivel(env)) {
    return ok({ pulado: "google_ads_nao_configurado" }, { requestId });
  }

  const resultado = await subirConversoesDevidas(createAdminClient(), { agora: new Date() });

  return ok(resultado, { requestId });
}

export const GET = comExecucaoDeRotina("ads-conversion-upload", handle);
