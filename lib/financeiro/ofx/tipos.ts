/**
 * Tipos do leitor de OFX — o vocabulário que o resto do módulo financeiro lê.
 *
 * Nada aqui conhece banco de dados nem `organization_id`: `chaveBruta` é
 * determinística e SEM org de propósito, para que quem persiste possa hashear
 * org + chave sem que o parser precise saber de tenancy.
 */

/** Conta de banco ou fatura de cartão — os dois ramos da árvore do OFX. */
export type ContaKind = "bank" | "credit_card";

export interface ContaDoExtrato {
  /** `BANKID`. Vazio em cartão: `CCACCTFROM` não tem banco. */
  bankId: string;
  acctId: string;
  kind: ContaKind;
  /** `ACCTTYPE` (CHECKING, SAVINGS…). Cartão não declara. */
  acctType: string | null;
}

/**
 * Os 18 tipos da §11.4.4.3. Valor fora da lista vira `"OTHER"` em vez de
 * derrubar o arquivo — o sinal do dinheiro está no `TRNAMT`, não aqui.
 */
export type TrnType =
  | "CREDIT"
  | "DEBIT"
  | "INT"
  | "DIV"
  | "FEE"
  | "SRVCHG"
  | "DEP"
  | "ATM"
  | "POS"
  | "XFER"
  | "CHECK"
  | "PAYMENT"
  | "CASH"
  | "DIRECTDEP"
  | "DIRECTDEBIT"
  | "REPEATPMT"
  | "HOLD"
  | "OTHER";

/** A lista em runtime — a mesma que o `check` da coluna `trn_type` cobra. */
export const TRN_TYPES: readonly TrnType[] = [
  "CREDIT",
  "DEBIT",
  "INT",
  "DIV",
  "FEE",
  "SRVCHG",
  "DEP",
  "ATM",
  "POS",
  "XFER",
  "CHECK",
  "PAYMENT",
  "CASH",
  "DIRECTDEP",
  "DIRECTDEBIT",
  "REPEATPMT",
  "HOLD",
  "OTHER",
] as const;

export interface LancamentoOfx {
  conta: ContaDoExtrato;
  tipo: TrnType;
  /** `YYYY-MM-DD`. */
  dia: string;
  /**
   * O `DTPOSTED` como o banco escreveu. Guardado porque "lançamento no mesmo
   * dia do saldo" é decisão de dinheiro e só dá para refinar com a hora.
   */
  dtpostedBruto: string;
  /** Com sinal: negativo é saída. O sinal vem do `TRNAMT` (§3.2.9.2). */
  valorCents: number;
  moeda: string;
  fitid: string | null;
  checknum: string | null;
  descricao: string;
  /** Determinística e SEM `organization_id` — quem hasheia com a org é o importador. */
  chaveBruta: string;
  chaveOrigem: "fitid" | "conteudo";
}

export interface SaldoOfx {
  conta: ContaDoExtrato;
  tipo: "ledger" | "available";
  /** `YYYY-MM-DD`. */
  dia: string;
  dtasofBruto: string;
  valorCents: number;
}

/** Linha que o parser recusou, com o motivo legível que vai para a tela. */
export interface Descartado {
  motivo: string;
  contexto: string;
}

export interface ExtratoLido {
  versao: "1" | "2";
  charset: string;
  lancamentos: LancamentoOfx[];
  saldos: SaldoOfx[];
  descartados: Descartado[];
}

/** Máximo defensivo: arquivo maior que isso é recusado antes do parse. */
export const OFX_MAX_BYTES = 5 * 1024 * 1024;

/** Teto de lançamentos por arquivo (protege o round-trip do importador). */
export const OFX_MAX_LANCAMENTOS = 5000;
