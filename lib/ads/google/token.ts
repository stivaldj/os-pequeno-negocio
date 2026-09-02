/**
 * O `access_token` do Google Ads a partir do refresh token da instalação.
 *
 * O refresh token é obtido uma vez (script `scripts/ads/obter-refresh-token.ts`,
 * Tarefa 10) e vive em `GOOGLE_ADS_REFRESH_TOKEN`; cada access token dura cerca
 * de uma hora. O cache aqui é de processo: um cron que lê gasto de N Contas troca
 * o refresh token uma vez, não N.
 *
 * `expires_in` é RELATIVO (mesma armadilha documentada em
 * `lib/agenda/google/oauth.ts`): vira instante absoluto na leitura, e a renovação
 * acontece com um minuto de folga para cobrir latência e relógio.
 */
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

import { type ConfigDoGoogleAds, configDoGoogleAds } from "./config";
import type { ResultadoDoGoogleAds } from "./cliente";

export const ENDERECO_DE_TOKEN = "https://www.googleapis.com/oauth2/v3/token";
export const FOLGA_DE_RENOVACAO_MS = 60_000;
const TEMPO_LIMITE_MS = 20_000;

interface TokenEmCache {
  /** Para qual refresh token o access token foi emitido — config trocada invalida. */
  refreshToken: string;
  token: string;
  expiraEm: number;
}

let cache: TokenEmCache | null = null;

/** Para teste, e para quem trocou o refresh token em tempo de execução. */
export function limparCacheDeToken(): void {
  cache = null;
}

export async function accessToken(
  config: ConfigDoGoogleAds | null = configDoGoogleAds(env),
): Promise<ResultadoDoGoogleAds<string>> {
  if (!config) {
    return {
      ok: false,
      code: "nao_configurado",
      motivo:
        "Google Ads não configurado: faltam GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_OAUTH_CLIENT_ID, " +
        "GOOGLE_ADS_OAUTH_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN e/ou GOOGLE_ADS_LOGIN_CUSTOMER_ID.",
    };
  }

  const agora = Date.now();
  if (cache && cache.refreshToken === config.refreshToken && agora < cache.expiraEm) {
    return { ok: true, valor: cache.token };
  }

  const corpo = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
  });

  let resposta: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    resposta = await fetch(ENDERECO_DE_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: corpo.toString(),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    logger.warn("google-ads token: rede", { erro: mensagem });
    return {
      ok: false,
      code: "rede",
      motivo: `Sem resposta do Google ao renovar o token: ${mensagem}`,
    };
  }

  let json: Record<string, unknown> = {};
  try {
    json = ((await resposta.json()) ?? {}) as Record<string, unknown>;
  } catch {
    json = {};
  }

  if (!resposta.ok || typeof json.access_token !== "string") {
    const codigo = typeof json.error === "string" ? json.error : `http_${resposta.status}`;
    const descricao =
      typeof json.error_description === "string" ? ` — ${json.error_description}` : "";
    logger.warn("google-ads token: recusado", { status: resposta.status, erro: codigo });
    return {
      ok: false,
      code: "token",
      motivo:
        `O Google recusou o refresh token (${codigo}${descricao}). ` +
        "Gere um novo com scripts/ads/obter-refresh-token.ts e grave em GOOGLE_ADS_REFRESH_TOKEN.",
    };
  }

  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  cache = {
    refreshToken: config.refreshToken,
    token: json.access_token,
    expiraEm: agora + expiresIn * 1000 - FOLGA_DE_RENOVACAO_MS,
  };
  return { ok: true, valor: cache.token };
}
