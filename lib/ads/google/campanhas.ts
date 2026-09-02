/**
 * Campanhas agregadas (leitura) e as duas mutações que a Fase 8 vai usar.
 *
 * As mutações existem aqui só como chamada REST com `updateMask`. Quem decide
 * SE pode escrever é `podeEscrever` (nível de autonomia, ADR-0018), em
 * `lib/ads/agente/`; este arquivo não conhece nível nenhum.
 */
import {
  chamarGoogleAds,
  customerIdValido,
  falha,
  inteiro,
  inteiroOuNull,
  type OpcoesDoCliente,
  pesquisar,
  type ResultadoDoGoogleAds,
} from "./cliente";

export interface Campanha {
  campaignId: string;
  campaignName: string;
  campaignResourceName: string;
  campaignStatus: string;
  biddingStrategyType: string | null;
  budgetResourceName: string | null;
  budgetAmountMicros: number | null;
  costMicros: number;
  clicks: number;
  impressions: number;
  conversions: number;
  conversionsValue: number;
  averageCpcMicros: number | null;
  ctr: number | null;
  costPerConversionMicros: number | null;
}

export type JanelaDeDias = 7 | 30;

export async function lerCampanhas(
  customerId: string,
  dias: JanelaDeDias,
  opcoes?: OpcoesDoCliente,
): Promise<ResultadoDoGoogleAds<Campanha[]>> {
  const cid = customerIdValido(customerId);
  if (!cid) return falha("entrada_invalida", `customer id inválido: ${JSON.stringify(customerId)}`);
  const janela = dias === 7 ? "LAST_7_DAYS" : "LAST_30_DAYS";

  const gaql =
    "SELECT campaign.id, campaign.name, campaign.resource_name, campaign.status, " +
    "campaign.bidding_strategy_type, campaign_budget.resource_name, campaign_budget.amount_micros, " +
    "metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, " +
    "metrics.conversions_value, metrics.average_cpc, metrics.ctr, metrics.cost_per_conversion " +
    "FROM campaign " +
    `WHERE segments.date DURING ${janela} AND campaign.status != 'REMOVED' ` +
    "ORDER BY metrics.cost_micros DESC";

  const r = await pesquisar(cid, gaql, opcoes);
  if (!r.ok) return r;

  const campanhas: Campanha[] = r.valor.map((linha) => {
    const campaign = linha.campaign ?? {};
    const budget = linha.campaignBudget ?? {};
    const metrics = linha.metrics ?? {};
    return {
      campaignId: String(campaign.id ?? ""),
      campaignName: String(campaign.name ?? ""),
      campaignResourceName: String(campaign.resourceName ?? ""),
      campaignStatus: String(campaign.status ?? ""),
      biddingStrategyType:
        typeof campaign.biddingStrategyType === "string" ? campaign.biddingStrategyType : null,
      budgetResourceName: typeof budget.resourceName === "string" ? budget.resourceName : null,
      budgetAmountMicros: inteiroOuNull(budget.amountMicros),
      costMicros: inteiro(metrics.costMicros),
      clicks: inteiro(metrics.clicks),
      impressions: inteiro(metrics.impressions),
      conversions: inteiro(metrics.conversions),
      conversionsValue: inteiro(metrics.conversionsValue),
      averageCpcMicros: inteiroOuNull(metrics.averageCpc),
      ctr: inteiroOuNull(metrics.ctr),
      costPerConversionMicros: inteiroOuNull(metrics.costPerConversion),
    };
  });
  return { ok: true, valor: campanhas };
}

interface RespostaDeMutacao {
  results?: { resourceName?: string }[];
}

/** O resource name tem de ser DESTA conta: `customers/<cid>/<coleção>/<id>`. */
function resourceNameDaConta(cid: string, colecao: string, resourceName: string): boolean {
  return new RegExp(`^customers/${cid}/${colecao}/\\d+$`).test(resourceName);
}

async function mutar(
  cid: string,
  colecao: "campaignBudgets" | "campaigns",
  update: Record<string, string>,
  updateMask: string,
  opcoes?: OpcoesDoCliente,
): Promise<ResultadoDoGoogleAds<{ resourceName: string }>> {
  const r = await chamarGoogleAds<RespostaDeMutacao>(
    `customers/${cid}/${colecao}:mutate`,
    { operations: [{ update, updateMask }] },
    opcoes,
  );
  if (!r.ok) return r;
  const resourceName = r.valor?.results?.[0]?.resourceName;
  if (typeof resourceName !== "string") {
    return falha("resposta_invalida", `${colecao}:mutate não devolveu o resource name.`);
  }
  return { ok: true, valor: { resourceName } };
}

/** `campaignBudgets:mutate` — só `amount_micros`. Inteiro positivo, em micros. */
export async function mutarOrcamento(
  customerId: string,
  budgetResourceName: string,
  amountMicros: number,
  opcoes?: OpcoesDoCliente,
): Promise<ResultadoDoGoogleAds<{ resourceName: string }>> {
  const cid = customerIdValido(customerId);
  if (!cid) return falha("entrada_invalida", `customer id inválido: ${JSON.stringify(customerId)}`);
  if (!Number.isInteger(amountMicros) || amountMicros <= 0) {
    return falha("entrada_invalida", `orçamento inválido (micros, inteiro > 0): ${amountMicros}`);
  }
  if (!resourceNameDaConta(cid, "campaignBudgets", budgetResourceName)) {
    return falha("entrada_invalida", `orçamento fora da conta ${cid}: ${budgetResourceName}`);
  }
  return mutar(
    cid,
    "campaignBudgets",
    { resourceName: budgetResourceName, amountMicros: String(amountMicros) },
    "amount_micros",
    opcoes,
  );
}

export type StatusDeCampanha = "ENABLED" | "PAUSED";

/** `campaigns:mutate` — só `status`. Nunca `REMOVED`: apagar campanha não é coisa de agente. */
export async function mutarStatusDaCampanha(
  customerId: string,
  campaignResourceName: string,
  status: StatusDeCampanha,
  opcoes?: OpcoesDoCliente,
): Promise<ResultadoDoGoogleAds<{ resourceName: string }>> {
  const cid = customerIdValido(customerId);
  if (!cid) return falha("entrada_invalida", `customer id inválido: ${JSON.stringify(customerId)}`);
  if (status !== "ENABLED" && status !== "PAUSED") {
    return falha("entrada_invalida", `status inválido: ${String(status)}`);
  }
  if (!resourceNameDaConta(cid, "campaigns", campaignResourceName)) {
    return falha("entrada_invalida", `campanha fora da conta ${cid}: ${campaignResourceName}`);
  }
  return mutar(cid, "campaigns", { resourceName: campaignResourceName, status }, "status", opcoes);
}
