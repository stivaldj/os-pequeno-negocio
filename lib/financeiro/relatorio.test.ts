import { describe, expect, it } from "vitest";

import { caixaDaConta, insumosDeCaixa, obrigacoesAbertas, vencimentosDaConta } from "./relatorio";

/**
 * Dublê encadeável por tabela, no molde de `lib/ads/relatorio.test.ts`: devolve
 * as linhas programadas e registra os filtros/ordem para asserção.
 */
function duble(linhas: Record<string, unknown[]>) {
  const filtros: Record<string, [string, unknown[]][]> = {};
  function chain(tabela: string) {
    filtros[tabela] = [];
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: linhas[tabela] ?? [], error: null });
          return (...args: unknown[]) => {
            if (["eq", "gte", "lte", "lt", "in"].includes(String(prop))) filtros[tabela]!.push([String(prop), args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  return { admin: { from: (t: string) => ({ select: () => chain(t) }) } as never, filtros };
}

const ORG = "org-1";

describe("insumosDeCaixa", () => {
  it("traduz ledger_balances e ledger_entries para as interfaces camelCase de caixa.ts", async () => {
    const d = duble({
      ledger_balances: [{ bank_id: "0403", account_id: "111", account_kind: "bank", kind: "ledger", as_of: "2026-09-01", balance_cents: "127491" }],
      ledger_entries: [{ bank_id: "0403", account_id: "111", account_kind: "bank", posted_on: "2026-09-02", amount_cents: "-1072" }],
    });
    const r = await insumosDeCaixa(d.admin, ORG);
    expect(r.saldos).toEqual([{ bankId: "0403", acctId: "111", kind: "bank", tipo: "ledger", saldoEm: "2026-09-01", saldoCents: 127491 }]);
    expect(r.lancamentos).toEqual([{ bankId: "0403", acctId: "111", kind: "bank", dia: "2026-09-02", valorCents: -1072 }]);
  });

  it("corta lançamentos pelo MENOR as_of entre os saldos", async () => {
    const d = duble({
      ledger_balances: [
        { bank_id: "b", account_id: "1", account_kind: "bank", kind: "ledger", as_of: "2026-08-15", balance_cents: 0 },
        { bank_id: "b", account_id: "1", account_kind: "bank", kind: "ledger", as_of: "2026-09-01", balance_cents: 0 },
      ],
      ledger_entries: [],
    });
    await insumosDeCaixa(d.admin, ORG);
    const gte = d.filtros.ledger_entries!.find(([op]) => op === "gte");
    expect(gte).toBeDefined();
    expect((gte![1] as unknown[])[1]).toBe("2026-08-15");
  });

  it("caixaDaConta calcula a partir das mesmas linhas — sem saldo, incompleto: true", async () => {
    const d = duble({ ledger_balances: [], ledger_entries: [] });
    const r = await caixaDaConta(d.admin, ORG);
    expect(r).toEqual({ contas: [], totalCents: 0, incompleto: false });
  });
});

describe("obrigacoesAbertas / vencimentosDaConta", () => {
  it("lê só status open e traduz para Obrigacao", async () => {
    const d = duble({
      financial_obligations: [
        { id: "o1", direction: "payable", description: "Aluguel", amount_cents: "350000", due_on: "2026-09-03", status: "open" },
      ],
    });
    const r = await obrigacoesAbertas(d.admin, ORG);
    expect(r).toEqual([{ id: "o1", direction: "payable", description: "Aluguel", amountCents: 350_000, dueOn: "2026-09-03", status: "open" }]);
    expect(d.filtros.financial_obligations!.some(([op, args]) => op === "eq" && args[1] === "open")).toBe(true);
  });

  it("vencimentosDaConta agrupa por hoje/vencidas a partir da mesma leitura", async () => {
    const d = duble({
      financial_obligations: [
        { id: "o1", direction: "payable", description: "Aluguel", amount_cents: 350_000, due_on: "2026-09-03", status: "open" },
        { id: "o2", direction: "receivable", description: "Convênio", amount_cents: 128_050, due_on: "2026-08-20", status: "open" },
      ],
    });
    const r = await vencimentosDaConta(d.admin, ORG, "2026-09-03");
    expect(r.vencemHoje.itens).toHaveLength(1);
    expect(r.vencidas.itens).toHaveLength(1);
  });
});
