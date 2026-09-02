/**
 * PROVA DA FASE 4 (issue #22): `pnpm tsx scripts/prova-agenda.ts`
 *
 * Casca fina: a prova vive em `tests/prova/agenda.prova.ts` e roda pelo vitest
 * (`vitest.prova.config.ts`), porque o loader CJS do Node não resolve tudo que
 * os handlers do produto importam. Flags: `--manter` (não apaga a org de
 * prova), `PROVA_GOOGLE=1` (empurra ao Google Calendar conectado).
 */
import { spawnSync } from "node:child_process";

const manter = process.argv.includes("--manter");
const r = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "--config", "vitest.prova.config.ts", "tests/prova/agenda.prova.ts"],
  { stdio: "inherit", env: { ...process.env, ...(manter ? { PROVA_MANTER: "1" } : {}) } },
);
process.exit(r.status ?? 1);
