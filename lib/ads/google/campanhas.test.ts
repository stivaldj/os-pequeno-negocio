import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG, stubFetch, TOKEN_OK } from "./_duble.test-util";
import { lerCampanhas, mutarOrcamento, mutarStatusDaCampanha } from "./campanhas";
import { limparCacheDeToken } from "./token";

beforeEach(() => limparCacheDeToken());
afterEach(() => vi.unstubAllGlobals());

const ORCAMENTO = "customers/9876543210/campaignBudgets/555";
const CAMPANHA = "customers/9876543210/campaigns/111";

const RESPOSTA = [
  {
    results: [
      {
        campaign: {
          resourceName: CAMPANHA,
          id: "111",
          name: "Implante",
          status: "ENABLED",
          biddingStrategyType: "MAXIMIZE_CONVERSIONS",
        },
        campaignBudget: { resourceName: ORCAMENTO, amountMicros: "50000000" },
        metrics: {
          costMicros: "875000000",
          clicks: "420",
          impressions: "13000",
          conversions: 30.0,
          conversionsValue: 9000.0,
          averageCpc: "2083333",
          ctr: 0.0323,
          costPerConversion: "29166666",
        },
      },
    ],
  },
];

describe("lerCampanhas", () => {
  it("agrega DURING LAST_30_DAYS com orçamento e estratégia de lance", async () => {
    const { chamadas } = stubFetch([TOKEN_OK, { corpo: RESPOSTA }]);
    const r = await lerCampanhas("9876543210", 30, { config: CONFIG });
    const query = (chamadas[1]!.corpo as { query: string }).query.replace(/\s+/g, " ");
    // Agregado: `segments.date` só no WHERE (o DURING exige), nunca no SELECT —
    // no SELECT ele segmentaria por dia e viraria a consulta de `gasto.ts`.
    const selecionados = query.slice(0, query.indexOf(" FROM "));
    expect(selecionados).not.toContain("segments.date");
    expect(query).toContain("campaign_budget.amount_micros");
    expect(query).toContain("campaign_budget.resource_name");
    expect(query).toContain("campaign.bidding_strategy_type");
    expect(query).toContain("metrics.average_cpc");
    expect(query).toContain("metrics.ctr");
    expect(query).toContain("metrics.cost_per_conversion");
    expect(query).toContain("DURING LAST_30_DAYS");
    expect(query).toContain("campaign.status != 'REMOVED'");

    expect(r).toEqual({
      ok: true,
      valor: [
        {
          campaignId: "111",
          campaignName: "Implante",
          campaignResourceName: CAMPANHA,
          campaignStatus: "ENABLED",
          biddingStrategyType: "MAXIMIZE_CONVERSIONS",
          budgetResourceName: ORCAMENTO,
          budgetAmountMicros: 50_000_000,
          costMicros: 875_000_000,
          clicks: 420,
          impressions: 13000,
          conversions: 30,
          conversionsValue: 9000,
          averageCpcMicros: 2_083_333,
          ctr: 0.0323,
          costPerConversionMicros: 29_166_666,
        },
      ],
    });
  });

  it("7 dias usa LAST_7_DAYS", async () => {
    const { chamadas } = stubFetch([TOKEN_OK, { corpo: [] }]);
    await lerCampanhas("9876543210", 7, { config: CONFIG });
    expect((chamadas[1]!.corpo as { query: string }).query).toContain("DURING LAST_7_DAYS");
  });

  it("métricas ausentes viram zero/null, não NaN", async () => {
    stubFetch([
      TOKEN_OK,
      {
        corpo: [
          {
            results: [
              {
                campaign: {
                  id: "9",
                  name: "Nova",
                  status: "ENABLED",
                  resourceName: "customers/9876543210/campaigns/9",
                },
              },
            ],
          },
        ],
      },
    ]);
    const r = await lerCampanhas("9876543210", 7, { config: CONFIG });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.valor[0]).toMatchObject({
      costMicros: 0,
      clicks: 0,
      conversions: 0,
      budgetAmountMicros: null,
      budgetResourceName: null,
      biddingStrategyType: null,
      averageCpcMicros: null,
      costPerConversionMicros: null,
    });
  });
});

describe("mutações (só a chamada REST; a Fase 8 decide quando usar)", () => {
  it("mutarOrcamento faz campaignBudgets:mutate com updateMask amount_micros", async () => {
    const { chamadas } = stubFetch([
      TOKEN_OK,
      { corpo: { results: [{ resourceName: ORCAMENTO }] } },
    ]);
    const r = await mutarOrcamento("9876543210", ORCAMENTO, 60_000_000, { config: CONFIG });
    expect(r).toEqual({ ok: true, valor: { resourceName: ORCAMENTO } });
    const api = chamadas[1]!;
    expect(api.url).toBe(
      "https://googleads.googleapis.com/v25/customers/9876543210/campaignBudgets:mutate",
    );
    expect(api.corpo).toEqual({
      operations: [
        {
          update: { resourceName: ORCAMENTO, amountMicros: "60000000" },
          updateMask: "amount_micros",
        },
      ],
    });
  });

  it("mutarStatusDaCampanha faz campaigns:mutate com updateMask status", async () => {
    const { chamadas } = stubFetch([
      TOKEN_OK,
      { corpo: { results: [{ resourceName: CAMPANHA }] } },
    ]);
    const r = await mutarStatusDaCampanha("9876543210", CAMPANHA, "PAUSED", { config: CONFIG });
    expect(r).toEqual({ ok: true, valor: { resourceName: CAMPANHA } });
    expect(chamadas[1]!.url).toBe(
      "https://googleads.googleapis.com/v25/customers/9876543210/campaigns:mutate",
    );
    expect(chamadas[1]!.corpo).toEqual({
      operations: [{ update: { resourceName: CAMPANHA, status: "PAUSED" }, updateMask: "status" }],
    });
  });

  it("orçamento não inteiro ou não positivo é recusado antes da rede", async () => {
    const { spy } = stubFetch([]);
    expect(await mutarOrcamento("9876543210", ORCAMENTO, 0, { config: CONFIG })).toMatchObject({
      ok: false,
      code: "entrada_invalida",
    });
    expect(await mutarOrcamento("9876543210", ORCAMENTO, 1.5, { config: CONFIG })).toMatchObject({
      ok: false,
      code: "entrada_invalida",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("resource name de outra conta é recusado antes da rede", async () => {
    const { spy } = stubFetch([]);
    const r = await mutarStatusDaCampanha(
      "9876543210",
      "customers/1111111111/campaigns/1",
      "PAUSED",
      {
        config: CONFIG,
      },
    );
    expect(r).toMatchObject({ ok: false, code: "entrada_invalida" });
    expect(spy).not.toHaveBeenCalled();
  });
});
