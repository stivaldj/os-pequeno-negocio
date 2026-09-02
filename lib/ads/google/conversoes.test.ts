import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG, stubFetch, TOKEN_OK } from "./_duble.test-util";
import { formatarDataHoraDeConversao, subirConversoes } from "./conversoes";
import { limparCacheDeToken } from "./token";

beforeEach(() => limparCacheDeToken());
afterEach(() => vi.unstubAllGlobals());

const ACAO = "customers/9876543210/conversionActions/777";
const QUANDO = "2026-08-30 14:35:00-03:00";

function linha(extra: Record<string, unknown>, orderId: string, conversionValue = 1) {
  return { conversionAction: ACAO, conversionDateTime: QUANDO, conversionValue, orderId, ...extra };
}

describe("formatarDataHoraDeConversao", () => {
  it("escreve yyyy-mm-dd hh:mm:ss±hh:mm no fuso pedido (default -03:00)", () => {
    expect(formatarDataHoraDeConversao(new Date("2026-08-30T17:35:00Z"))).toBe(QUANDO);
    expect(formatarDataHoraDeConversao(new Date("2026-08-30T17:35:00Z"), -240)).toBe(
      "2026-08-30 13:35:00-04:00",
    );
    expect(formatarDataHoraDeConversao(new Date("2026-08-31T01:05:09Z"), 0)).toBe(
      "2026-08-31 01:05:09+00:00",
    );
    expect(formatarDataHoraDeConversao(new Date("2026-08-30T23:30:00Z"), 330)).toBe(
      "2026-08-31 05:00:00+05:30",
    );
  });
});

describe("subirConversoes", () => {
  it("faz uploadClickConversions com partialFailure e BRL, orderId = id do agendamento", async () => {
    const { chamadas } = stubFetch([
      TOKEN_OK,
      { corpo: { results: [{ gclid: "abc", conversionAction: ACAO }] } },
    ]);
    const r = await subirConversoes("987-654-3210", [linha({ gclid: "abc" }, "apt-1", 350)], {
      config: CONFIG,
    });
    expect(r).toEqual({ ok: true, valor: [{ ok: true }] });

    const api = chamadas[1]!;
    expect(api.url).toBe(
      "https://googleads.googleapis.com/v25/customers/9876543210:uploadClickConversions",
    );
    expect(api.cabecalhos["login-customer-id"]).toBe("1234567890");
    expect(api.cabecalhos["developer-token"]).toBe("dev-token-teste");
    expect(api.corpo).toEqual({
      conversions: [
        {
          gclid: "abc",
          conversionAction: ACAO,
          conversionDateTime: QUANDO,
          conversionValue: 350,
          currencyCode: "BRL",
          orderId: "apt-1",
        },
      ],
      partialFailure: true,
    });
  });

  it("devolve o resultado por índice a partir de partialFailureError", async () => {
    stubFetch([
      TOKEN_OK,
      {
        corpo: {
          results: [{}, { gclid: "ok" }, {}],
          partialFailureError: {
            code: 3,
            message: "…",
            details: [
              {
                errors: [
                  {
                    errorCode: { conversionUploadError: "EVENT_NOT_FOUND" },
                    message: "The click associated with the given identifiers could not be found.",
                    location: { fieldPathElements: [{ fieldName: "conversions", index: 0 }] },
                  },
                  {
                    errorCode: { conversionUploadError: "ORDER_ID_ALREADY_IN_USE" },
                    message: "The order ID is already in use.",
                    location: {
                      fieldPathElements: [
                        { fieldName: "conversions", index: 2 },
                        { fieldName: "order_id" },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    ]);
    const r = await subirConversoes(
      "9876543210",
      [linha({ gclid: "a" }, "1"), linha({ gclid: "ok" }, "2"), linha({ wbraid: "w" }, "3")],
      { config: CONFIG },
    );
    expect(r).toEqual({
      ok: true,
      valor: [
        { ok: false, erro: "EVENT_NOT_FOUND" },
        { ok: true },
        { ok: false, erro: "ORDER_ID_ALREADY_IN_USE" },
      ],
    });
  });

  it("gbraid e wbraid juntos, ou nenhum identificador, falham localmente e o resto sobe", async () => {
    const { chamadas } = stubFetch([TOKEN_OK, { corpo: { results: [{}] } }]);
    const r = await subirConversoes(
      "9876543210",
      [linha({ gbraid: "g", wbraid: "w" }, "1"), linha({ gclid: "ok" }, "2"), linha({}, "3")],
      { config: CONFIG },
    );
    expect(r).toEqual({
      ok: true,
      valor: [
        { ok: false, erro: "GBRAID_E_WBRAID_JUNTOS" },
        { ok: true },
        { ok: false, erro: "SEM_IDENTIFICADOR_DE_CLIQUE" },
      ],
    });
    const corpo = chamadas[1]!.corpo as { conversions: { orderId: string }[] };
    expect(corpo.conversions.map((c) => c.orderId)).toEqual(["2"]);
  });

  it("erro parcial em linha que subiu depois de uma pulada volta para o índice ORIGINAL", async () => {
    stubFetch([
      TOKEN_OK,
      {
        corpo: {
          results: [{}, {}],
          partialFailureError: {
            details: [
              {
                errors: [
                  {
                    errorCode: { conversionUploadError: "TOO_RECENT_EVENT" },
                    location: { fieldPathElements: [{ fieldName: "conversions", index: 1 }] },
                  },
                ],
              },
            ],
          },
        },
      },
    ]);
    const r = await subirConversoes(
      "9876543210",
      [linha({}, "1"), linha({ gclid: "a" }, "2"), linha({ gclid: "b" }, "3")],
      { config: CONFIG },
    );
    expect(r).toEqual({
      ok: true,
      valor: [
        { ok: false, erro: "SEM_IDENTIFICADOR_DE_CLIQUE" },
        { ok: true },
        { ok: false, erro: "TOO_RECENT_EVENT" },
      ],
    });
  });

  it("nenhuma linha válida não chama a rede", async () => {
    const { spy } = stubFetch([]);
    expect(await subirConversoes("9876543210", [], { config: CONFIG })).toEqual({
      ok: true,
      valor: [],
    });
    expect(await subirConversoes("9876543210", [linha({}, "1")], { config: CONFIG })).toEqual({
      ok: true,
      valor: [{ ok: false, erro: "SEM_IDENTIFICADOR_DE_CLIQUE" }],
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("erro da requisição inteira (não parcial) devolve { ok: false }", async () => {
    stubFetch([
      TOKEN_OK,
      {
        status: 403,
        corpo: {
          error: {
            code: 403,
            message: "x",
            details: [
              { errors: [{ errorCode: { authorizationError: "USER_PERMISSION_DENIED" } }] },
            ],
          },
        },
      },
    ]);
    const r = await subirConversoes("9876543210", [linha({ gclid: "a" }, "1")], { config: CONFIG });
    expect(r).toMatchObject({ ok: false, code: "USER_PERMISSION_DENIED" });
  });
});
