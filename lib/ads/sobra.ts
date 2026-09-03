/**
 * Sobra por Real — a promessa central do produto (Spec 0003, ADR-0017).
 *
 * Por campanha e período: quanto sobrou para o Dono (valor pago × Margem
 * Declarada do serviço) dividido pela Verba lida da API. Não é ROAS: ROAS
 * ignora a margem. Puro e determinístico; quem lê o banco é `relatorio.ts`.
 *
 * Dia do período sem linha de gasto é dado FALTANTE: a campanha (e o total)
 * ficam `incompleto = true` em vez de fingir zero. Venda sem Margem Declarada
 * entra na receita mas não na sobra, contada à parte (`vendasSemMargem`).
 */

export interface GastoDoDia {
  campaignId: string;
  campaignName?: string | null;
  /** Data `YYYY-MM-DD` no fuso da conta de anúncios. */
  date: string;
  costMicros: number;
}

export interface VendaAtribuida {
  campaignId: string;
  contactId: string;
  appointmentId: string;
  paidCents: number;
  marginBps: number | null;
}

export interface ContatoAtribuido {
  campaignId: string;
  contactId: string;
}

export interface EntradaDeSobra {
  periodo: { de: string; ate: string };
  gastos: GastoDoDia[];
  vendas: VendaAtribuida[];
  contatos: ContatoAtribuido[];
}

export interface SobraDaCampanha {
  campaignId: string;
  campaignName: string | null;
  gastoCents: number;
  contatos: number;
  vendas: number;
  vendasSemMargem: number;
  receitaCents: number;
  sobraCents: number;
  /** `null` quando não há gasto: nunca dividir por zero nem devolver infinito. */
  sobraPorReal: number | null;
  diasSemGasto: string[];
  incompleto: boolean;
}

export interface ResultadoDeSobra {
  periodo: { de: string; ate: string };
  campanhas: SobraDaCampanha[];
  total: { gastoCents: number; receitaCents: number; sobraCents: number; sobraPorReal: number | null; incompleto: boolean };
}

export function centavosDeMicros(micros: number): number {
  return Math.round(micros / 10_000);
}

/**
 * O inverso — para a Fase 8, que MANDA orçamento ao Google em vez de só ler.
 * 1 centavo = 10.000 micros (1 unidade de moeda = 1.000.000 micros, §Google Ads API).
 */
export function microsDeCentavos(cents: number): number {
  return cents * 10_000;
}

export function diasDoPeriodo(de: string, ate: string): string[] {
  const dias: string[] = [];
  const cursor = new Date(`${de}T00:00:00Z`);
  const fim = new Date(`${ate}T00:00:00Z`);
  while (cursor.getTime() <= fim.getTime()) {
    dias.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dias;
}

export function calcularSobraPorReal(entrada: EntradaDeSobra): ResultadoDeSobra {
  const dias = diasDoPeriodo(entrada.periodo.de, entrada.periodo.ate);
  const ids = new Set<string>();
  for (const g of entrada.gastos) ids.add(g.campaignId);
  for (const v of entrada.vendas) ids.add(v.campaignId);
  for (const c of entrada.contatos) ids.add(c.campaignId);

  const campanhas: SobraDaCampanha[] = [...ids].sort().map((campaignId) => {
    const gastos = entrada.gastos.filter((g) => g.campaignId === campaignId);
    const vendas = entrada.vendas.filter((v) => v.campaignId === campaignId);
    const contatos = new Set(entrada.contatos.filter((c) => c.campaignId === campaignId).map((c) => c.contactId));
    const gastoCents = gastos.reduce((acc, g) => acc + centavosDeMicros(g.costMicros), 0);
    const receitaCents = vendas.reduce((acc, v) => acc + v.paidCents, 0);
    const comMargem = vendas.filter((v) => v.marginBps !== null);
    const sobraCents = comMargem.reduce((acc, v) => acc + Math.round((v.paidCents * (v.marginBps as number)) / 10_000), 0);
    const diasComGasto = new Set(gastos.map((g) => g.date));
    const diasSemGasto = dias.filter((d) => !diasComGasto.has(d));
    return {
      campaignId,
      campaignName: gastos.find((g) => g.campaignName)?.campaignName ?? null,
      gastoCents,
      contatos: contatos.size,
      vendas: vendas.length,
      vendasSemMargem: vendas.length - comMargem.length,
      receitaCents,
      sobraCents,
      sobraPorReal: gastoCents > 0 ? sobraCents / gastoCents : null,
      diasSemGasto,
      incompleto: diasSemGasto.length > 0,
    };
  });

  const total = campanhas.reduce(
    (acc, c) => ({
      gastoCents: acc.gastoCents + c.gastoCents,
      receitaCents: acc.receitaCents + c.receitaCents,
      sobraCents: acc.sobraCents + c.sobraCents,
      incompleto: acc.incompleto || c.incompleto,
    }),
    { gastoCents: 0, receitaCents: 0, sobraCents: 0, incompleto: false },
  );
  return {
    periodo: entrada.periodo,
    campanhas,
    total: { ...total, sobraPorReal: total.gastoCents > 0 ? total.sobraCents / total.gastoCents : null },
  };
}
