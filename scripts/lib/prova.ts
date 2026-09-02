/**
 * Helpers dos scripts de prova (`scripts/prova-*.ts`): um passo nomeado que
 * imprime o que provou, e um `afirmar` que derruba o script com a mensagem
 * real em vez de seguir fingindo.
 */
export function afirmar(condicao: unknown, mensagem: string): asserts condicao {
  if (!condicao) {
    console.error(`  ✗ ${mensagem}`);
    process.exit(1);
  }
}

export async function passo<T>(nome: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`→ ${nome} … `);
  try {
    const r = await fn();
    console.log("ok");
    return r;
  } catch (err) {
    console.log("FALHOU");
    console.error(`  ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  }
}

export function pular(nome: string, motivo: string): void {
  console.log(`○ ${nome} — ${motivo}`);
}
