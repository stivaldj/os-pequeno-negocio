import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { formatCentsBRL } from "@/lib/money";

/**
 * O lembrete de vencimento — o Dono sabe de manhã o que vence hoje.
 *
 * O dublê daqui é o ponto do arquivo, não um detalhe: ele aplica os filtros do
 * PostgREST com a semântica REAL de `NULL`. Em SQL, `NULL <> '2026-09-02'` é
 * `NULL` e o `WHERE` descarta a linha — então uma implementação que usasse só
 * `.neq(...)` nunca acharia a obrigação recém-cadastrada, e a falha seria muda
 * (200, `job_runs` `ok`, ninguém avisado). Aqui esse caminho REPROVA, e é o que
 * o caso "obrigação nunca lembrada entra na primeira rodada" mede.
 */

const HOJE = "2026-09-02";
const ONTEM = "2026-09-01";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";

interface Linha {
  id: string;
  organization_id: string;
  direction: "payable" | "receivable";
  description: string;
  amount_cents: number;
  due_on: string;
  status: "open" | "paid" | "cancelled";
  reminder_sent_on: string | null;
}

interface Filtro {
  tipo: string;
  args: unknown[];
}

interface Op {
  tabela: string;
  op: string;
  payload?: Record<string, unknown>;
  filtros: Filtro[];
}

let obrigacoes: Linha[];
let ops: Op[];
let erroDeUpdate: string | null;
const auditados: Record<string, unknown>[] = [];
const enviados: { organizationId: string; texto: string }[] = [];
let envioFalha: string | null;

vi.mock("@/lib/audit", () => ({
  audit: async (entrada: Record<string, unknown>) => {
    auditados.push(entrada);
  },
}));

// O destinatário "dono" é módulo próprio (`lib/dono/`), com o dublê dele lá.
// Aqui só se prova que este cron o CHAMA e respeita o `{ ok: false }`.
vi.mock("@/lib/dono/destinatario", () => ({
  enviarAoDono: async (_admin: unknown, organizationId: string, texto: string) => {
    if (envioFalha) return { ok: false as const, motivo: envioFalha };
    enviados.push({ organizationId, texto });
    return { ok: true as const };
  },
}));

/**
 * `reminder_sent_on.is.null,reminder_sent_on.neq.2026-09-02` — a forma exata que
 * o PostgREST recebe. `neq` sobre `NULL` NÃO casa, como no Postgres.
 */
function avaliarOr(linha: Linha, expr: string): boolean {
  return expr.split(",").some((termo) => {
    const [coluna = "", op = "", ...resto] = termo.split(".");
    const valor = resto.join(".");
    const atual = (linha as unknown as Record<string, unknown>)[coluna] ?? null;
    if (op === "is") return valor === "null" ? atual === null : String(atual) === valor;
    if (op === "neq") return atual !== null && String(atual) !== valor;
    if (op === "eq") return atual !== null && String(atual) === valor;
    throw new Error(`operador que este dublê não sabe ler: "${op}"`);
  });
}

function passa(linha: Linha, f: Filtro): boolean {
  const [a, b] = f.args as [string, unknown];
  const atual = (linha as unknown as Record<string, unknown>)[a] ?? null;
  switch (f.tipo) {
    case "eq":
      return atual === b;
    case "neq":
      return atual !== null && atual !== b;
    case "lte":
      return atual !== null && String(atual) <= String(b);
    case "gte":
      return atual !== null && String(atual) >= String(b);
    case "in":
      return (b as unknown[]).includes(atual);
    case "is":
      return b === null ? atual === null : atual === b;
    case "or":
      return avaliarOr(linha, String(a));
    default:
      throw new Error(`filtro que este dublê não sabe ler: "${f.tipo}"`);
  }
}

