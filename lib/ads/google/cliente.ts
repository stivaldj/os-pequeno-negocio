/**
 * A chamada REST ao Google Ads — uma função, três cabeçalhos, erro que não lança.
 *
 * REST v25 com `fetch`, sem SDK: o gRPC client oficial pesa dezenas de MB e
 * traz protobuf para dentro do worker por causa de quatro chamadas. A resposta
 * JSON vem em lowerCamelCase (`costMicros`), `int64` como STRING e GAQL em
 * snake_case — `inteiro()` faz a conversão num lugar só.
 *
 * ─── Por que o erro nunca lança ──────────────────────────────────────────
 *
 * Quem chama é cron (sync de gasto, upload de conversão) e agente. Um `throw`
 * aqui vira "sync falhou" sem explicação na tela da Conta. Os dois erros de
 * autorização que TODO operador novo encontra — developer token não aprovado e
 * conta fora do MCC — voltam com o nome do Google em `code` e uma frase em
 * português em `motivo` dizendo o que fazer.
 */
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

import { type ConfigDoGoogleAds, configDoGoogleAds, semHifen } from "./config";
import { accessToken, limparCacheDeToken } from "./token";

export const BASE_DA_API = "https://googleads.googleapis.com";
export const TEMPO_LIMITE_MS = 20_000;

export type CodigoDeFalha =
  | "nao_configurado"
  | "entrada_invalida"
  | "token"
  | "rede"
  | "http"
  | "resposta_invalida"
  | "DEVELOPER_TOKEN_NOT_APPROVED"
  | "USER_PERMISSION_DENIED";

export interface FalhaDoGoogleAds {
  ok: false;
  code: CodigoDeFalha;
  motivo: string;
}

export type ResultadoDoGoogleAds<T> = { ok: true; valor: T } | FalhaDoGoogleAds;

export interface OpcoesDoCliente {
  /**
   * Config explícita (teste, script). `undefined` lê de `env`; `null` é "não
   * configurado" de propósito.
   */
  config?: ConfigDoGoogleAds | null;
}

export function falha(code: CodigoDeFalha, motivo: string): FalhaDoGoogleAds {
  return { ok: false, code, motivo };
}

export function resolverConfig(opcoes?: OpcoesDoCliente): ConfigDoGoogleAds | null {
  return opcoes && "config" in opcoes ? (opcoes.config ?? null) : configDoGoogleAds(env);
}

/** 10 dígitos, ou `null`. É o único valor que entra na URL. */
export function customerIdValido(customerId: string): string | null {
  const id = semHifen(customerId);
  return /^\d{10}$/.test(id) ? id : null;
}

/** `int64` chega como string; ausente vira 0. Nunca NaN. */
export function inteiro(valor: unknown): number {
  const n = typeof valor === "string" ? Number(valor) : typeof valor === "number" ? valor : 0;
  return Number.isFinite(n) ? n : 0;
}

export function inteiroOuNull(valor: unknown): number | null {
  if (valor === undefined || valor === null) return null;
  return inteiro(valor);
}

/** As frases para o operador. `code` mantém o nome do Google para quem for procurar. */
const MOTIVOS_DE_AUTORIZACAO: Record<
  "DEVELOPER_TOKEN_NOT_APPROVED" | "USER_PERMISSION_DENIED",
  string
> = {
  DEVELOPER_TOKEN_NOT_APPROVED:
    "O developer token do Google Ads ainda não foi aprovado (ou está em acesso de teste, que só " +
    "alcança contas de teste). Peça o acesso básico no Centro de API do MCC e aguarde o e-mail do Google.",
  USER_PERMISSION_DENIED:
    "A conta Google que gerou o refresh token não alcança este customer id. Vincule a conta da clínica " +
    "ao MCC e confira se GOOGLE_ADS_LOGIN_CUSTOMER_ID é o id do MCC (10 dígitos), não o da clínica.",
};

interface ErroDoGoogle {
  errorCode?: Record<string, string>;
  message?: string;
  location?: { fieldPathElements?: { fieldName?: string; index?: number }[] };
}

interface CorpoDeErro {
  error?: {
    code?: number;
    message?: string;
    details?: { errors?: ErroDoGoogle[]; requestId?: string }[];
  };
}

