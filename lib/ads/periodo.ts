/**
 * "Os últimos N dias", inclusivo e em UTC — o mesmo calendário que `ad_spend.date`
 * usa. Sete dias terminando hoje começam há seis: `de` é `ate - (dias - 1)`.
 */
import type { Periodo } from "./relatorio";

export function periodoDosUltimosDias(dias: number, hoje: Date = new Date()): Periodo {
  const ate = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()));
  const de = new Date(ate);
  de.setUTCDate(de.getUTCDate() - (dias - 1));
  return { de: de.toISOString().slice(0, 10), ate: ate.toISOString().slice(0, 10) };
}
