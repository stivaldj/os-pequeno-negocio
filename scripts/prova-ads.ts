/**
 * PROVA DE REALIDADE da Fase 5 (issue #23, HITL): com as credenciais do Google
 * na instalação e uma Conta configurada, roda o sync de gasto de verdade e
 * mostra o que entrou em `ad_spend` — a campanha real atribuída ponta a ponta.
 *
 *   pnpm tsx scripts/prova-ads.ts            # sync + tabela do que entrou
 *   AD_CUSTOMER_ID=1234567890 pnpm tsx scripts/prova-ads.ts --so-ler   # só lê a API, sem gravar
 */
import { spawnSync } from "node:child_process";

const soLer = process.argv.includes("--so-ler");
const r = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "--config", "vitest.prova.config.ts", "tests/prova/ads.prova.ts"],
  { stdio: "inherit", env: { ...process.env, ...(soLer ? { PROVA_ADS_SO_LER: "1" } : {}) } },
);
process.exit(r.status ?? 1);
