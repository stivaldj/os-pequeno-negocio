/**
 * PROVA DE REALIDADE da Fase 6 (issue #24, HITL): contra a pilha local, importa
 * um extrato OFX, importa **o mesmo arquivo de novo** e mostra que nada muda,
 * calcula o caixa pelo saldo declarado pelo banco e manda ao Dono — uma vez só —
 * o aviso do que vence hoje.
 *
 *   pnpm tsx scripts/prova-financeiro.ts                  # roda e limpa a Conta de prova
 *   PROVA_MANTER=1 pnpm tsx scripts/prova-financeiro.ts   # deixa a Conta no banco para inspeção
 */
import { spawnSync } from "node:child_process";

const r = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "--config", "vitest.prova.config.ts", "tests/prova/financeiro.prova.ts"],
  { stdio: "inherit", env: process.env },
);
process.exit(r.status ?? 1);
