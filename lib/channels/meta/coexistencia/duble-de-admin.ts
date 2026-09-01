/**
 * Dublê de admin client para os testes da Coexistência — o mesmo que
 * `tests/unit/channel-ingest-zernio.test.ts` usa, enxuto. Registra cada
 * operação e responde o que o teste programou. Vive ao lado dos testes para
 * os três consumidores compartilharem um só.
 */
import { vi } from "vitest";

export interface Op {
  tabela: string;
  op: string;
  payload?: unknown;
  filtros: [string, unknown][];
}

export function novoDuble() {
  const ops: Op[] = [];
  const respostas: Record<string, unknown> = {
    fn_upsert_wa_contact: "contact-1",
    fn_upsert_wa_conversation: "conv-1",
  };
  let insertErro: { code?: string; message: string } | null = null;
  let selectResposta: unknown = null;

  function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
    const registro: Op = { tabela, op, payload, filtros: [] };
    ops.push(registro);
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "maybeSingle" || prop === "single") {
            if (op === "select") return async () => ({ data: selectResposta, error: null });
            return async () =>
              insertErro ? { data: null, error: insertErro } : { data: { id: "msg-1" }, error: null };
          }
          if (prop === "then") {
            return (ok: (v: unknown) => unknown) =>
              ok({ data: op === "select" && selectResposta ? [selectResposta] : [], error: null });
          }
          return (...args: unknown[]) => {
            if (["eq", "neq", "is", "in"].includes(String(prop))) {
              registro.filtros.push([String(args[0]), args[1]]);
            }
            return proxy;
          };
        },
      },
    ) as Record<string, unknown>;
    return proxy;
  }

  const admin = {
    rpc: vi.fn(async (nome: string, args: unknown) => {
      ops.push({ tabela: "rpc", op: nome, payload: args, filtros: [] });
      const v = respostas[nome];
      return v === null ? { data: null, error: { message: "falhou" } } : { data: v ?? null, error: null };
    }),
    from: (tabela: string) => ({
      select: () => chain(tabela, "select"),
      insert: (payload: unknown) => chain(tabela, "insert", payload),
      update: (payload: unknown) => chain(tabela, "update", payload),
    }),
  };

  return {
    admin: admin as never,
    ops,
    respostas,
    setInsertErro(e: typeof insertErro) {
      insertErro = e;
    },
    setSelect(v: unknown) {
      selectResposta = v;
    },
  };
}
