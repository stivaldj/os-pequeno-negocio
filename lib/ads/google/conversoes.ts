/**
 * Conversão offline: a consulta paga volta ao Google com o gclid.
 *
 * `uploadClickConversions` com `partialFailure: true`: uma linha ruim (clique
 * expirado, orderId repetido) não derruba as outras, e o resultado volta POR
 * ÍNDICE para o cron marcar cada `ad_conversion_uploads` como enviada ou com o
 * erro do Google.
 *
 * O que sobe é o mínimo: o identificador do clique, a ação de conversão, o
 * instante, o valor e o id do agendamento como `orderId` (idempotência do lado
 * do Google). Nenhum dado do paciente — nem hash de e-mail ou telefone.
 */
import {
  chamarGoogleAds,
  customerIdValido,
  falha,
  type OpcoesDoCliente,
  type ResultadoDoGoogleAds,
} from "./cliente";

export interface LinhaDeConversao {
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  /** `customers/<cid>/conversionActions/<id>`, da Conta (`ad_accounts.conversion_action`). */
  conversionAction: string;
  /** `yyyy-mm-dd hh:mm:ss±hh:mm` — ver `formatarDataHoraDeConversao`. */
  conversionDateTime: string;
  conversionValue: number;
  currencyCode?: string;
  /** O id do agendamento: o Google recusa `orderId` repetido, e é isso que queremos. */
  orderId: string;
}

export type ResultadoDaLinha = { ok: true } | { ok: false; erro: string };

/** Erros decididos AQUI, antes da rede — nomes nossos, em maiúsculas como os do Google. */
export const ERRO_GBRAID_E_WBRAID = "GBRAID_E_WBRAID_JUNTOS";
export const ERRO_SEM_IDENTIFICADOR = "SEM_IDENTIFICADOR_DE_CLIQUE";

const DOIS_DIGITOS = (n: number) => String(n).padStart(2, "0");

/**
 * O formato que o Google exige, no fuso pedido. Default `-03:00` (Brasília; o
 * país não tem horário de verão desde 2019). Quem estiver em outro fuso passa
 * o deslocamento em minutos.
 */
export function formatarDataHoraDeConversao(data: Date, deslocamentoMinutos = -180): string {
  const local = new Date(data.getTime() + deslocamentoMinutos * 60_000);
  const sinal = deslocamentoMinutos < 0 ? "-" : "+";
  const abs = Math.abs(deslocamentoMinutos);
  return (
    `${local.getUTCFullYear()}-${DOIS_DIGITOS(local.getUTCMonth() + 1)}-${DOIS_DIGITOS(local.getUTCDate())} ` +
    `${DOIS_DIGITOS(local.getUTCHours())}:${DOIS_DIGITOS(local.getUTCMinutes())}:${DOIS_DIGITOS(local.getUTCSeconds())}` +
    `${sinal}${DOIS_DIGITOS(Math.floor(abs / 60))}:${DOIS_DIGITOS(abs % 60)}`
  );
}

interface ErroParcial {
  errorCode?: Record<string, string>;
  message?: string;
  location?: { fieldPathElements?: { fieldName?: string; index?: number }[] };
}

interface RespostaDeUpload {
  results?: unknown[];
  partialFailureError?: { details?: { errors?: ErroParcial[] }[] };
}

function erroLocal(linha: LinhaDeConversao): string | null {
  const temGbraid = Boolean(linha.gbraid);
  const temWbraid = Boolean(linha.wbraid);
  if (temGbraid && temWbraid) return ERRO_GBRAID_E_WBRAID;
  if (!linha.gclid && !temGbraid && !temWbraid) return ERRO_SEM_IDENTIFICADOR;
  return null;
}

function corpoDaLinha(linha: LinhaDeConversao): Record<string, unknown> {
  return {
    ...(linha.gclid ? { gclid: linha.gclid } : {}),
    ...(linha.gbraid ? { gbraid: linha.gbraid } : {}),
    ...(linha.wbraid ? { wbraid: linha.wbraid } : {}),
    conversionAction: linha.conversionAction,
    conversionDateTime: linha.conversionDateTime,
    conversionValue: linha.conversionValue,
    currencyCode: linha.currencyCode ?? "BRL",
    orderId: linha.orderId,
  };
}

/** O índice em `conversions` que o Google anotou no erro, ou `null`. */
function indiceDoErro(erro: ErroParcial): number | null {
  const elemento = erro.location?.fieldPathElements?.find(
    (e) => e.fieldName === "conversions" && typeof e.index === "number",
  );
  return elemento?.index ?? null;
}

function nomeDoErro(erro: ErroParcial): string {
  const nomes = Object.values(erro.errorCode ?? {});
  return nomes[0] ?? erro.message ?? "ERRO_DESCONHECIDO";
}

/**
 * Sobe as linhas e devolve um resultado por linha, NA ORDEM DE ENTRADA — a
 * linha que falhou localmente não vai ao Google, e os índices da resposta são
 * remapeados para os originais.
 */
export async function subirConversoes(
  conversionCustomerId: string,
  linhas: LinhaDeConversao[],
  opcoes?: OpcoesDoCliente,
): Promise<ResultadoDoGoogleAds<ResultadoDaLinha[]>> {
  const cid = customerIdValido(conversionCustomerId);
  if (!cid) {
    return falha(
      "entrada_invalida",
      `customer id inválido: ${JSON.stringify(conversionCustomerId)}`,
    );
  }

  const resultado: ResultadoDaLinha[] = [];
  const enviadas: { indiceOriginal: number; corpo: Record<string, unknown> }[] = [];
  linhas.forEach((linha, i) => {
    const erro = erroLocal(linha);
    if (erro) {
      resultado[i] = { ok: false, erro };
    } else {
      resultado[i] = { ok: true };
      enviadas.push({ indiceOriginal: i, corpo: corpoDaLinha(linha) });
    }
  });
  if (enviadas.length === 0) return { ok: true, valor: resultado };

  const r = await chamarGoogleAds<RespostaDeUpload>(
    `customers/${cid}:uploadClickConversions`,
    { conversions: enviadas.map((e) => e.corpo), partialFailure: true },
    opcoes,
  );
  if (!r.ok) return r;

  for (const detalhe of r.valor?.partialFailureError?.details ?? []) {
    for (const erro of detalhe.errors ?? []) {
      const indice = indiceDoErro(erro);
      const alvo = indice === null ? undefined : enviadas[indice];
      if (!alvo) continue;
      resultado[alvo.indiceOriginal] = { ok: false, erro: nomeDoErro(erro) };
    }
  }
  return { ok: true, valor: resultado };
}
