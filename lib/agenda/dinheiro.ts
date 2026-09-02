/**
 * ADR-0017: o que a TELA digita em reais e em %, e o que o BANCO guarda em
 * centavos e em pontos-base. As duas conversões moram aqui, e só aqui — o
 * formulário de tipo e o diálogo do "Realizado" importam as mesmas funções,
 * porque a segunda cópia é a que erra calada (`Number("200")` sem `* 100`
 * gravaria R$ 2,00 e o relatório das 8h diria que a clínica faturou um
 * centésimo do dia).
 *
 * Em branco é `undefined`, nunca 0: ausência é dado faltante, e zero seria
 * "atendeu de graça". Quem chama decide se omite o campo ou manda `null`.
 */

function numeroDe(texto: string): number | undefined {
  const limpo = texto.trim().replace(",", ".");
  if (limpo === "") return undefined;
  const n = Number(limpo);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** "150,50" ou "150.50" → 15050. Vazio ou inválido → `undefined`. */
export function centavosDe(reais: string): number | undefined {
  const n = numeroDe(reais);
  return n === undefined ? undefined : Math.round(n * 100);
}

/** 15050 → "150.50", o que um `<input type="number">` aceita. Nulo → campo vazio. */
export function reaisDe(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? "" : (cents / 100).toFixed(2);
}

/** "60" → 6000 pontos-base. Vazio ou inválido → `undefined`. */
export function pontosBaseDe(percentual: string): number | undefined {
  const n = numeroDe(percentual);
  return n === undefined ? undefined : Math.round(n * 100);
}

/** 6000 → "60". Nulo → campo vazio. */
export function percentualDe(bps: number | null | undefined): string {
  return bps === null || bps === undefined ? "" : String(bps / 100);
}
