import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG, stubFetch, TOKEN_OK } from "./_duble.test-util";
import { lerGastoPorCampanhaEDia } from "./gasto";
import { limparCacheDeToken } from "./token";

beforeEach(() => limparCacheDeToken());
afterEach(() => vi.unstubAllGlobals());

const CAMP_111 = {
  resourceName: "customers/9876543210/campaigns/111",
  id: "111",
  name: "Implante",
  status: "ENABLED",
};

const RESPOSTA = [
  {
    results: [
      {
        campaign: CAMP_111,
        metrics: {
          costMicros: "87500000",
          clicks: "42",
          impressions: "1300",
          conversions: 3.0,
          conversionsValue: 900.0,
        },
        segments: { date: "2026-08-01" },
      },
      {
        campaign: CAMP_111,
        metrics: {
          costMicros: "12000000",
          clicks: "5",
          impressions: "200",
          conversions: 0,
          conversionsValue: 0,
        },
        segments: { date: "2026-08-02" },
      },
    ],
    fieldMask: "campaign.id,campaign.name",
    requestId: "req-1",
  },
  {
    results: [
      {
        campaign: {
          resourceName: "customers/9876543210/campaigns/222",
          id: "222",
          name: "Clareamento",
          status: "PAUSED",
        },
        metrics: {
          costMicros: "0",
          clicks: "0",
          impressions: "10",
          conversions: 0,
          conversionsValue: 0,
        },
        segments: { date: "2026-08-01" },
      },
    ],
    requestId: "req-2",
  },
];

const DE = "2026-08-01";
const ATE = "2026-08-02";

function erroDeAutorizacao(codigo: string, mensagem: string) {
  return {
    status: 403,
    corpo: {
      error: {
        code: 403,
        message: "The caller does not have permission",
        details: [{ errors: [{ errorCode: { authorizationError: codigo }, message: mensagem }] }],
      },
    },
  };
}

