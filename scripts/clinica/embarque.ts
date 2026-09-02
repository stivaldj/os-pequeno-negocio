/**
 * O Embarque da clínica, pela linha de comando.
 *
 * Uso:
 *   pnpm tsx scripts/clinica/embarque.ts <embarque.json>
 *
 * Fino de propósito: `scripts/**` fica fora do `tsc`, então a lógica (schema,
 * idempotência, relatório) mora em `lib/clinica/embarque.ts`, coberta por teste.
 * Aqui só se lê o arquivo, se resolve o destino e se imprime o relatório.
 *
 * Credenciais por `scripts/lib/env-de-teste.ts`: `process.env` vence,
 * `.env.local` completa, e o destino é anunciado antes de qualquer escrita.
 * Comece por `scripts/clinica/embarque.exemplo.json`.
 */
import fs from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { anunciarDestino, carregarEnvLocal, credenciaisSupabaseDeTeste } from "../lib/env-de-teste";

const USO =
  "uso: pnpm tsx scripts/clinica/embarque.ts <embarque.json>  (exemplo em scripts/clinica/embarque.exemplo.json)";

async function main(): Promise<void> {
  const arquivo = process.argv[2];
  if (!arquivo) {
    console.error(USO);
    process.exit(2);
  }
  const caminho = path.resolve(process.cwd(), arquivo);
  if (!fs.existsSync(caminho)) {
    console.error(`arquivo não encontrado: ${caminho}\n${USO}`);
    process.exit(2);
  }

  carregarEnvLocal();
  let credenciais;
  try {
    credenciais = credenciaisSupabaseDeTeste();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USO);
    process.exit(2);
  }
  if (credenciais.dbUrl === "") {
    console.error(
      "SUPABASE_DB_URL ausente: o Embarque publica playbook e aviso de IA por conexão direta ao Postgres.",
    );
    process.exit(2);
  }
  anunciarDestino("clinica/embarque", credenciais);

  // Importados DEPOIS de carregar o env: `lib/env.ts` valida na importação, e
  // `lib/clinica/embarque.ts` chega até ele pelo catálogo de ferramentas.
  const { embarqueSchema, executarEmbarque } = await import("@/lib/clinica/embarque");
  const { createPool } = await import("@/lib/agent-engine/db/pool");

  const parsed = embarqueSchema.safeParse(JSON.parse(fs.readFileSync(caminho, "utf8")));
  if (!parsed.success) {
    console.error("arquivo de Embarque inválido:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(raiz)"}: ${issue.message}`);
    }
    process.exit(2);
  }

  const admin = createClient(credenciais.url, credenciais.serviceRole, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const pool = createPool(credenciais.dbUrl);
  try {
    const relatorio = await executarEmbarque(admin, pool, parsed.data);
    console.info(`\nEmbarque da organização ${parsed.data.organization_id}`);
    console.info(`feito (${relatorio.feito.length}):`);
    for (const item of relatorio.feito) console.info(`  ✓ ${item}`);
    console.info(`pulado (${relatorio.pulado.length}):`);
    for (const { item, motivo } of relatorio.pulado) console.info(`  – ${item}: ${motivo}`);
    if (relatorio.pulado.length > 0) {
      console.info(
        "\nO que foi pulado precisa do Dono (convidar o usuário, publicar o agente) e volta a rodar com o mesmo arquivo.",
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
