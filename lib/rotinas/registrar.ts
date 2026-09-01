/**
 * Toda rotina deixa rastro — o embrulho que grava `job_runs`.
 *
 * `comExecucaoDeRotina("nome", handler)` devolve um handler de rota que:
 *
 *   1. abre uma linha `running` em `job_runs` ANTES de chamar o handler;
 *   2. chama o handler;
 *   3. fecha a linha como `ok` (resposta 2xx — `stats` é o `data` do `ok()`)
 *      ou `failed` (resposta não-2xx, ou handler que lançou — `error` diz
 *      qual), com `finished_at` e `duration_ms`.
 *
 * O histórico existe para VIGIAR a rotina, nunca para derrubá-la: qualquer
 * falha ao escrever em `job_runs` é logada e o handler roda do mesmo jeito.
 * Resposta não-2xx conta como `failed` de propósito — o modo de falha clássico
 * do scheduler é o segredo errado, 403 em silêncio a cada minuto, e uma linha
 * `ok` ali esconderia exatamente o que a tabela existe para mostrar.
 *
 * O corpo da resposta é lido de um `clone()`: o `Response` original segue
 * intacto para o Next entregar ao cliente.
 *
 * Quem vigia as linhas é `lib/rotinas/vigia.ts`; quem diz quais rotinas
 * existem e com que período é `lib/rotinas/esperadas.ts`.
 */
import type { NextRequest } from "next/server";

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export type HandlerDeRotina = (req: NextRequest) => Promise<Response>;

type Fechamento =
  | { status: "ok"; stats: Record<string, unknown> }
  | { status: "failed"; error: string };

function mensagemDe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function abrirExecucao(jobName: string): Promise<string | null> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("job_runs")
      .insert({ job_name: jobName, status: "running", started_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error || !data?.id) {
      logger.warn("[rotinas] não conseguiu abrir a linha em job_runs", {
        job_name: jobName,
        error: error?.message ?? "sem id na resposta",
      });
      return null;
    }
    return String(data.id);
  } catch (err) {
    logger.warn("[rotinas] não conseguiu abrir a linha em job_runs", {
      job_name: jobName,
      error: mensagemDe(err),
    });
    return null;
  }
}

async function fecharExecucao(
  jobName: string,
  runId: string | null,
  inicioMs: number,
  fechamento: Fechamento,
): Promise<void> {
  if (runId === null) return;
  try {
    const admin = createAdminClient();
    const { error } = await admin
      .from("job_runs")
      .update({
        ...fechamento,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - inicioMs,
      })
      .eq("id", runId);
    if (error) {
      logger.warn("[rotinas] não conseguiu fechar a linha em job_runs", {
        job_name: jobName,
        run_id: runId,
        error: error.message,
      });
    }
  } catch (err) {
    logger.warn("[rotinas] não conseguiu fechar a linha em job_runs", {
      job_name: jobName,
      run_id: runId,
      error: mensagemDe(err),
    });
  }
}

/** Lê o corpo de um clone — o `Response` original segue com o corpo intacto. */
async function corpoJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const corpo: unknown = await res.clone().json();
    return corpo !== null && typeof corpo === "object" ? (corpo as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function fechamentoDaResposta(res: Response): Promise<Fechamento> {
  const corpo = await corpoJson(res);
  if (res.ok) {
    const data = corpo?.data;
    const stats =
      data !== null && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    return { status: "ok", stats };
  }
  const erro = corpo?.error;
  const detalhe =
    erro !== null && typeof erro === "object"
      ? `${String((erro as { code?: unknown }).code ?? "")}: ${String((erro as { message?: unknown }).message ?? "")}`
      : "";
  return { status: "failed", error: `HTTP ${res.status} ${detalhe}`.trim() };
}

export function comExecucaoDeRotina(jobName: string, handler: HandlerDeRotina): HandlerDeRotina {
  return async (req: NextRequest): Promise<Response> => {
    const inicioMs = Date.now();
    const runId = await abrirExecucao(jobName);

    let res: Response;
    try {
      res = await handler(req);
    } catch (err) {
      await fecharExecucao(jobName, runId, inicioMs, { status: "failed", error: mensagemDe(err) });
      throw err;
    }

    await fecharExecucao(jobName, runId, inicioMs, await fechamentoDaResposta(res));
    return res;
  };
}
