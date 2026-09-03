/**
 * Vencimentos: o que vence hoje, o que já venceu e o que vem em sete dias.
 * Só `open`; total separado por direção; `hoje` vem de fora, sempre.
 */
import { describe, expect, it } from "vitest";
import { somarDias, vencimentosDoDia, type Obrigacao } from "@/lib/financeiro/vencimentos";

const HOJE = "2026-09-02";

function obrigacao(over: Partial<Obrigacao> & { id: string }): Obrigacao {
  return {
    direction: "payable",
    description: "Aluguel",
    amountCents: 10_000,
    dueOn: HOJE,
    status: "open",
    ...over,
  };
}

const OBRIGACOES: Obrigacao[] = [
  obrigacao({ id: "a", dueOn: "2026-08-25", description: "Luz", amountCents: 31_000 }), // vencida
  obrigacao({ id: "b", dueOn: "2026-08-31", description: "Internet", amountCents: 12_000 }), // vencida
  obrigacao({ id: "c", dueOn: HOJE, description: "Aluguel", amountCents: 250_000 }),
  obrigacao({ id: "d", dueOn: HOJE, direction: "receivable", description: "Convênio", amountCents: 180_000 }),
  obrigacao({ id: "e", dueOn: "2026-09-09", description: "Fornecedor", amountCents: 40_000 }), // hoje + 7
  obrigacao({ id: "f", dueOn: "2026-09-10", description: "Contador", amountCents: 90_000 }), // hoje + 8
  obrigacao({ id: "g", dueOn: HOJE, status: "paid", description: "Já paga", amountCents: 99_900 }),
  obrigacao({ id: "h", dueOn: "2026-08-01", status: "cancelled", description: "Cancelada", amountCents: 77_700 }),
];

describe("vencimentosDoDia", () => {
  it("vence hoje: lista e total separados por direção", () => {
    const r = vencimentosDoDia(OBRIGACOES, HOJE);
    expect(r.hoje).toBe(HOJE);
    expect(r.vencemHoje.itens.map((o) => o.id)).toEqual(["c", "d"]);
    expect(r.vencemHoje.totalCents).toEqual({ payable: 250_000, receivable: 180_000 });
  });

  it("vencidas: só o que ficou para trás, mais velha primeiro", () => {
    const r = vencimentosDoDia(OBRIGACOES, HOJE);
    expect(r.vencidas.itens.map((o) => o.id)).toEqual(["a", "b"]);
    expect(r.vencidas.totalCents).toEqual({ payable: 43_000, receivable: 0 });
  });

  it("próximos 7: a borda do sétimo dia entra, o oitavo não, e hoje não repete", () => {
    const r = vencimentosDoDia(OBRIGACOES, HOJE);
    expect(r.proximos7.itens.map((o) => o.id)).toEqual(["e"]);
    expect(r.proximos7.totalCents).toEqual({ payable: 40_000, receivable: 0 });
  });

  it("pago e cancelado não vencem", () => {
    const r = vencimentosDoDia(OBRIGACOES, HOJE);
    const todos = [...r.vencemHoje.itens, ...r.vencidas.itens, ...r.proximos7.itens].map((o) => o.id);
    expect(todos).not.toContain("g");
    expect(todos).not.toContain("h");
  });

  it("dia sem nada devolve grupos vazios com total zero, não erro", () => {
    const r = vencimentosDoDia([], "2026-12-25");
    expect(r.vencemHoje).toEqual({ itens: [], totalCents: { payable: 0, receivable: 0 } });
    expect(r.vencidas.itens).toEqual([]);
    expect(r.proximos7.itens).toEqual([]);
  });

  it("o mesmo conjunto lido no dia seguinte muda de grupo — quem manda é o `hoje` de fora", () => {
    const r = vencimentosDoDia(OBRIGACOES, "2026-09-03");
    expect(r.vencidas.itens.map((o) => o.id)).toEqual(["a", "b", "c", "d"]);
    expect(r.vencemHoje.itens).toEqual([]);
    expect(r.proximos7.itens.map((o) => o.id)).toEqual(["e", "f"]);
  });
});

describe("somarDias", () => {
  it("atravessa mês e ano sem depender de `agora`", () => {
    expect(somarDias("2026-09-02", 7)).toBe("2026-09-09");
    expect(somarDias("2026-08-31", 7)).toBe("2026-09-07");
    expect(somarDias("2026-12-28", 7)).toBe("2027-01-04");
    expect(somarDias("2028-02-25", 7)).toBe("2028-03-03"); // ano bissexto
  });
});
