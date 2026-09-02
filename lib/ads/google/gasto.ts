/**
 * Gasto por campanha e por dia — o insumo de `ad_spend` (Tarefa 5).
 *
 * Por dia, e não agregado, porque a Sobra por Real marca dia sem gasto como
 * incompleto: o cron precisa saber QUAIS dias vieram, não só o total.
 */
import {
  customerIdValido,
  falha,
  inteiro,
  type OpcoesDoCliente,
  pesquisar,
  type ResultadoDoGoogleAds,
} from "./cliente";

export interface LinhaDeGasto {
  campaignId: string;
  campaignName: string;
  campaignStatus: string;
  /** `yyyy-mm-dd`, no fuso da conta do Google Ads. */
  date: string;
  costMicros: number;
  clicks: number;
  impressions: number;
  conversions: number;
  conversionsValue: number;
}

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `de` e `ate` entram na GAQL entre aspas: só `yyyy-mm-dd` passa. É a única
 * porta por onde texto de fora chegaria à consulta.
 */
export async function lerGastoPorCampanhaEDia(
  customerId: string,
  de: string,
  ate: string,
  opcoes?: OpcoesDoCliente,
): Promise<ResultadoDoGoogleAds<LinhaDeGasto[]>> {
  const cid = customerIdValido(customerId);
  if (!cid) return falha("entrada_invalida", `customer id inválido: ${JSON.stringify(customerId)}`);
  if (!DATA_ISO.test(de) || !DATA_ISO.test(ate)) {
    return falha("entrada_invalida", `período inválido (esperado yyyy-mm-dd): ${de} a ${ate}`);
  }

  const gaql =
    "SELECT campaign.id, campaign.name, campaign.status, segments.date, " +
    "metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, " +
    "metrics.conversions_value " +
    "FROM campaign " +
    `WHERE segments.date BETWEEN '${de}' AND '${ate}' AND campaign.status != 'REMOVED' ` +
    "ORDER BY segments.date";

  const r = await pesquisar(cid, gaql, opcoes);
  if (!r.ok) return r;

  const linhas: LinhaDeGasto[] = r.valor.map((linha) => {
    const campaign = linha.campaign ?? {};
    const metrics = linha.metrics ?? {};
    const segments = linha.segments ?? {};
    return {
      campaignId: String(campaign.id ?? ""),
      campaignName: String(campaign.name ?? ""),
      campaignStatus: String(campaign.status ?? ""),
      date: String(segments.date ?? ""),
      costMicros: inteiro(metrics.costMicros),
      clicks: inteiro(metrics.clicks),
      impressions: inteiro(metrics.impressions),
      conversions: inteiro(metrics.conversions),
      conversionsValue: inteiro(metrics.conversionsValue),
    };
  });
  return { ok: true, valor: linhas };
}
