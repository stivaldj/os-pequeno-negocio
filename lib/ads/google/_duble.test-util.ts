/**
 * Dublê de `fetch` para os testes do cliente do Google Ads.
 *
 * Cada chamada consome a PRÓXIMA resposta da fila; o teste lê `chamadas` para
 * afirmar URL, cabeçalhos e corpo. Mesma forma do stub em
 * `tests/unit/channel-adapter-meta.test.ts` (só `ok`, `status`, `json()`), para
 * que o cliente não dependa de nada além disso na resposta.
 */
import { vi } from "vitest";

import type { ConfigDoGoogleAds } from "./config";

export interface ChamadaRegistrada {
  url: string;
  metodo: string;
  cabecalhos: Record<string, string>;
  corpo: unknown;
}

export interface RespostaFalsa {
  status?: number;
  corpo: unknown;
}

export function stubFetch(respostas: RespostaFalsa[]) {
  const chamadas: ChamadaRegistrada[] = [];
  const fila = [...respostas];
  const spy = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const cabecalhos: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      cabecalhos[k.toLowerCase()] = v;
    }
    chamadas.push({
      url: String(url),
      metodo: init?.method ?? "GET",
      cabecalhos,
      corpo: typeof init?.body === "string" ? tentarJson(init.body) : init?.body,
    });
    const proxima = fila.shift();
    if (!proxima) throw new Error("dublê de fetch sem resposta na fila");
    const status = proxima.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => proxima.corpo };
  });
  vi.stubGlobal("fetch", spy);
  return { spy, chamadas };
}

function tentarJson(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

export const CONFIG: ConfigDoGoogleAds = {
  developerToken: "dev-token-teste",
  clientId: "client-id-teste",
  clientSecret: "client-secret-teste",
  refreshToken: "refresh-token-teste",
  loginCustomerId: "1234567890",
  apiVersion: "v25",
};

/** Resposta padrão da troca de refresh token. */
export const TOKEN_OK: RespostaFalsa = {
  corpo: { access_token: "ya29.teste", expires_in: 3599, token_type: "Bearer" },
};
