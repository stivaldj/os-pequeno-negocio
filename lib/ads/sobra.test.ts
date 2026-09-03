/**
 * Sobra por Real (Spec 0003, ADR-0017): quanto sobra para o Dono a cada real
 * de Verba, por campanha, com a Margem Declarada do serviço — não ROAS. Dia sem
 * linha de gasto é INCOMPLETO, nunca zero. É a fixture da prova da issue #23.
 */
import { describe, expect, it } from "vitest";
import { calcularSobraPorReal, centavosDeMicros, microsDeCentavos } from "@/lib/ads/sobra";

const PERIODO = { de: "2026-09-01", ate: "2026-09-02" };
const GASTOS = [
  { campaignId: "111", campaignName: "Busca", date: "2026-09-01", costMicros: 50_000_000 }, // R$ 50
  { campaignId: "111", campaignName: "Busca", date: "2026-09-02", costMicros: 30_000_000 }, // R$ 30
  { campaignId: "222", campaignName: "Display", date: "2026-09-01", costMicros: 20_000_000 }, // R$ 20 — sem dia 02
];
// 3 contatos atribuídos; 2 consultas pagas com margens diferentes; 1 sem venda.
const VENDAS = [
  { campaignId: "111", contactId: "c1", appointmentId: "a1", paidCents: 20_000, marginBps: 6000 }, // sobra 120
  { campaignId: "111", contactId: "c2", appointmentId: "a2", paidCents: 15_000, marginBps: 4000 }, // sobra 60
];
const CONTATOS = [
  { campaignId: "111", contactId: "c1" },
  { campaignId: "111", contactId: "c2" },
  { campaignId: "222", contactId: "c3" },
];

describe("calcularSobraPorReal", () => {
  it("por campanha: gasto, receita, sobra e sobra por real", () => {
    const r = calcularSobraPorReal({ periodo: PERIODO, gastos: GASTOS, vendas: VENDAS, contatos: CONTATOS });
    const busca = r.campanhas.find((c) => c.campaignId === "111")!;
    expect(busca).toMatchObject({
      campaignName: "Busca",
      gastoCents: 8000,
      contatos: 2,
      vendas: 2,
      receitaCents: 35_000,
      sobraCents: 18_000,
      diasSemGasto: [],
      incompleto: false,
    });
    expect(busca.sobraPorReal).toBeCloseTo(2.25, 5); // 180 / 80
  });

  it("dia sem linha de gasto marca a campanha como incompleta", () => {
    const r = calcularSobraPorReal({ periodo: PERIODO, gastos: GASTOS, vendas: VENDAS, contatos: CONTATOS });
    const display = r.campanhas.find((c) => c.campaignId === "222")!;
    expect(display.diasSemGasto).toEqual(["2026-09-02"]);
    expect(display.incompleto).toBe(true);
    expect(display.contatos).toBe(1);
    expect(display.vendas).toBe(0);
    expect(display.sobraPorReal).toBe(0);
  });

  it("venda sem gasto no período: sobra por real nulo, nunca infinito", () => {
    const r = calcularSobraPorReal({
      periodo: PERIODO,
      gastos: [],
      vendas: [{ campaignId: "333", contactId: "c9", appointmentId: "a9", paidCents: 1000, marginBps: 5000 }],
      contatos: [{ campaignId: "333", contactId: "c9" }],
    });
    const c = r.campanhas.find((x) => x.campaignId === "333")!;
    expect(c.gastoCents).toBe(0);
    expect(c.sobraPorReal).toBeNull();
    expect(c.incompleto).toBe(true);
  });

  it("venda sem margem declarada fica fora da sobra e é contada à parte", () => {
    const r = calcularSobraPorReal({
      periodo: PERIODO,
      gastos: GASTOS,
      vendas: [...VENDAS, { campaignId: "111", contactId: "c2", appointmentId: "a3", paidCents: 9_000, marginBps: null }],
      contatos: CONTATOS,
    });
    const busca = r.campanhas.find((c) => c.campaignId === "111")!;
    expect(busca.sobraCents).toBe(18_000);
    expect(busca.receitaCents).toBe(44_000);
    expect(busca.vendasSemMargem).toBe(1);
  });

  it("o total soma só o que é comparável e diz se está incompleto", () => {
    const r = calcularSobraPorReal({ periodo: PERIODO, gastos: GASTOS, vendas: VENDAS, contatos: CONTATOS });
    expect(r.total).toMatchObject({ gastoCents: 10_000, sobraCents: 18_000, incompleto: true });
    expect(r.total.sobraPorReal).toBeCloseTo(1.8, 5);
  });
});

describe("microsDeCentavos — o inverso de centavosDeMicros, para a Fase 8 mandar orçamento ao Google", () => {
  it("1 centavo = 10.000 micros, e o par de conversões faz ida e volta", () => {
    expect(microsDeCentavos(1)).toBe(10_000);
    expect(microsDeCentavos(5_000)).toBe(50_000_000);
    expect(centavosDeMicros(microsDeCentavos(5_000))).toBe(5_000);
  });
});
