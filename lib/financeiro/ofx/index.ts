/**
 * Leitor de OFX — a porta do módulo financeiro para o extrato do banco.
 *
 * ~250 linhas próprias, zero dependência nova no `pnpm-lock`. As duas
 * bibliotecas do npm foram rodadas contra extratos reais de BB, Bradesco,
 * Santander e Caixa antes desta decisão:
 *
 *   - `ofx-data-extractor@1.5.0` classifica crédito/débito pelo `TRNTYPE` em
 *     vez do sinal do `TRNAMT`. Num extrato Santander cujos quatro lançamentos
 *     somam exatamente R$ 0,00 (todos `TRNTYPE:OTHER`), ela reporta +94,02 de
 *     crédito e 0,00 de débito. A spec OFX 2.2 §3.2.9.2 diz em texto literal o
 *     contrário: o sinal está no `TRNAMT`.
 *   - `ofx-js@1.1.1` tokeniza bem, mas recebe `string` (ignora o `CHARSET`, e
 *     `CARTÃO` em cp1252 vira lixo) e **lança** se um `MEMO` contiver `<`.
 *
 * E as partes difíceis — cp1252, vírgula decimal, dia sem passar por UTC,
 * centavos inteiros, chave de idempotência — nenhuma das duas faz. É o mesmo
 * raciocínio de `lib/contacts/csv.ts`: parser próprio, pequeno e testado, em
 * vez de dependência transitiva nova numa instalação self-host.
 *
 * Puro e determinístico, no molde de `lib/ads/sobra.ts`: sem banco, sem
 * Supabase, sem `organization_id`, e dado faltante é `null` explícito — nunca 0.
 */
import { lerCabecalho } from "./header";
import { tokenizar } from "./tokenizer";
import { extrair } from "./extrair";
import type { ExtratoLido } from "./tipos";

/** Bytes do arquivo → extrato lido. É a única função que o resto do módulo chama. */
export function lerOfx(buf: Buffer): ExtratoLido {
  const { versao, charset, corpo } = lerCabecalho(buf);
  const { lancamentos, saldos, descartados } = extrair(tokenizar(corpo));
  return { versao, charset, lancamentos, saldos, descartados };
}

export { lerCabecalho, type CabecalhoOfx } from "./header";
export { tokenizar, asArray, texto, filho, filhos, type No, type ValorDeNo } from "./tokenizer";
export { paraCentavos, diaDoDtposted, tipoDeTransacao, descricaoDe } from "./normalizar";
export { extrair, type ExtracaoOfx } from "./extrair";
export {
  OFX_MAX_BYTES,
  OFX_MAX_LANCAMENTOS,
  TRN_TYPES,
  type ContaDoExtrato,
  type ContaKind,
  type Descartado,
  type ExtratoLido,
  type LancamentoOfx,
  type SaldoOfx,
  type TrnType,
} from "./tipos";
