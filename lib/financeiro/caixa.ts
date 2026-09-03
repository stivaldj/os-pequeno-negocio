/**
 * Caixa — o saldo que não mente (Spec 0003; migration 0209; decisão 3 do plano
 * da Fase 6).
 *
 * O Dono importa uma JANELA do extrato: um mês, uma semana. Somar os
 * lançamentos dessa janela dá o movimento dela, nunca o saldo. O saldo
 * verdadeiro é o `LEDGERBAL` que o próprio banco declarou, com seu `DTASOF`
 * (é o que `ledger_balances` guarda, e o `comment on table` da migration diz
 * isso em voz alta). O caixa é esse saldo, mais o que se moveu DEPOIS dele.
 *
 * Puro e determinístico, no molde de `lib/ads/sobra.ts`: recebe linhas já
 * lidas do banco e devolve números. Nada de Supabase aqui; quem lê o Postgres
 * é a rota. Nada de `new Date()` tampouco — comparar dias é comparar string
 * `YYYY-MM-DD`, que já ordena sozinha.
 *
 * A disciplina do "dia sem gasto lido" do módulo de ads vale igual: conta sem
 * saldo lido é `incompleto: true`, NUNCA zero, e `totalCents` inteiro vira
 * `null` se QUALQUER conta estiver incompleta — meia verdade sobre caixa é
 * pior para o Dono que um "não sei" honesto.
 *
 * Moeda fica de fora de propósito: o schema declara `currency char(3) default
 * 'BRL'` e a instalação é de uma moeda só. Somar moedas diferentes é outro
 * problema, e ele ainda não existe.
 */

import type { ContaKind } from "@/lib/financeiro/ofx/tipos";

/** O que identifica uma conta no livro-caixa: banco + conta + ramo da árvore. */
interface Conta {
  /** `ledger_*.bank_id`. Vazio em cartão: `CCACCTFROM` não tem `BANKID`. */
  bankId: string;
  /** `ledger_*.account_id`. */
  acctId: string;
  /** `ledger_*.account_kind`. */
  kind: ContaKind;
}

/** Linha de `ledger_balances` já lida do banco. */
export interface LinhaDeSaldo extends Conta {
  /** `ledger_balances.kind`. */
  tipo: "ledger" | "available";
  /** `as_of`, `YYYY-MM-DD`: o dia que o banco declarou junto com o saldo. */
  saldoEm: string;
  /** `balance_cents`. Assinado: conta pode estar negativa, cartão quase sempre está. */
  saldoCents: number;
}

/** Linha de `ledger_entries` já lida do banco. */
export interface LinhaDeLancamento extends Conta {
  /** `posted_on`, `YYYY-MM-DD`. */
  dia: string;
  /** `amount_cents`. Assinado: o sinal vem do `TRNAMT` (OFX 2.2 §3.2.9.2). */
  valorCents: number;
}

export interface EntradaDeCaixa {
  saldos: LinhaDeSaldo[];
  lancamentos: LinhaDeLancamento[];
}

export interface SaldoDaConta extends Conta {
  /** `null` = conta nunca teve saldo importado. Nunca zero: zero é uma afirmação. */
  saldoCents: number | null;
  /** O `as_of` do saldo que valeu. A tela mostra esta data ao lado do número. */
  saldoEm: string | null;
  /** Lançamentos posteriores ao `saldoEm` — sem saldo lido, todos os importados. */
  lancamentosDepois: number;
  somaDepoisCents: number;
  /** `saldoCents + somaDepoisCents`, ou `null` quando não há saldo em que ancorar. */
  saldoEstimadoCents: number | null;
  incompleto: boolean;
}

export interface ResultadoDeCaixa {
  contas: SaldoDaConta[];
  /** `null` se QUALQUER conta estiver incompleta. */
  totalCents: number | null;
  incompleto: boolean;
}

function idDaConta(c: Conta): string {
  return `${c.bankId}|${c.acctId}|${c.kind}`;
}

/**
 * Qual saldo vale quando o Dono importou janeiro e depois fevereiro: o de
 * `as_of` mais recente. Empatada a data, `ledger` manda sobre `available` —
 * é o saldo que o banco fecha; `available` já mexeu com limite e bloqueio.
 */
function saldoQueVale(atual: LinhaDeSaldo, candidato: LinhaDeSaldo): LinhaDeSaldo {
  if (atual.saldoEm !== candidato.saldoEm) return candidato.saldoEm > atual.saldoEm ? candidato : atual;
  if (atual.tipo !== candidato.tipo) return candidato.tipo === "ledger" ? candidato : atual;
  return atual;
}

export function calcularCaixa({ saldos, lancamentos }: EntradaDeCaixa): ResultadoDeCaixa {
  const contasVistas = new Map<string, Conta>();
  for (const linha of [...saldos, ...lancamentos]) {
    contasVistas.set(idDaConta(linha), { bankId: linha.bankId, acctId: linha.acctId, kind: linha.kind });
  }

  const contas: SaldoDaConta[] = [...contasVistas.keys()].sort().map((id) => {
    const conta = contasVistas.get(id) as Conta;
    const saldo = saldos
      .filter((s) => idDaConta(s) === id)
      .reduce<LinhaDeSaldo | null>((melhor, s) => (melhor === null ? s : saldoQueVale(melhor, s)), null);

    // A armadilha que dá dinheiro errado ao Dono: lançamento do MESMO dia do
    // `as_of` já está dentro do saldo que o banco declarou — somá-lo de novo é
    // contar duas vezes. Só entra o estritamente posterior. Sem saldo lido não
    // há corte: não há o que contar duas vezes, e o movimento importado segue
    // sendo um fato que a tela pode mostrar (o que falta é a âncora, e ela
    // falta em voz alta, no `incompleto`).
    const depois = lancamentos.filter((l) => idDaConta(l) === id && (saldo === null || l.dia > saldo.saldoEm));
    const somaDepoisCents = depois.reduce((acc, l) => acc + l.valorCents, 0);

    return {
      ...conta,
      saldoCents: saldo?.saldoCents ?? null,
      saldoEm: saldo?.saldoEm ?? null,
      lancamentosDepois: depois.length,
      somaDepoisCents,
      saldoEstimadoCents: saldo === null ? null : saldo.saldoCents + somaDepoisCents,
      incompleto: saldo === null,
    };
  });

  const incompleto = contas.some((c) => c.incompleto);
  return {
    contas,
    totalCents: incompleto ? null : contas.reduce((acc, c) => acc + (c.saldoEstimadoCents ?? 0), 0),
    incompleto,
  };
}