/** Todos os `errorCode` de um corpo de erro, achatados em `"<tipo>:<NOME>"`. */
export function codigosDeErro(detalhes: { errors?: ErroDoGoogle[] }[] | undefined): string[] {
  const saida: string[] = [];
  for (const d of detalhes ?? []) {
    for (const e of d.errors ?? []) {
      for (const [tipo, nome] of Object.entries(e.errorCode ?? {})) saida.push(`${tipo}:${nome}`);
    }
  }
  return saida;
}

function traduzirErroHttp(status: number, corpo: CorpoDeErro): FalhaDoGoogleAds {
  const codigos = codigosDeErro(corpo.error?.details);
  for (const nome of ["DEVELOPER_TOKEN_NOT_APPROVED", "USER_PERMISSION_DENIED"] as const) {
    if (codigos.some((c) => c.endsWith(`:${nome}`)))
      return falha(nome, MOTIVOS_DE_AUTORIZACAO[nome]);
  }
  const mensagem = corpo.error?.message ?? "sem mensagem";
  const lista = codigos.length ? ` [${codigos.join(", ")}]` : "";
  return falha("http", `Google Ads respondeu HTTP ${status}: ${mensagem}${lista}`);
}

/**
 * `POST {base}/{versão}/{caminho}` com token, developer token e MCC.
 *
 * `caminho` é relativo à versão (`customers/123/googleAds:searchStream`); quem
 * chama já validou o customer id com `customerIdValido`.
 */
export async function chamarGoogleAds<T>(
  caminho: string,
  corpo: unknown,
  opcoes?: OpcoesDoCliente,
): Promise<ResultadoDoGoogleAds<T>> {
  const config = resolverConfig(opcoes);
  const token = await accessToken(config);
  if (!token.ok) return token;
  // `config` é não-nulo aqui: sem config, `accessToken` já devolveu `nao_configurado`.
  const cfg = config as ConfigDoGoogleAds;

  const url = `${BASE_DA_API}/${cfg.apiVersion}/${caminho}`;
  let resposta: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    resposta = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.valor}`,
        "developer-token": cfg.developerToken,
        "login-customer-id": cfg.loginCustomerId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
  } catch (erro) {
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    logger.warn("google-ads: rede", { caminho, erro: mensagem });
    return falha("rede", `Sem resposta do Google Ads em ${caminho}: ${mensagem}`);
  }

  let json: unknown;
  try {
    json = await resposta.json();
  } catch {
    json = undefined;
  }

  if (!resposta.ok) {
    // Token expirado entre o cache e a chamada: o próximo pedido troca de novo.
    if (resposta.status === 401) limparCacheDeToken();
    const resultado = traduzirErroHttp(resposta.status, (json ?? {}) as CorpoDeErro);
    logger.warn("google-ads: erro http", {
      caminho,
      status: resposta.status,
      code: resultado.code,
    });
    return resultado;
  }
  if (json === undefined) {
    return falha(
      "resposta_invalida",
      `Google Ads respondeu ${resposta.status} sem JSON em ${caminho}.`,
    );
  }
  return { ok: true, valor: json as T };
}

/** Uma linha do `searchStream`: os campos que a GAQL pediu, em lowerCamelCase. */
export type LinhaDaPesquisa = Record<string, Record<string, unknown> | undefined>;

interface ChunkDaPesquisa {
  results?: LinhaDaPesquisa[];
  requestId?: string;
}

/** `searchStream` devolve um ARRAY de chunks; aqui os `results` voltam achatados. */
export async function pesquisar(
  customerId: string,
  gaql: string,
  opcoes?: OpcoesDoCliente,
): Promise<ResultadoDoGoogleAds<LinhaDaPesquisa[]>> {
  const r = await chamarGoogleAds<ChunkDaPesquisa[]>(
    `customers/${customerId}/googleAds:searchStream`,
    { query: gaql },
    opcoes,
  );
  if (!r.ok) return r;
  if (!Array.isArray(r.valor)) {
    return falha("resposta_invalida", "searchStream não devolveu a lista de chunks esperada.");
  }
  return { ok: true, valor: r.valor.flatMap((chunk) => chunk.results ?? []) };
}
