/**
 * A configuração do Google Ads — por INSTALAÇÃO, não por Conta.
 *
 * A LAVRA opera um MCC só (ADR-0009, done-for-you): developer token, app OAuth
 * e refresh token são da instalação, e cada Conta guarda apenas o `customer_id`
 * da clínica em `ad_accounts`. É a mesma forma do app da Meta.
 *
 * Não há flag "enabled" — estar configurado É ter as cinco variáveis (mesma
 * decisão de `GOOGLE_CALENDAR_CLIENT_ID` em `lib/env.ts`). A versão da API é a
 * sexta e tem default; ela nunca decide disponibilidade.
 */

/** As chaves que este módulo lê do objeto `env` de `lib/env.ts`. */
export interface EnvDoGoogleAds {
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_OAUTH_CLIENT_ID?: string;
  GOOGLE_ADS_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  GOOGLE_ADS_API_VERSION?: string;
}

export interface ConfigDoGoogleAds {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** O MCC: 10 dígitos, SEM hífen — é assim que o cabeçalho `login-customer-id` exige. */
  loginCustomerId: string;
  /** `v25` por default; muda só quando o Google aposenta a versão. */
  apiVersion: string;
}

export const VERSAO_PADRAO_DA_API = "v25";

/**
 * O Google mostra o customer id como `123-456-7890` em toda tela; a API só
 * aceita os 10 dígitos. Quem copia da tela não deve ter de saber disso.
 */
export function semHifen(customerId: string): string {
  return customerId.replace(/[\s-]/g, "");
}

function limpo(valor: string | undefined): string {
  return (valor ?? "").trim();
}

/** A config normalizada, ou `null` quando falta qualquer uma das cinco. */
export function configDoGoogleAds(env: EnvDoGoogleAds): ConfigDoGoogleAds | null {
  const developerToken = limpo(env.GOOGLE_ADS_DEVELOPER_TOKEN);
  const clientId = limpo(env.GOOGLE_ADS_OAUTH_CLIENT_ID);
  const clientSecret = limpo(env.GOOGLE_ADS_OAUTH_CLIENT_SECRET);
  const refreshToken = limpo(env.GOOGLE_ADS_REFRESH_TOKEN);
  const loginCustomerId = semHifen(limpo(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID));
  if (!developerToken || !clientId || !clientSecret || !refreshToken || !loginCustomerId) {
    return null;
  }
  return {
    developerToken,
    clientId,
    clientSecret,
    refreshToken,
    loginCustomerId,
    apiVersion: limpo(env.GOOGLE_ADS_API_VERSION) || VERSAO_PADRAO_DA_API,
  };
}

/** Lê de `env` (o objeto de `lib/env.ts`), nunca de `process.env`. */
export function googleAdsDisponivel(env: EnvDoGoogleAds): boolean {
  return configDoGoogleAds(env) !== null;
}
