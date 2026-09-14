/**
 * Vencimentos — o que vence hoje, o que já venceu e o que vem na semana
 * (Spec 0003, "O dinheiro"; migration 0244, `financial_obligations`).
 *
 * Conta a Pagar e Conta a Receber são uma tabela só, com `direction`: o
 * `CONTEXT.md` as define numa entrada única de glossário. Por isso cada grupo
 * daqui traz a lista inteira mais o total SEPARADO por direção — juntar
 * pagar com receber num número só seria inventar um saldo que ninguém pediu.
 *
 * Puro e determinístico, irmão de `caixa.ts`: recebe linhas já lidas do banco
 * e devolve números. `hoje` entra como `"YYYY-MM-DD"` já resolvido pelo
 * chamador (o cron sabe o fuso da Conta; este módulo não) — NUNCA `new Date()`
 * aqui dentro. Comparar dias é comparar string `YYYY-MM-DD`.
 *
 * Só `status: 'open'` conta: pago e cancelado não vencem.
 */

/** As duas direções do compromisso. O sinal é esta coluna, nunca o valor. */
export type DirecaoDaObrigacao = "payable" | "receivable";

export type StatusDaObrigacao = "open" | "paid" | "cancelled";

/** Linha de `financial_obligations` já lida do banco. */
export interface Obrigacao {
  id: string;
  direction: DirecaoDaObrigacao;
  description: string;
  /** `amount_cents`, sempre positivo — o `check` da migration cobra isso. */
  amountCents: number;
  /** `due_on`, `YYYY-MM-DD`. */
  dueOn: string;
  status: StatusDaObrigacao;
}

export interface GrupoDeVencimento {
  itens: Obrigacao[];
  totalCents: Record<DirecaoDaObrigacao, number>;
}

export interface ResultadoDeVencimentos {
  /** O dia que o chamador declarou — repetido aqui para a tela não recalcular. */
  hoje: string;
  vencemHoje: GrupoDeVencimento;
  /** Antes de `hoje`, mais velha primeiro: é a fila que o Dono está devendo. */
  vencidas: GrupoDeVencimento;
  /** Depois de `hoje` até `hoje + 7`. Disjunto de `vencemHoje` de propósito. */
  proximos7: GrupoDeVencimento;
}

/**
 * Aritmética de calendário a partir de um dia EXPLÍCITO — não de "agora".
 * Mesmo desenho do `diasDoPeriodo` de `lib/ads/sobra.ts`: `Date` em UTC serve
 * para somar dias; para comparar dias, quem serve é a string.
 */
export function somarDias(dia: string, dias: number): string {
  const d = new Date(`${dia}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function agrupar(itens: Obrigacao[]): GrupoDeVencimento {
  const ordenadas = [...itens].sort((a, b) => (a.dueOn === b.dueOn ? (a.id < b.id ? -1 : 1) : a.dueOn < b.dueOn ? -1 : 1));
  return {
    itens: ordenadas,
    totalCents: {
      payable: ordenadas.filter((o) => o.direction === "payable").reduce((acc, o) => acc + o.amountCents, 0),
      receivable: ordenadas.filter((o) => o.direction === "receivable").reduce((acc, o) => acc + o.amountCents, 0),
    },
  };
}

export function vencimentosDoDia(obrigacoes: Obrigacao[], hoje: string): ResultadoDeVencimentos {
  const abertas = obrigacoes.filter((o) => o.status === "open");
  const limite = somarDias(hoje, 7);
  return {
    hoje,
    vencemHoje: agrupar(abertas.filter((o) => o.dueOn === hoje)),
    vencidas: agrupar(abertas.filter((o) => o.dueOn < hoje)),
    proximos7: agrupar(abertas.filter((o) => o.dueOn > hoje && o.dueOn <= limite)),
  };
}