/** Dublê do PostgREST, no molde do de `lib/clinica/vigia.test.ts`. */
function adminFalso(): SupabaseClient {
  const cadeiaDe = (tabela: string, op: string, payload?: Record<string, unknown>) => {
    const registro: Op = { tabela, op, payload, filtros: [] };
    ops.push(registro);
    let ordem: string | null = null;

    const alvo = (): Linha[] => {
      if (tabela !== "financial_obligations") return [];
      const achadas = obrigacoes.filter((l) => registro.filtros.every((f) => passa(l, f)));
      return ordem ? [...achadas].sort((x, y) => String(x[ordem as keyof Linha]).localeCompare(String(y[ordem as keyof Linha]))) : achadas;
    };

    const resolver = (): { data: unknown; error: { message: string } | null } => {
      if (op === "update") {
        if (erroDeUpdate) return { data: null, error: { message: erroDeUpdate } };
        for (const linha of alvo()) Object.assign(linha, payload);
        return { data: null, error: null };
      }
      return { data: alvo().map((l) => ({ ...l })), error: null };
    };

    const cadeia: Record<string, unknown> = {};
    for (const metodo of ["eq", "neq", "lte", "gte", "in", "is", "or"]) {
      cadeia[metodo] = (...args: unknown[]) => {
        registro.filtros.push({ tipo: metodo, args });
        return cadeia;
      };
    }
    cadeia.order = (coluna: string) => {
      ordem = coluna;
      return cadeia;
    };
    cadeia.limit = () => cadeia;
    cadeia.then = (ok: (v: unknown) => unknown) => ok(resolver());
    return cadeia;
  };

  return {
    from: (tabela: string) => ({
      select: () => cadeiaDe(tabela, "select"),
      update: (payload: Record<string, unknown>) => cadeiaDe(tabela, "update", payload),
    }),
  } as unknown as SupabaseClient;
}

function conta(id: string, extra: Partial<Linha> = {}): Linha {
  return {
    id,
    organization_id: ORG,
    direction: "payable",
    description: `Conta ${id}`,
    amount_cents: 10_000,
    due_on: HOJE,
    status: "open",
    reminder_sent_on: null,
    ...extra,
  };
}

const { enviarLembretesDeVencimento, textoDoLembrete, diaCorrenteUtc } = await import("./lembretes");
const { vencimentosDoDia } = await import("./vencimentos");

beforeEach(() => {
  obrigacoes = [];
  ops = [];
  erroDeUpdate = null;
  envioFalha = null;
  auditados.length = 0;
  enviados.length = 0;
});

