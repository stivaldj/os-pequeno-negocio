/**
 * Coexistência (ADR-0014/0015): depois do eco do app, o comando da conversa
 * NÃO é do Agente até o fim do silêncio — provado pela regra do banco
 * (`fn_comando_da_conversa`, com `p_agora` fixo), não por leitura de coluna.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — run this suite via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

describe("eco do app silencia o Agente pela regra do banco", () => {
  it("bot_silenced_until no futuro tira o comando do Agente; no passado, devolve", () => {
    const durante = sql(`
      select public.fn_comando_da_conversa('open', null, '2026-09-02T10:10:05Z'::timestamptz, false, false, '2026-09-02T10:05:00Z'::timestamptz);
    `);
    const depois = sql(`
      select public.fn_comando_da_conversa('open', null, '2026-09-02T10:10:05Z'::timestamptz, false, false, '2026-09-02T10:11:00Z'::timestamptz);
    `);
    expect(durante).toBe("aguardando");
    expect(depois).toBe("automatico");
  });

  it("a coluna meta_coexistence existe e nasce falsa", () => {
    const out = sql(`
      select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'channel_sessions' and column_name = 'meta_coexistence';
    `);
    expect(out).toBe("false");
  });
});
