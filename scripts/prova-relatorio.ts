/**
 * PROVA DE REALIDADE da Fase 7 (issue #25, HITL): quatro módulos — agenda,
 * ads, financeiro e atendimentos — viram um texto só, entregue ao Dono, com
 * uma seção marcada incompleta de propósito.
 *
 *   pnpm tsx scripts/prova-relatorio.ts                  # roda e limpa a Conta de prova
 *   PROVA_MANTER=1 pnpm tsx scripts/prova-relatorio.ts   # deixa a Conta no banco para inspeção
 */
import { spawnSync } from "node:child_process";

const r = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "--config", "vitest.prova.config.ts", "tests/prova/relatorio.prova.ts"],
  { stdio: "inherit", env: process.env },
);
process.exit(r.status ?? 1);
