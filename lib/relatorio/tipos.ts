/**
 * Vocabulário do Relatório das 8h (Spec 0003, Fase 7).
 *
 * `lib/relatorio/` monta e manda; não calcula. Cada seção aqui é o formato de
 * SAÍDA de um leitor que consome um módulo já existente — `atendimentos.ts`
 * lê `fn_atrito_metrics`, `agenda.ts` lê `lib/agenda/consulta.ts`, `ads.ts` lê
 * `lib/ads/relatorio.ts`, `financeiro.ts` lê `lib/financeiro/relatorio.ts`.
 * Nenhum arquivo deste módulo soma, divide ou decide dinheiro.
 *
 * `incompleto: boolean` está em toda seção, nunca inferido de zero: cada
 * leitor decide por si (RPC que falhou, `sobra.incompleto`, `caixa.incompleto`
 * ou obrigação sem `financial_obligations` legível) e `montar.ts` só repete o
 * que recebeu.
 */

export interface SecaoAtendimentos {
  /** `escopo.demandas` de `fn_atrito_metrics` — demandas encerradas na janela. */
  atendidos: number;
  /** `cliente.pedidos_de_humano` — quantas pediram humano na mesma janela. */
  passadosParaHumano: number;
  incompleto: boolean;
}

export interface ItemDeAgenda {
  titulo: string;
  horario: string;
  contatoNome: string | null;
  situacao: string;
  /** ADR-0017. `null` = ainda não compareceu ou não foi marcado. */
  pagoCents: number | null;
}

export interface SecaoAgenda {
  itens: ItemDeAgenda[];
  incompleto: boolean;
}

export interface CampanhaDeOntem {
  campaignId: string;
  campaignName: string | null;
  gastoCents: number;
  /** `null` quando não há gasto: nunca dividir por zero. */
  sobraPorReal: number | null;
  incompleto: boolean;
}

export interface PropostaPendente {
  id: string;
  title: string;
  kind: string;
}

export interface SecaoAds {
  campanhas: CampanhaDeOntem[];
  gastoTotalCents: number;
  sobraPorRealTotal: number | null;
  propostasPendentes: PropostaPendente[];
  incompleto: boolean;
}

export interface ItemDeVencimento {
  description: string;
  amountCents: number;
  direction: "payable" | "receivable";
  /** `YYYY-MM-DD`. Só difere de `hoje` para as vencidas. */
  dueOn: string;
}

export interface SecaoFinanceiro {
  /** `null` = falta saldo em alguma conta — nunca zero. */
  caixaTotalCents: number | null;
  vencemHojeCents: { payable: number; receivable: number };
  vencidasCents: { payable: number; receivable: number };
  vencemHojeItens: ItemDeVencimento[];
  vencidasItens: ItemDeVencimento[];
  incompleto: boolean;
}

export interface RelatorioDiario {
  organizationId: string;
  /** `YYYY-MM-DD` no fuso da Conta — o dia que o relatório descreve. */
  hoje: string;
  atendimentos: SecaoAtendimentos;
  agenda: SecaoAgenda;
  ads: SecaoAds;
  financeiro: SecaoFinanceiro;
  texto: string;
  /** Nomes das seções com `incompleto: true` — vai para `daily_reports.incomplete_sections`. */
  secoesIncompletas: string[];
}