describe("enviarLembretesDeVencimento", () => {
  it("obrigação nunca lembrada entra na primeira rodada", async () => {
    // ⚠️ O caso que a cláusula `is null` existe para cobrir. `reminder_sent_on`
    // nasce nulo; um recorte só com `<> hoje` devolveria ZERO aqui, com 200 na
    // rota e `job_runs` verde — o Dono nunca saberia que a conta venceu.
    obrigacoes = [conta("a", { reminder_sent_on: null, amount_cents: 100_000, description: "Aluguel" })];

    const r = await enviarLembretesDeVencimento(adminFalso(), { hoje: HOJE });

    expect(r.contas).toBe(1);
    expect(r.obrigacoes).toBe(1);
    expect(r.enviados).toBe(1);
    expect(r.pulados).toEqual([]);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]?.organizationId).toBe(ORG);
    expect(enviados[0]?.texto).toContain("Aluguel");
    expect(enviados[0]?.texto).toContain(formatCentsBRL(100_000));
    // E a marca fica no dia de hoje, para a segunda rodada não repetir.
    expect(obrigacoes[0]?.reminder_sent_on).toBe(HOJE);
  });

  it("a consulta pede `is null` OU `<> hoje` — nunca só `<> hoje`", () => {
    // A forma literal importa: é o contrato com o PostgREST, e trocá-la por
    // `.neq(...)` sozinho reabre exatamente o defeito acima.
    void enviarLembretesDeVencimento(adminFalso(), { hoje: HOJE });
    const consulta = ops.find((o) => o.tabela === "financial_obligations" && o.op === "select");
    const ors = consulta?.filtros.filter((f) => f.tipo === "or") ?? [];
    expect(ors).toHaveLength(1);
    expect(ors[0]?.args[0]).toBe(`reminder_sent_on.is.null,reminder_sent_on.neq.${HOJE}`);
  });

  it("obrigação já lembrada HOJE não entra de novo; a lembrada ontem entra", async () => {
    obrigacoes = [
      conta("hoje-ja", { reminder_sent_on: HOJE }),
      conta("ontem", { reminder_sent_on: ONTEM, description: "Luz" }),
    ];

    const r = await enviarLembretesDeVencimento(adminFalso(), { hoje: HOJE });

    expect(r.obrigacoes).toBe(1);
    expect(enviados[0]?.texto).toContain("Luz");
    expect(enviados[0]?.texto).not.toContain("hoje-ja");
  });

  it("rodada sem vencimento não envia, não marca e NÃO audita", async () => {
    obrigacoes = [
      conta("paga", { status: "paid" }),
      conta("cancelada", { status: "cancelled" }),
      conta("semana-que-vem", { due_on: "2026-09-09" }),
    ];

    const r = await enviarLembretesDeVencimento(adminFalso(), { hoje: HOJE });

    expect(r).toMatchObject({ contas: 0, obrigacoes: 0, enviados: 0 });
    expect(enviados).toEqual([]);
    expect(auditados).toEqual([]);
    expect(obrigacoes.every((o) => o.reminder_sent_on === null)).toBe(true);
  });

  it("falha de envio NÃO marca — a rodada de amanhã tenta de novo", async () => {
    obrigacoes = [conta("a")];
    envioFalha = "sem_canal";

    const r = await enviarLembretesDeVencimento(adminFalso(), { hoje: HOJE });

    expect(r.enviados).toBe(0);
    expect(r.pulados).toEqual([{ organizationId: ORG, motivo: "sem_canal" }]);
    expect(obrigacoes[0]?.reminder_sent_on).toBeNull();
    expect(auditados).toEqual([]);
  });

  it("envio que deu certo audita `financeiro.lembrete_enviado` por Conta", async () => {
    obrigacoes = [
      conta("a", { amount_cents: 30_000 }),
      conta("b", { direction: "receivable", amount_cents: 5_000, due_on: ONTEM }),
    ];

    await enviarLembretesDeVencimento(adminFalso(), { hoje: HOJE });

    expect(auditados).toHaveLength(1);
    expect(auditados[0]).toMatchObject({
      action: "financeiro.lembrete_enviado",
      organizationId: ORG,
      resourceType: "organization",
      resourceId: ORG,
      bypassedRls: true,
      metadata: {
        hoje: HOJE,
        vencem_hoje: 1,
        vencidas: 1,
        total_a_pagar_cents: 30_000,
        total_a_receber_cents: 5_000,
      },
    });
  });

  it("dryRun devolve os candidatos sem enviar, sem marcar e sem auditar", async () => {
    obrigacoes = [conta("a", { description: "Aluguel" })];

    const r = await enviarLembretesDeVencimento(adminFalso(), { hoje: HOJE, dryRun: true });

    expect(r.contas).toBe(1);
    expect(r.enviados).toBe(0);
    expect(r.candidatos).toHaveLength(1);
    expect(r.candidatos[0]?.texto).toContain("Aluguel");
    expect(enviados).toEqual([]);
    expect(auditados).toEqual([]);
    expect(obrigacoes[0]?.reminder_sent_on).toBeNull();
    expect(ops.some((o) => o.op === "update")).toBe(false);
  });

  it("cada Conta recebe UM texto, só com as obrigações dela", async () => {
    obrigacoes = [
      conta("a", { description: "Aluguel" }),
      conta("b", { description: "Internet" }),
      conta("c", { organization_id: OUTRA, description: "Contador" }),
    ];

    const r = await enviarLembretesDeVencimento(adminFalso(), { hoje: HOJE });

    expect(r.contas).toBe(2);
    expect(r.enviados).toBe(2);
    expect(enviados).toHaveLength(2);
    const daOrg = enviados.find((e) => e.organizationId === ORG)?.texto ?? "";
    const daOutra = enviados.find((e) => e.organizationId === OUTRA)?.texto ?? "";
    expect(daOrg).toContain("Aluguel");
    expect(daOrg).toContain("Internet");
    expect(daOrg).not.toContain("Contador");
    expect(daOutra).toContain("Contador");
    expect(daOutra).not.toContain("Aluguel");
  });

  it("a marca é filtrada por Conta e pelos ids lidos (service role sem RLS)", async () => {
    obrigacoes = [conta("a"), conta("b"), conta("c", { organization_id: OUTRA })];

    await enviarLembretesDeVencimento(adminFalso(), { hoje: HOJE });

    const marcas = ops.filter((o) => o.op === "update");
    expect(marcas).toHaveLength(2);
    expect(marcas[0]?.payload).toEqual({ reminder_sent_on: HOJE });
    expect(marcas[0]?.filtros).toEqual([
      { tipo: "eq", args: ["organization_id", ORG] },
      { tipo: "in", args: ["id", ["a", "b"]] },
    ]);
  });

  it("erro ao marcar não derruba a rodada das outras Contas", async () => {
    obrigacoes = [conta("a"), conta("c", { organization_id: OUTRA })];
    erroDeUpdate = "deadlock detected";

    const r = await enviarLembretesDeVencimento(adminFalso(), { hoje: HOJE });

    expect(r.enviados).toBe(2);
    expect(r.pulados.map((p) => p.organizationId).sort()).toEqual([ORG, OUTRA].sort());
    expect(r.pulados.every((p) => p.motivo.startsWith("marca_falhou:"))).toBe(true);
    expect(auditados).toHaveLength(2);
  });
});