describe("lerGastoPorCampanhaEDia", () => {
  it("faz searchStream com os três cabeçalhos e a GAQL por dia", async () => {
    const { chamadas } = stubFetch([TOKEN_OK, { corpo: RESPOSTA }]);
    const r = await lerGastoPorCampanhaEDia("987-654-3210", DE, ATE, { config: CONFIG });
    expect(r.ok).toBe(true);

    const api = chamadas[1]!;
    expect(api.url).toBe(
      "https://googleads.googleapis.com/v25/customers/9876543210/googleAds:searchStream",
    );
    expect(api.metodo).toBe("POST");
    expect(api.cabecalhos["authorization"]).toBe("Bearer ya29.teste");
    expect(api.cabecalhos["developer-token"]).toBe("dev-token-teste");
    expect(api.cabecalhos["login-customer-id"]).toBe("1234567890");
    expect(api.cabecalhos["content-type"]).toBe("application/json");

    const query = (api.corpo as { query: string }).query.replace(/\s+/g, " ");
    expect(query).toContain(
      "SELECT campaign.id, campaign.name, campaign.status, segments.date, metrics.cost_micros, " +
        "metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value FROM campaign",
    );
    expect(query).toContain("segments.date BETWEEN '2026-08-01' AND '2026-08-02'");
    expect(query).toContain("campaign.status != 'REMOVED'");
    expect(query).toContain("ORDER BY segments.date");
  });

  it("achata os chunks e converte int64 (string) em número", async () => {
    stubFetch([TOKEN_OK, { corpo: RESPOSTA }]);
    const r = await lerGastoPorCampanhaEDia("9876543210", DE, ATE, { config: CONFIG });
    expect(r).toEqual({
      ok: true,
      valor: [
        {
          campaignId: "111",
          campaignName: "Implante",
          campaignStatus: "ENABLED",
          date: "2026-08-01",
          costMicros: 87_500_000,
          clicks: 42,
          impressions: 1300,
          conversions: 3,
          conversionsValue: 900,
        },
        {
          campaignId: "111",
          campaignName: "Implante",
          campaignStatus: "ENABLED",
          date: "2026-08-02",
          costMicros: 12_000_000,
          clicks: 5,
          impressions: 200,
          conversions: 0,
          conversionsValue: 0,
        },
        {
          campaignId: "222",
          campaignName: "Clareamento",
          campaignStatus: "PAUSED",
          date: "2026-08-01",
          costMicros: 0,
          clicks: 0,
          impressions: 10,
          conversions: 0,
          conversionsValue: 0,
        },
      ],
    });
  });

  it("resposta vazia (nenhuma campanha) devolve lista vazia", async () => {
    stubFetch([TOKEN_OK, { corpo: [] }]);
    const r = await lerGastoPorCampanhaEDia("9876543210", DE, ATE, { config: CONFIG });
    expect(r).toEqual({ ok: true, valor: [] });
  });

  it("data fora de yyyy-mm-dd não vai para a GAQL: devolve erro sem chamar a rede", async () => {
    const { spy } = stubFetch([TOKEN_OK]);
    const r = await lerGastoPorCampanhaEDia("9876543210", "01/08/2026", ATE, { config: CONFIG });
    expect(r).toMatchObject({ ok: false, code: "entrada_invalida" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("customer id que não é 10 dígitos não vai para a URL", async () => {
    const { spy } = stubFetch([TOKEN_OK]);
    const r = await lerGastoPorCampanhaEDia("abc/../x", DE, ATE, { config: CONFIG });
    expect(r).toMatchObject({ ok: false, code: "entrada_invalida" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("DEVELOPER_TOKEN_NOT_APPROVED vira erro traduzido para o operador, sem lançar", async () => {
    stubFetch([
      TOKEN_OK,
      erroDeAutorizacao("DEVELOPER_TOKEN_NOT_APPROVED", "The developer token is not approved."),
    ]);
    const r = await lerGastoPorCampanhaEDia("9876543210", DE, ATE, { config: CONFIG });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("DEVELOPER_TOKEN_NOT_APPROVED");
    expect(r.motivo).toMatch(/developer token/i);
    expect(r.motivo).toMatch(/Centro de API/);
  });

  it("USER_PERMISSION_DENIED aponta para o vínculo com o MCC", async () => {
    stubFetch([
      TOKEN_OK,
      erroDeAutorizacao(
        "USER_PERMISSION_DENIED",
        "User doesn't have permission to access customer.",
      ),
    ]);
    const r = await lerGastoPorCampanhaEDia("9876543210", DE, ATE, { config: CONFIG });
    expect(r).toMatchObject({ ok: false, code: "USER_PERMISSION_DENIED" });
    if (r.ok) return;
    expect(r.motivo).toMatch(/MCC/);
    expect(r.motivo).toMatch(/GOOGLE_ADS_LOGIN_CUSTOMER_ID/);
  });

  it("outro erro HTTP devolve code 'http' com o código do Google no motivo", async () => {
    stubFetch([
      TOKEN_OK,
      {
        status: 400,
        corpo: {
          error: {
            code: 400,
            message: "Request contains an invalid argument.",
            details: [
              {
                errors: [
                  {
                    errorCode: { queryError: "UNRECOGNIZED_FIELD" },
                    message: "Unrecognized field.",
                  },
                ],
              },
            ],
          },
        },
      },
    ]);
    const r = await lerGastoPorCampanhaEDia("9876543210", DE, ATE, { config: CONFIG });
    expect(r).toMatchObject({ ok: false, code: "http" });
    if (r.ok) return;
    expect(r.motivo).toMatch(/UNRECOGNIZED_FIELD/);
    expect(r.motivo).toMatch(/400/);
  });

  it("token que falha propaga o erro do token sem tentar a API", async () => {
    const { spy } = stubFetch([{ status: 400, corpo: { error: "invalid_grant" } }]);
    const r = await lerGastoPorCampanhaEDia("9876543210", DE, ATE, { config: CONFIG });
    expect(r).toMatchObject({ ok: false, code: "token" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("sem configuração devolve nao_configurado sem tocar a rede", async () => {
    const { spy } = stubFetch([]);
    const r = await lerGastoPorCampanhaEDia("9876543210", DE, ATE, { config: null });
    expect(r).toMatchObject({ ok: false, code: "nao_configurado" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("rede fora na API devolve code 'rede' sem lançar", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => TOKEN_OK.corpo })
      .mockRejectedValueOnce(new Error("TimeoutError"));
    vi.stubGlobal("fetch", spy);
    const r = await lerGastoPorCampanhaEDia("9876543210", DE, ATE, { config: CONFIG });
    expect(r).toMatchObject({ ok: false, code: "rede" });
  });

  it("a chamada leva um AbortSignal (timeout de 20s)", async () => {
    const { spy } = stubFetch([TOKEN_OK, { corpo: [] }]);
    await lerGastoPorCampanhaEDia("9876543210", DE, ATE, { config: CONFIG });
    const init = spy.mock.calls[1]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
