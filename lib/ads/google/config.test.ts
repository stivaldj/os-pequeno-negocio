import { describe, expect, it } from "vitest";

import { configDoGoogleAds, googleAdsDisponivel, semHifen } from "./config";

const COMPLETO = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
  GOOGLE_ADS_OAUTH_CLIENT_ID: "cid",
  GOOGLE_ADS_OAUTH_CLIENT_SECRET: "sec",
  GOOGLE_ADS_REFRESH_TOKEN: "rt",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "123-456-7890",
  GOOGLE_ADS_API_VERSION: "v25",
};

describe("googleAdsDisponivel", () => {
  it("só está disponível com as cinco variáveis preenchidas", () => {
    expect(googleAdsDisponivel(COMPLETO)).toBe(true);
    for (const chave of Object.keys(COMPLETO).filter((k) => k !== "GOOGLE_ADS_API_VERSION")) {
      expect(googleAdsDisponivel({ ...COMPLETO, [chave]: "" }), chave).toBe(false);
      expect(googleAdsDisponivel({ ...COMPLETO, [chave]: "   " }), chave).toBe(false);
    }
  });

  it("a versão da API tem default e não é condição de disponibilidade", () => {
    expect(googleAdsDisponivel({ ...COMPLETO, GOOGLE_ADS_API_VERSION: "" })).toBe(true);
    expect(configDoGoogleAds({ ...COMPLETO, GOOGLE_ADS_API_VERSION: "" })?.apiVersion).toBe("v25");
  });
});

describe("configDoGoogleAds", () => {
  it("devolve null quando falta algo, e a config normalizada quando não falta", () => {
    expect(configDoGoogleAds({ ...COMPLETO, GOOGLE_ADS_REFRESH_TOKEN: "" })).toBeNull();
    const cfg = configDoGoogleAds(COMPLETO);
    expect(cfg).toMatchObject({
      developerToken: "dev",
      clientId: "cid",
      clientSecret: "sec",
      refreshToken: "rt",
      // O cabeçalho `login-customer-id` é 10 dígitos SEM hífen; o operador
      // copia da tela do Google, que mostra com hífen.
      loginCustomerId: "1234567890",
      apiVersion: "v25",
    });
  });
});

describe("semHifen", () => {
  it("tira hífens e espaços do customer id", () => {
    expect(semHifen("123-456-7890")).toBe("1234567890");
    expect(semHifen(" 1234567890 ")).toBe("1234567890");
  });
});
