import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `comExecucaoDeRotina` — o embrulho que faz toda rotina deixar rastro.
 *
 * O que se prova aqui é o CONTRATO com `job_runs`: abre `running` antes do
 * handler, fecha `ok`/`failed` depois, e — o ponto que mais importa — nunca
 * fica no caminho da rotina. Uma falha ao gravar o histórico é logada e o
 * handler roda do mesmo jeito; o histórico existe para vigiar a rotina, não
 * para derrubá-la.
 */

type Op = { op: string; payload?: unknown; filtro?: unknown };
const ops: Op[] = [];
let modo: "normal" | "insert_quebra" | "insert_lanca" = "normal";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela !== "job_runs") throw new Error(`tabela inesperada: ${tabela}`);
      return {
        insert: (payload: unknown) => {
          if (modo === "insert_lanca") throw new Error("postgrest fora do ar");
          ops.push({ op: "insert", payload });
          return {
            select: () => ({
              single: async () =>
                modo === "insert_quebra"
                  ? { data: null, error: { message: "relation job_runs does not exist" } }
                  : { data: { id: "run-1" }, error: null },
            }),
          };
        },
        update: (payload: unknown) => ({
          eq: async (coluna: string, valor: unknown) => {
            ops.push({ op: "update", payload, filtro: { [coluna]: valor } });
            return { error: null };
          },
        }),
      };
    },
  }),
}));

const logs: { nivel: string; msg: string; ctx?: unknown }[] = [];
vi.mock("@/lib/logger", () => ({
  logger: {
    info: (msg: string, ctx?: unknown) => logs.push({ nivel: "info", msg, ctx }),
    warn: (msg: string, ctx?: unknown) => logs.push({ nivel: "warn", msg, ctx }),
    error: (msg: string, ctx?: unknown) => logs.push({ nivel: "error", msg, ctx }),
    debug: () => {},
  },
}));

const { comExecucaoDeRotina } = await import("./registrar");

function req(): NextRequest {
  return new Request("http://app:3000/api/v1/cron/x") as unknown as NextRequest;
}

function inserido(): Record<string, unknown> {
  const i = ops.find((o) => o.op === "insert");
  if (!i) throw new Error("nenhum insert em job_runs");
  return i.payload as Record<string, unknown>;
}

function atualizado(): { payload: Record<string, unknown>; filtro: Record<string, unknown> } {
  const u = ops.find((o) => o.op === "update");
  if (!u) throw new Error("nenhum update em job_runs");
  return {
    payload: u.payload as Record<string, unknown>,
    filtro: u.filtro as Record<string, unknown>,
  };
}

beforeEach(() => {
  ops.length = 0;
  logs.length = 0;
  modo = "normal";
});

describe("comExecucaoDeRotina", () => {
  it("abre `running` antes do handler e fecha `ok` com finished_at, duration_ms e stats", async () => {
    const ordem: string[] = [];
    const handler = vi.fn(async () => {
      ordem.push(`handler(inserts=${ops.filter((o) => o.op === "insert").length})`);
      return Response.json({ data: { swept: 3, failed: 0 } });
    });

    const res = await comExecucaoDeRotina("x", handler)(req());

    expect(handler).toHaveBeenCalledTimes(1);
    // O insert veio ANTES do handler — é a linha `running` que o vigia vê.
    expect(ordem).toEqual(["handler(inserts=1)"]);
    expect(inserido()).toMatchObject({ job_name: "x", status: "running" });
    expect(typeof inserido().started_at).toBe("string");

    const { payload, filtro } = atualizado();
    expect(filtro).toEqual({ id: "run-1" });
    expect(payload.status).toBe("ok");
    expect(typeof payload.finished_at).toBe("string");
    expect(typeof payload.duration_ms).toBe("number");
    expect(payload.duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(payload.stats).toEqual({ swept: 3, failed: 0 });

    // A Response devolvida ainda tem corpo legível: o helper leu de um clone.
    expect(res.bodyUsed).toBe(false);
    await expect(res.json()).resolves.toEqual({ data: { swept: 3, failed: 0 } });
  });

  it("resposta sem corpo JSON fecha `ok` com stats vazio", async () => {
    const res = await comExecucaoDeRotina("x", async () => new Response("pong"))(req());
    expect(atualizado().payload).toMatchObject({ status: "ok", stats: {} });
    await expect(res.text()).resolves.toBe("pong");
  });

  it("resposta não-2xx (fail() da rota) fecha `failed` com o código do erro — e a Response segue igual", async () => {
    // O modo de falha do scheduler é justamente este: segredo errado, 403 em
    // silêncio a cada minuto. Uma linha `ok` aqui esconderia o defeito que a
    // tabela existe para mostrar.
    const res = await comExecucaoDeRotina("x", async () =>
      Response.json({ error: { code: "forbidden", message: "Cron secret missing or invalid." } }, { status: 403 }),
    )(req());
    expect(res.status).toBe(403);
    const { payload } = atualizado();
    expect(payload.status).toBe("failed");
    expect(String(payload.error)).toMatch(/403/);
    expect(String(payload.error)).toMatch(/forbidden/);
  });

  it("handler que lança fecha `failed` com o erro, e o erro é relançado", async () => {
    const embrulhado = comExecucaoDeRotina("x", async () => {
      throw new Error("explodiu no meio");
    });
    await expect(embrulhado(req())).rejects.toThrow("explodiu no meio");
    const { payload } = atualizado();
    expect(payload.status).toBe("failed");
    expect(payload.error).toBe("explodiu no meio");
    expect(typeof payload.finished_at).toBe("string");
  });

  it("insert que volta erro não impede o handler: roda, devolve, e o defeito vai para o log", async () => {
    modo = "insert_quebra";
    const handler = vi.fn(async () => Response.json({ data: { n: 1 } }));
    const res = await comExecucaoDeRotina("x", handler)(req());
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toEqual({ data: { n: 1 } });
    // Sem id de linha, não há o que fechar.
    expect(ops.filter((o) => o.op === "update")).toEqual([]);
    expect(logs.some((l) => l.nivel === "warn" && /job_runs/.test(l.msg))).toBe(true);
  });

  it("client que LANÇA ao gravar também não impede o handler", async () => {
    modo = "insert_lanca";
    const handler = vi.fn(async () => Response.json({ data: {} }));
    await comExecucaoDeRotina("x", handler)(req());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.nivel === "warn" && /job_runs/.test(l.msg))).toBe(true);
  });
});