describe("textoDoLembrete", () => {
  const de = (itens: Partial<Linha>[]) =>
    vencimentosDoDia(
      itens.map((i, n) => {
        const l = conta(`x${n}`, i);
        return {
          id: l.id,
          direction: l.direction,
          description: l.description,
          amountCents: l.amount_cents,
          dueOn: l.due_on,
          status: l.status,
        };
      }),
      HOJE,
    );

  it("separa a pagar de a receber — nunca soma as duas direções num número só", () => {
    const texto = textoDoLembrete(
      de([
        { description: "Aluguel", amount_cents: 100_000 },
        { description: "Convênio", amount_cents: 40_000, direction: "receivable" },
      ]),
    );
    expect(texto.split("\n")[0]).toBe(
      `2 contas vencem hoje: ${formatCentsBRL(100_000)} a pagar e ${formatCentsBRL(40_000)} a receber.`,
    );
  });

  it("no singular a frase concorda", () => {
    const texto = textoDoLembrete(de([{ description: "Aluguel", amount_cents: 100_000 }]));
    expect(texto.split("\n")[0]).toBe(`1 conta vence hoje: ${formatCentsBRL(100_000)} a pagar.`);
  });

  it("no máximo cinco itens, e o resto vira 'E mais N'", () => {
    const texto = textoDoLembrete(de(Array.from({ length: 7 }, (_, n) => ({ description: `Conta ${n}` }))));
    const itens = texto.split("\n").filter((l) => l.startsWith("- "));
    expect(itens).toHaveLength(5);
    expect(texto.endsWith("E mais 2.")).toBe(true);
  });

  it("o que já venceu tem linha própria e diz o dia; hoje vem antes", () => {
    const texto = textoDoLembrete(
      de([
        { description: "Aluguel", amount_cents: 100_000 },
        { description: "Luz", amount_cents: 20_000, due_on: "2026-08-30" },
      ]),
    );
    const linhas = texto.split("\n");
    expect(linhas[0]).toContain("vence hoje");
    expect(linhas[1]).toBe(`1 conta já venceu: ${formatCentsBRL(20_000)} a pagar.`);
    expect(linhas[2]).toBe(`- Aluguel: ${formatCentsBRL(100_000)} a pagar, hoje`);
    expect(linhas[3]).toBe(`- Luz: ${formatCentsBRL(20_000)} a pagar, venceu em 30/08`);
  });

  it("conta atrasada de outro ano carrega o ano", () => {
    const texto = textoDoLembrete(de([{ description: "IPTU", amount_cents: 50_000, due_on: "2025-12-10" }]));
    expect(texto).toContain("venceu em 10/12/2025");
  });

  it("não dá instrução de operador nem inventa nada sobre paciente", () => {
    const texto = textoDoLembrete(de([{ description: "Aluguel", amount_cents: 100_000 }]));
    for (const proibida of ["docker", "INTERNAL_SECRET", "logs", "servidor"]) {
      expect(texto.toLowerCase()).not.toContain(proibida.toLowerCase());
    }
  });
});

describe("diaCorrenteUtc", () => {
  it("devolve o dia civil em UTC, `YYYY-MM-DD`", () => {
    expect(diaCorrenteUtc(new Date("2026-09-02T07:20:00.000Z"))).toBe(HOJE);
  });
});
