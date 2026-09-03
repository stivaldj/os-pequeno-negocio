/**
 * GET /api/v1/cron/relatorio-diario
 *
 * Uma vez por dia, às 8h em Brasília (`0 11 * * *` UTC — o contêiner do
 * scheduler roda com `TZ: UTC`), todo Dono com WhatsApp configurado recebe o
 * resumo: atendimentos da noite, agenda de hoje, Verba e Sobra por Real de
 * ontem, propostas pendentes do Agente de Anúncios, caixa e o que vence hoje.
 * A regra vive em `lib/relatorio/`; esta rota só autentica e chama.
 *
 * Depois de `ads-agent` (7h) e `financeiro-lembretes` (7h20) de propósito: o
 * relatório lê propostas e lembretes já gerados no mesmo dia.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (fail-closed quando o
 * segredo falta). Espelha `app/api/v1/cron/financeiro-lembretes/route.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { enviarRelatorioParaTodasAsContas } from "@/lib/relatorio/enviar";
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

  const resumo = await enviarRelatorioParaTodasAsContas(createAdminClient(), new Date());

  return ok(
    {
      contas: resumo.contas,
      enviados: resumo.enviados,
      ja_enviados_hoje: resumo.jaEnviadosHoje,
      pulados: resumo.pulados,
      falhas: resumo.falhas,
    },
    { requestId },
  );
}

export const GET = comExecucaoDeRotina("relatorio-diario", handle);
