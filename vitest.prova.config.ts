import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Config das PROVAS DE REALIDADE (`tests/prova/**`), rodadas por
 * `scripts/prova-*.ts` contra uma pilha local (Supabase de desenvolvimento).
 *
 * Por que vitest e não `tsx` direto: os handlers do produto arrastam módulos
 * que o loader CJS do Node 22 não resolve (`@react-pdf/hyphenate` sem export
 * `./en-us`); o Vite resolve. A prova continua sendo um comando só.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/prova/**/*.prova.ts"],
    globals: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ["verbose"],
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
