/**
 * Instala o aviso de IA (CFM 2.454/2026) numa Conta de saúde: publica
 * `TEXTO_DO_AVISO_CFM` como versão nova do template de disclosure e move o
 * ponteiro da org para ela. A partir daí o `disclosureGate` abre a primeira
 * mensagem de saída de toda conversa com o aviso — sem restart.
 *
 * Parte do Embarque (Fase 4). Reexecutar publica uma versão a mais e move o
 * ponteiro de novo; a versão anterior fica no histórico (imutável).
 *
 * Uso:
 *   pnpm exec tsx --env-file=.env --env-file=.env.local scripts/clinica/instalar-aviso-de-ia.ts <org_id>
 *
 * Lê `SUPABASE_DB_URL` do ambiente do processo (a mesma role do agent-engine).
 */
import { createPool } from "@/lib/agent-engine/db/pool";
import { TEXTO_DO_AVISO_CFM, instalarAvisoDeIa } from "@/lib/clinica/aviso-de-ia";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const orgId = process.argv[2];
  if (!orgId || !UUID.test(orgId)) {
    console.error("uso: tsx scripts/clinica/instalar-aviso-de-ia.ts <org_id (uuid)>");
    process.exit(2);
  }
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error("SUPABASE_DB_URL ausente no ambiente (use --env-file=.env --env-file=.env.local)");
    process.exit(2);
  }

  const pool = createPool(dbUrl);
  try {
    const { versionId } = await instalarAvisoDeIa(pool, orgId);
    console.info(`aviso de IA instalado na org ${orgId}: versão ${versionId}`);
    console.info(`texto: "${TEXTO_DO_AVISO_CFM}"`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
