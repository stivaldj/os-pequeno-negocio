/**
 * GET /api/v1/cron/financeiro-lembretes
 *
 * Uma vez por dia, às 10:20 UTC — 07:20 em Brasília, porque o contêiner do
 * scheduler roda com `TZ: UTC` —, o Dono de cada Conta recebe pelo WhatsApp o que
 * vence hoje e o que já venceu — antes do Relatório das 8h, de propósito. A
 * regra vive em `lib/financeiro/lembretes.ts`; esta rota só autentica, resolve
 * o dia e chama. Quem audita é a lib, por Conta: rodada sem vencimento não
 * escreve linha nenhuma na trilha.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>` (fail-closed quando o
 * segredo falta). Espelha `app/api/v1/cron/clinica-vigia/route.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { diaCorrenteUtc, enviarLembretesDeVencimento } from "@/lib/financeiro/lembretes";
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

  const resultado = await enviarLembretesDeVencimento(createAdminClient(), {
    hoje: diaCorrenteUtc(new Date()),
  });

  // `candidatos` carrega o texto de cada aviso e não tem por que voltar no
  // corpo HTTP: o que interessa a quem lê o `job_runs` é a contagem.
  return ok(
    {
      hoje: resultado.hoje,
      contas: resultado.contas,
      obrigacoes: resultado.obrigacoes,
      enviados: resultado.enviados,
      pulados: resultado.pulados,
    },
    { requestId },
  );
}

export const GET = comExecucaoDeRotina("financeiro-lembretes", handle);
