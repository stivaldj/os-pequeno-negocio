/**
 * Caixa (decisão 3 da Fase 6): o saldo vem do `LEDGERBAL` que o banco declarou,
 * não da soma da janela que o Dono importou. Conta sem saldo lido é INCOMPLETA,
 * nunca zero, e derruba o total inteiro para `null`.
 */
import { describe, expect, it } from "vitest";
import { calcularCaixa, type LinhaDeLancamento, type LinhaDeSaldo } from "@/lib/financeiro/caixa";

const CORRENTE = { bankId: "237", acctId: "00012345-6", kind: "bank" } as const;
const CARTAO = { bankId: "", acctId: "4111", kind: "credit_card" } as const;

/** O banco fechou 31/08 em R$ 1.000,00. */
const SALDO_CORRENTE: LinhaDeSaldo = { ...CORRENTE, tipo: "ledger", saldoEm: "2026-08-31", saldoCents: 100_000 };

const LANCAMENTOS: LinhaDeLancamento[] = [
  { ...CORRENTE, dia: "2026-08-31", valorCents: -5_000 }, // mesmo dia do saldo: já está dentro dele
  { ...CORRENTE, dia: "2026-09-01", valorCents: -20_000 },
  { ...CORRENTE, dia: "2026-09-02", valorCents: 35_000 },
];

describe("calcularCaixa", () => {
  it("soma ao saldo declarado só o que se moveu depois dele", () => {
    const r = calcularCaixa({ saldos: [SALDO_CORRENTE], lancamentos: LANCAMENTOS });
    expect(r.contas).toHaveLength(1);
    expect(r.contas[0]).toMatchObject({
      bankId: "237",
      acctId: "00012345-6",
      kind: "bank",
      saldoCents: 100_000,
      saldoEm: "2026-08-31",
      lancamentosDepois: 2,
      somaDepoisCents: 15_000,
      saldoEstimadoCents: 115_000,
      incompleto: false,
    });
    expect(r.totalCents).toBe(115_000);
    expect(r.incompleto).toBe(false);
  });

  it("lançamento no mesmo dia do as_of do saldo não é somado de novo", () => {
    const semOMesmoDia = LANCAMENTOS.filter((l) => l.dia !== "2026-08-31");
    const comOMesmoDia = calcularCaixa({ saldos: [SALDO_CORRENTE], lancamentos: LANCAMENTOS });
    const sem = calcularCaixa({ saldos: [SALDO_CORRENTE], lancamentos: semOMesmoDia });
    // A linha de 31/08 existe no extrato, mas o banco já a contou no LEDGERBAL:
    // somá-la aqui tiraria R$ 50,00 do caixa do Dono que não saíram.
    expect(comOMesmoDia.totalCents).toBe(sem.totalCents);
    expect(comOMesmoDia.contas[0]!.lancamentosDepois).toBe(2);
  });

  it("conta sem saldo lido fica incompleta e o total inteiro vira null", () => {
    const r = calcularCaixa({
      saldos: [SALDO_CORRENTE],
      lancamentos: [...LANCAMENTOS, { ...CARTAO, dia: "2026-09-01", valorCents: -7_000 }],
    });
    const cartao = r.contas.find((c) => c.kind === "credit_card")!;
    expect(cartao.saldoCents).toBeNull(); // nunca zero: zero seria uma afirmação
    expect(cartao.saldoEm).toBeNull();
    expect(cartao.saldoEstimadoCents).toBeNull();
    expect(cartao.lancamentosDepois).toBe(1);
    expect(cartao.somaDepoisCents).toBe(-7_000);
    expect(cartao.incompleto).toBe(true);

    const corrente = r.contas.find((c) => c.kind === "bank")!;
    expect(corrente.saldoEstimadoCents).toBe(115_000); // a conta boa continua sabida
    expect(r.totalCents).toBeNull(); // e mesmo assim o total se cala
    expect(r.incompleto).toBe(true);
  });

  it("com dois saldos da mesma conta, vale o de as_of mais recente", () => {
    const janeiro: LinhaDeSaldo = { ...CORRENTE, tipo: "ledger", saldoEm: "2026-01-31", saldoCents: 50_000 };
    const fevereiro: LinhaDeSaldo = { ...CORRENTE, tipo: "ledger", saldoEm: "2026-02-28", saldoCents: 90_000 };
    for (const saldos of [[janeiro, fevereiro], [fevereiro, janeiro]]) {
      const r = calcularCaixa({ saldos, lancamentos: [] });
      expect(r.contas[0]!.saldoEm).toBe("2026-02-28");
      expect(r.contas[0]!.saldoCents).toBe(90_000);
    }
  });

  it("empatada a data, o saldo ledger tem precedência sobre o available", () => {
    const ledger: LinhaDeSaldo = { ...CORRENTE, tipo: "ledger", saldoEm: "2026-08-31", saldoCents: 100_000 };
    const available: LinhaDeSaldo = { ...CORRENTE, tipo: "available", saldoEm: "2026-08-31", saldoCents: 98_000 };
    for (const saldos of [[ledger, available], [available, ledger]]) {
      expect(calcularCaixa({ saldos, lancamentos: [] }).contas[0]!.saldoCents).toBe(100_000);
    }
  });

  it("banco e cartão da mesma instituição são contas separadas, em ordem estável", () => {
    const r = calcularCaixa({
      saldos: [SALDO_CORRENTE, { ...CARTAO, tipo: "ledger", saldoEm: "2026-08-31", saldoCents: -42_000 }],
      lancamentos: [],
    });
    expect(r.contas.map((c) => `${c.bankId}|${c.acctId}`)).toEqual(["237|00012345-6", "|4111"]);
    expect(r.totalCents).toBe(58_000); // cartão negativo entra com o sinal dele
    expect(r.incompleto).toBe(false);
  });

  it("sem nada importado não há conta, nem total inventado", () => {
    expect(calcularCaixa({ saldos: [], lancamentos: [] })).toEqual({ contas: [], totalCents: 0, incompleto: false });
  });
});
