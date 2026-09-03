/**
 * A API do Financeiro (`/api/v1/financeiro/{categorias,obrigacoes,caixa}`) —
 * Fase 6, Tarefa 6.
 *
 * O que se prova aqui, e por que cada coisa:
 *
 *   • O gate para em `requireRole` ANTES do banco, e a recusa dele volta como
 *     resposta. Escrita é `manager` (é dinheiro), leitura é `viewer` — os dois
 *     papéis são afirmados por nome, porque trocar um pelo outro é a classe de
 *     erro que nenhum teste de caminho feliz pega.
 *   • O `organization_id` vem de `authz.org.orgId` e o body pode mandar outro:
 *     ele é IGNORADO. É a regra do service role (bypassa RLS, filtra à mão) e
 *     vale para as três mutações.
 *   • O Zod repete OS MESMOS LIMITES DOS CHECK da migration 0209 — um teste por
 *     limite. Sem isso o Dono veria 500 "algo deu errado" onde cabia uma frase
 *     que ensina: `slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'`, `kind in
 *     ('income','expense')`, `direction in ('payable','receivable')`,
 *     `length(description) between 1 and 200`, `amount_cents > 0`,
 *     `currency char(3)`, `status in ('open','paid','cancelled')`.
 *   • A BAIXA (`status: "paid"`) exige `paid_on` no mesmo corpo. A constraint
 *     `financial_obligations_baixa_coerente` recusaria de qualquer jeito — como
 *     erro do Postgres, que chega como 500. O Zod recusa antes, com 422.
 *   • Toda mutação audita, com as ações já declaradas na Tarefa 2
 *     (`financeiro.categoria_salva`, `financeiro.obrigacao_criada`,
 *     `financeiro.obrigacao_alterada`) e com a org e o ator do gate.
 *   • `GET /caixa` NÃO recalcula nada: traduz as linhas do Postgres para as
 *     interfaces camelCase e delega a `calcularCaixa` e `vencimentosDoDia`, que
 *     entram aqui de verdade (não mockados) — é o que prova a tradução, e em
 *     especial a troca de nomes que engana: `account_kind` vira `kind`, e a
 *     coluna `kind` do saldo (`ledger`/`available`) vira `tipo`.
 *   • O `hoje` do caixa sai do fuso da organização, não do relógio do servidor,
 *     e degrada para `America/Sao_Paulo` quando a coluna traz lixo — a coluna
 *     não tem CHECK e nenhum escritor a valida.
 *
 * Molde: `tests/unit/ads-api.test.ts` (mock de require-role, audit e do admin
 * client).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));

interface Chamada {
  tabela: string;
  op: string;
  payload?: unknown;
  opts?: unknown;
  filtros: [string, unknown[]][];
}
const chamadas: Chamada[] = [];
/** O que cada tabela devolve na próxima leitura (lista) — `single` pega o primeiro. */
const linhas: Record<string, unknown[]> = {};

function cadeia(chamada: Chamada): unknown {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "maybeSingle" || prop === "single") {
          return async () => ({ data: (linhas[chamada.tabela] ?? [])[0] ?? null, error: null });
        }
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown) => resolve({ data: linhas[chamada.tabela] ?? [], error: null });
        }
        return (...args: unknown[]) => {
          chamada.filtros.push([prop, args]);
          return proxy;
        };
      },
    },
  );
  return proxy;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const comeca = (op: string) => (payload?: unknown, opts?: unknown) => {
        const chamada: Chamada = { tabela, op, payload, opts, filtros: [] };
        chamadas.push(chamada);
        return cadeia(chamada);
      };
      return { select: comeca("select"), insert: comeca("insert"), update: comeca("update"), upsert: comeca("upsert") };
    },
  }),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const ANA = "11111111-1111-4111-8111-111111111111";
const OBRIGACAO = "44444444-4444-4444-8444-444444444444";
const usuario: AuthUser = {
  id: ANA,
  email: "ana@clinica.com.br",
  full_name: "Ana",
  avatar_url: null,
  is_platform_admin: false,
  idioma: "pt-BR" as const,
  organizations: [{ organization_id: ORG, organization_name: "Clínica", role: "manager" }],
};
const orgAtiva: ActiveOrg = { orgId: ORG, name: "Clínica", role: "manager" };

function pedido(caminho: string, metodo: "GET" | "POST" | "PUT" | "PATCH", body?: unknown): NextRequest {
  return new NextRequest(`https://crm.exemplo/api/v1/financeiro/${caminho}`, {
    method: metodo,
    headers: { "content-type": "application/json", "x-request-id": "req-fin" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** O `ctx` que o Next entrega a uma rota `[id]`: os parâmetros são uma Promise. */
const contexto = (id: string) => ({ params: Promise.resolve({ id }) });

const filtroDeOrg = (c: Chamada) => c.filtros.find(([m, a]) => m === "eq" && a[0] === "organization_id")?.[1][1];

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: orgAtiva });
  vi.mocked(audit).mockClear();
  chamadas.length = 0;
  for (const k of Object.keys(linhas)) delete linhas[k];
});

describe("o gate vem antes do banco, com o papel certo em cada verbo", () => {
  it("a recusa do requireRole volta como resposta, sem tocar o banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden_role", "não", 403) });
    const categorias = await import("@/app/api/v1/financeiro/categorias/route");
    const obrigacoes = await import("@/app/api/v1/financeiro/obrigacoes/route");
    const obrigacao = await import("@/app/api/v1/financeiro/obrigacoes/[id]/route");
    const caixa = await import("@/app/api/v1/financeiro/caixa/route");
    const respostas = await Promise.all([
      categorias.GET(pedido("categorias", "GET")),
      categorias.PUT(pedido("categorias", "PUT", { slug: "aluguel", name: "Aluguel", kind: "expense" })),
      obrigacoes.GET(pedido("obrigacoes", "GET")),
      obrigacoes.POST(pedido("obrigacoes", "POST", {})),
      obrigacao.PATCH(pedido(`obrigacoes/${OBRIGACAO}`, "PATCH", {}), contexto(OBRIGACAO)),
      caixa.GET(pedido("caixa", "GET")),
    ]);
    for (const r of respostas) expect(r.status).toBe(403);
    expect(chamadas).toHaveLength(0);
  });

  it("escrita pede manager e leitura pede viewer — os dois por nome", async () => {
    const categorias = await import("@/app/api/v1/financeiro/categorias/route");
    const obrigacoes = await import("@/app/api/v1/financeiro/obrigacoes/route");
    const obrigacao = await import("@/app/api/v1/financeiro/obrigacoes/[id]/route");
    const caixa = await import("@/app/api/v1/financeiro/caixa/route");

    for (const chamar of [
      () => categorias.GET(pedido("categorias", "GET")),
      () => obrigacoes.GET(pedido("obrigacoes", "GET")),
      () => caixa.GET(pedido("caixa", "GET")),
    ]) {
      vi.mocked(requireRole).mockClear();
      await chamar();
      expect(vi.mocked(requireRole)).toHaveBeenCalledWith("viewer", expect.objectContaining({ requestId: "req-fin" }));
    }

    linhas.ledger_categories = [{ id: "cat-1" }];
    linhas.financial_obligations = [{ id: OBRIGACAO, status: "open" }];
    for (const chamar of [
      () => categorias.PUT(pedido("categorias", "PUT", { slug: "aluguel", name: "Aluguel", kind: "expense" })),
      () => obrigacoes.POST(pedido("obrigacoes", "POST", { direction: "payable", description: "Aluguel", amount_cents: 250000, due_on: "2026-09-10" })),
      () => obrigacao.PATCH(pedido(`obrigacoes/${OBRIGACAO}`, "PATCH", { description: "Aluguel da sala" }), contexto(OBRIGACAO)),
    ]) {
      vi.mocked(requireRole).mockClear();
      await chamar();
      expect(vi.mocked(requireRole)).toHaveBeenCalledWith("manager", expect.objectContaining({ requestId: "req-fin" }));
    }
  });
});

describe("GET/PUT /api/v1/financeiro/categorias", () => {
  it("GET lista as categorias da org — filtrando a org à mão", async () => {
    linhas.ledger_categories = [{ id: "cat-1", slug: "aluguel", name: "Aluguel", kind: "expense", match_terms: ["ALUGUEL"] }];
    const { GET } = await import("@/app/api/v1/financeiro/categorias/route");
    const json = await (await GET(pedido("categorias", "GET"))).json();
    expect(filtroDeOrg(chamadas[0]!)).toBe(ORG);
    expect(json.data[0]).toMatchObject({ slug: "aluguel", kind: "expense" });
  });

  it("Zod recusa slug fora do CHECK, nome vazio, kind de fora do vocabulário e termo vazio", async () => {
    const { PUT } = await import("@/app/api/v1/financeiro/categorias/route");
    const bases = { slug: "aluguel", name: "Aluguel", kind: "expense" as const };
    const corpos = [
      { ...bases, slug: "Aluguel Fixo" },
      { ...bases, slug: "a" },
      { ...bases, name: "   " },
      { ...bases, kind: "despesa" },
      { ...bases, match_terms: ["ALUGUEL", "  "] },
    ];
    for (const corpo of corpos) {
      const res = await PUT(pedido("categorias", "PUT", corpo));
      expect(res.status).toBe(422);
    }
    expect(chamadas).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("PUT faz upsert por (organization_id, slug) com a org do gate, ignora organization_id do body e audita", async () => {
    linhas.ledger_categories = [{ id: "cat-9", slug: "aluguel", name: "Aluguel", kind: "expense", match_terms: ["ALUGUEL"] }];
    const { PUT } = await import("@/app/api/v1/financeiro/categorias/route");
    const res = await PUT(
      pedido("categorias", "PUT", {
        slug: "aluguel",
        name: "Aluguel",
        kind: "expense",
        match_terms: ["ALUGUEL"],
        organization_id: OUTRA_ORG,
      }),
    );
    expect(res.status).toBe(200);
    const upsert = chamadas.find((c) => c.op === "upsert" && c.tabela === "ledger_categories")!;
    expect(upsert.payload).toMatchObject({ organization_id: ORG, slug: "aluguel", name: "Aluguel", kind: "expense", match_terms: ["ALUGUEL"] });
    expect(JSON.stringify(upsert.payload)).not.toContain(OUTRA_ORG);
    expect(upsert.opts).toMatchObject({ onConflict: "organization_id,slug" });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "financeiro.categoria_salva",
        organizationId: ORG,
        actorUserId: ANA,
        resourceType: "ledger_categories",
        resourceId: "cat-9",
      }),
    );
  });
});

describe("GET/POST /api/v1/financeiro/obrigacoes", () => {
  it("GET lista as abertas da org por padrão, ordenadas pelo vencimento", async () => {
    linhas.financial_obligations = [{ id: OBRIGACAO, direction: "payable", description: "Aluguel", amount_cents: 250000, due_on: "2026-09-10", status: "open" }];
    const { GET } = await import("@/app/api/v1/financeiro/obrigacoes/route");
    const json = await (await GET(pedido("obrigacoes", "GET"))).json();
    const sel = chamadas[0]!;
    expect(filtroDeOrg(sel)).toBe(ORG);
    expect(sel.filtros).toContainEqual(["eq", ["status", "open"]]);
    expect(sel.filtros).toContainEqual(["order", ["due_on", { ascending: true }]]);
    expect(json.data[0]).toMatchObject({ direction: "payable", status: "open" });
  });

  it("GET com status=todas não filtra status, e direction entra como filtro", async () => {
    const { GET } = await import("@/app/api/v1/financeiro/obrigacoes/route");
    await GET(pedido("obrigacoes?status=todas&direction=receivable", "GET"));
    const sel = chamadas[0]!;
    expect(sel.filtros.some(([m, a]) => m === "eq" && a[0] === "status")).toBe(false);
    expect(sel.filtros).toContainEqual(["eq", ["direction", "receivable"]]);
  });

  it("GET com filtro fora do vocabulário é 422, e não vai ao banco", async () => {
    const { GET } = await import("@/app/api/v1/financeiro/obrigacoes/route");
    expect((await GET(pedido("obrigacoes?status=pago", "GET"))).status).toBe(422);
    expect((await GET(pedido("obrigacoes?limit=0", "GET"))).status).toBe(422);
    expect(chamadas).toHaveLength(0);
  });

  it("Zod recusa cada limite do CHECK: direction, descrição, valor não positivo, data e moeda", async () => {
    const { POST } = await import("@/app/api/v1/financeiro/obrigacoes/route");
    const base = { direction: "payable" as const, description: "Aluguel", amount_cents: 250000, due_on: "2026-09-10" };
    const corpos: Record<string, unknown>[] = [
      { ...base, direction: "pagar" },
      { ...base, description: "" },
      { ...base, description: "x".repeat(201) },
      { ...base, amount_cents: 0 },
      { ...base, amount_cents: -250000 },
      { ...base, amount_cents: 250000.5 },
      { ...base, due_on: "10/09/2026" },
      { ...base, due_on: "2026-02-31" },
      { ...base, currency: "REAL" },
      { ...base, category_id: "cat-1" },
    ];
    for (const corpo of corpos) {
      const res = await POST(pedido("obrigacoes", "POST", corpo));
      expect(res.status, JSON.stringify(corpo)).toBe(422);
    }
    expect(chamadas).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("POST cadastra com a org do gate, ignora organization_id do body, devolve 201 e audita", async () => {
    linhas.financial_obligations = [{ id: OBRIGACAO, direction: "payable", description: "Aluguel", amount_cents: 250000, currency: "BRL", due_on: "2026-09-10", status: "open" }];
    const { POST } = await import("@/app/api/v1/financeiro/obrigacoes/route");
    const res = await POST(
      pedido("obrigacoes", "POST", {
        direction: "payable",
        description: "Aluguel",
        amount_cents: 250000,
        due_on: "2026-09-10",
        organization_id: OUTRA_ORG,
        status: "paid",
      }),
    );
    expect(res.status).toBe(201);
    const insert = chamadas.find((c) => c.op === "insert")!;
    const payload = insert.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ organization_id: ORG, direction: "payable", description: "Aluguel", amount_cents: 250000, currency: "BRL", due_on: "2026-09-10" });
    expect(JSON.stringify(payload)).not.toContain(OUTRA_ORG);
    // `status` não é do POST: conta nasce `open` pelo default da coluna, e a
    // baixa tem porta própria (PATCH), onde o `paid_on` é cobrado.
    expect(payload).not.toHaveProperty("status");
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "financeiro.obrigacao_criada", organizationId: ORG, actorUserId: ANA, resourceId: OBRIGACAO }),
    );
  });
});

describe("PATCH /api/v1/financeiro/obrigacoes/[id]", () => {
  it("dar por paga sem dizer o dia é 422 — a constraint da baixa não chega a ser exercida", async () => {
    const { PATCH } = await import("@/app/api/v1/financeiro/obrigacoes/[id]/route");
    const res = await PATCH(pedido(`obrigacoes/${OBRIGACAO}`, "PATCH", { status: "paid", paid_cents: 250000 }), contexto(OBRIGACAO));
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toMatch(/paid_on/);
    expect(chamadas).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("corpo vazio, id que não é uuid e status de fora do vocabulário são 422", async () => {
    const { PATCH } = await import("@/app/api/v1/financeiro/obrigacoes/[id]/route");
    expect((await PATCH(pedido(`obrigacoes/${OBRIGACAO}`, "PATCH", {}), contexto(OBRIGACAO))).status).toBe(422);
    expect((await PATCH(pedido("obrigacoes/o-1", "PATCH", { status: "cancelled" }), contexto("o-1"))).status).toBe(422);
    expect((await PATCH(pedido(`obrigacoes/${OBRIGACAO}`, "PATCH", { status: "quitada" }), contexto(OBRIGACAO))).status).toBe(422);
    expect((await PATCH(pedido(`obrigacoes/${OBRIGACAO}`, "PATCH", { amount_cents: 0 }), contexto(OBRIGACAO))).status).toBe(422);
    expect(chamadas).toHaveLength(0);
  });

  it("a baixa completa grava só o que veio, filtra a org, ignora organization_id do body e audita", async () => {
    linhas.financial_obligations = [{ id: OBRIGACAO, direction: "payable", description: "Aluguel", amount_cents: 250000, due_on: "2026-09-10", status: "paid", paid_on: "2026-09-09", paid_cents: 250000 }];
    const { PATCH } = await import("@/app/api/v1/financeiro/obrigacoes/[id]/route");
    const res = await PATCH(
      pedido(`obrigacoes/${OBRIGACAO}`, "PATCH", {
        status: "paid",
        paid_on: "2026-09-09",
        paid_cents: 250000,
        organization_id: OUTRA_ORG,
        direction: "receivable",
      }),
      contexto(OBRIGACAO),
    );
    expect(res.status).toBe(200);
    const upd = chamadas.find((c) => c.op === "update")!;
    const payload = upd.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ status: "paid", paid_on: "2026-09-09", paid_cents: 250000 });
    // A direção é a identidade do compromisso: nem o Zod a aceita, nem ela
    // chega ao update. E `description` ausente no corpo não vira `null`.
    expect(payload).not.toHaveProperty("direction");
    expect(payload).not.toHaveProperty("description");
    expect(JSON.stringify(payload)).not.toContain(OUTRA_ORG);
    expect(filtroDeOrg(upd)).toBe(ORG);
    expect(upd.filtros).toContainEqual(["eq", ["id", OBRIGACAO]]);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "financeiro.obrigacao_alterada", organizationId: ORG, actorUserId: ANA, resourceId: OBRIGACAO }),
    );
  });

  it("`paid_on: null` desfaz a baixa — nulo é ordem de apagar, ausência é ordem de não mexer", async () => {
    linhas.financial_obligations = [{ id: OBRIGACAO, status: "open", paid_on: null }];
    const { PATCH } = await import("@/app/api/v1/financeiro/obrigacoes/[id]/route");
    const res = await PATCH(pedido(`obrigacoes/${OBRIGACAO}`, "PATCH", { status: "open", paid_on: null, paid_cents: null }), contexto(OBRIGACAO));
    expect(res.status).toBe(200);
    const payload = chamadas.find((c) => c.op === "update")!.payload as Record<string, unknown>;
    expect(payload.paid_on).toBeNull();
    expect(payload.paid_cents).toBeNull();
  });

  it("obrigação de outra org (ou inexistente) é 404 e não audita", async () => {
    const { PATCH } = await import("@/app/api/v1/financeiro/obrigacoes/[id]/route");
    const res = await PATCH(pedido(`obrigacoes/${OBRIGACAO}`, "PATCH", { description: "Aluguel" }), contexto(OBRIGACAO));
    expect(res.status).toBe(404);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/financeiro/caixa", () => {
  beforeEach(() => {
    // 2026-09-02T03:30:00Z é 00:30 de 02/09 em São Paulo e 23:30 de 01/09 em
    // Manaus: a única janela do dia em que os dois fusos discordam, e por isso a
    // única que prova que o `hoje` sai do fuso da Conta e não do relógio.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T03:30:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function semear(timezone: string | null): void {
    linhas.organizations = [{ timezone }];
    linhas.ledger_balances = [
      { bank_id: "001", account_id: "00012345-6", account_kind: "bank", kind: "ledger", as_of: "2026-08-31", balance_cents: 100000 },
    ];
    linhas.ledger_entries = [
      // Mesmo dia do `as_of`: JÁ está dentro do saldo que o banco declarou.
      { bank_id: "001", account_id: "00012345-6", account_kind: "bank", posted_on: "2026-08-31", amount_cents: -5000 },
      { bank_id: "001", account_id: "00012345-6", account_kind: "bank", posted_on: "2026-09-01", amount_cents: 23456 },
    ];
    linhas.financial_obligations = [
      { id: "o-1", direction: "payable", description: "Aluguel", amount_cents: 250000, due_on: "2026-09-01", status: "open" },
      { id: "o-2", direction: "payable", description: "Energia", amount_cents: 41000, due_on: "2026-08-25", status: "open" },
      { id: "o-3", direction: "receivable", description: "Convênio", amount_cents: 780000, due_on: "2026-09-05", status: "open" },
    ];
  }

  it("delega ao calcularCaixa, traduz account_kind/kind sem trocar os nomes, e não conta o lançamento do dia do saldo", async () => {
    semear("America/Manaus");
    const { GET } = await import("@/app/api/v1/financeiro/caixa/route");
    const res = await GET(pedido("caixa", "GET"));
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.caixa.contas).toEqual([
      {
        bank_id: "001",
        account_id: "00012345-6",
        account_kind: "bank",
        saldo_cents: 100000,
        saldo_em: "2026-08-31",
        lancamentos_depois: 1,
        soma_depois_cents: 23456,
        saldo_estimado_cents: 123456,
        incompleto: false,
      },
    ]);
    expect(data.caixa.total_cents).toBe(123456);
    expect(data.caixa.incompleto).toBe(false);
    // As três tabelas do módulo filtram a org à mão (service role bypassa RLS);
    // `organizations` é a própria linha da Conta, filtrada por `id`.
    for (const tabela of ["ledger_balances", "ledger_entries", "financial_obligations"]) {
      expect(filtroDeOrg(chamadas.find((c) => c.tabela === tabela)!), tabela).toBe(ORG);
    }
    expect(chamadas.find((c) => c.tabela === "organizations")!.filtros).toContainEqual(["eq", ["id", ORG]]);
  });

  it("o `hoje` sai do fuso da organização — 23:30 em Manaus ainda é o dia anterior", async () => {
    semear("America/Manaus");
    const { GET } = await import("@/app/api/v1/financeiro/caixa/route");
    const { data } = await (await GET(pedido("caixa", "GET"))).json();
    expect(data.fuso).toBe("America/Manaus");
    expect(data.hoje).toBe("2026-09-01");
    expect(data.vencimentos.hoje).toBe("2026-09-01");
    expect(data.vencimentos.vencem_hoje.itens.map((i: { id: string }) => i.id)).toEqual(["o-1"]);
    expect(data.vencimentos.vencem_hoje.total_cents).toEqual({ payable: 250000, receivable: 0 });
    expect(data.vencimentos.vencidas.itens.map((i: { id: string }) => i.id)).toEqual(["o-2"]);
    expect(data.vencimentos.proximos_7_dias.itens.map((i: { id: string }) => i.id)).toEqual(["o-3"]);
    expect(data.vencimentos.proximos_7_dias.total_cents).toEqual({ payable: 0, receivable: 780000 });
    expect(data.vencimentos.vencem_hoje.itens[0]).toEqual({
      id: "o-1",
      direction: "payable",
      description: "Aluguel",
      amount_cents: 250000,
      due_on: "2026-09-01",
      status: "open",
    });
  });

  it("fuso que o Intl recusa degrada para America/Sao_Paulo em vez de derrubar a tela", async () => {
    semear("America/Asunción");
    const { GET } = await import("@/app/api/v1/financeiro/caixa/route");
    const { data } = await (await GET(pedido("caixa", "GET"))).json();
    expect(data.fuso).toBe("America/Sao_Paulo");
    expect(data.hoje).toBe("2026-09-02");
  });

  it("conta sem saldo importado é incompleta e leva o total inteiro a null — nunca a zero", async () => {
    semear("America/Sao_Paulo");
    (linhas.ledger_entries as unknown[]).push({
      bank_id: "",
      account_id: "4111",
      account_kind: "credit_card",
      posted_on: "2026-09-01",
      amount_cents: -18000,
    });
    const { GET } = await import("@/app/api/v1/financeiro/caixa/route");
    const { data } = await (await GET(pedido("caixa", "GET"))).json();
    const cartao = data.caixa.contas.find((c: { account_kind: string }) => c.account_kind === "credit_card");
    expect(cartao).toMatchObject({ saldo_cents: null, saldo_em: null, saldo_estimado_cents: null, incompleto: true });
    expect(data.caixa.total_cents).toBeNull();
    expect(data.caixa.incompleto).toBe(true);
  });

  it("a leitura de lançamentos corta no menor `as_of` dos saldos, e só as abertas entram nos vencimentos", async () => {
    semear("America/Sao_Paulo");
    const { GET } = await import("@/app/api/v1/financeiro/caixa/route");
    await GET(pedido("caixa", "GET"));
    const entries = chamadas.find((c) => c.tabela === "ledger_entries")!;
    expect(entries.filtros).toContainEqual(["gte", ["posted_on", "2026-08-31"]]);
    const obrigacoes = chamadas.find((c) => c.tabela === "financial_obligations")!;
    expect(obrigacoes.filtros).toContainEqual(["eq", ["status", "open"]]);
  });

  it("organização sem nada importado devolve caixa vazio e vencimentos vazios, sem 500", async () => {
    linhas.organizations = [{ timezone: null }];
    const { GET } = await import("@/app/api/v1/financeiro/caixa/route");
    const res = await GET(pedido("caixa", "GET"));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.caixa).toEqual({ total_cents: 0, incompleto: false, contas: [] });
    expect(data.fuso).toBe("America/Sao_Paulo");
    expect(data.vencimentos.vencem_hoje.itens).toEqual([]);
    // Sem saldo nenhum não há onde cortar: a consulta vai sem `gte`.
    const entries = chamadas.find((c) => c.tabela === "ledger_entries")!;
    expect(entries.filtros.some(([m]) => m === "gte")).toBe(false);
  });
});

/**
 * ⚠️ ACRÉSCIMO DA TAREFA 8 — nada acima foi reescrito.
 *
 * `GET /api/v1/financeiro/lancamentos` não existia: a Tarefa 6 entregou
 * `categorias`, `obrigacoes` e `caixa`, e nenhuma delas LISTA `ledger_entries`
 * (o `/caixa` lê a tabela, mas devolve contagem, não linha). O bloco "Últimos
 * lançamentos" da tela precisa das linhas, então a rota nasceu aqui.
 *
 * O que se prova, e por quê:
 *
 *   • Leitura é `viewer` — extrato é para olhar; quem SOBE arquivo passa por
 *     `manager` na rota de extratos.
 *   • O `organization_id` sai do gate e entra como filtro à mão: o client é
 *     service role e bypassa RLS. Query string não é fonte de tenant.
 *   • O teto do `limit` é do Zod (422), não do Postgres: `limit=999` recusado
 *     com frase, e o default é 50 quando ninguém pede nada.
 *   • Os filtros opcionais viram `eq`/`gte`/`lte` — e a ordem é `posted_on`
 *     descendente, que é a ordem em que se lê extrato.
 */
describe("GET /api/v1/financeiro/lancamentos", () => {
  it("lista com viewer, filtra a org à mão e ordena por posted_on desc", async () => {
    linhas.ledger_entries = [
      {
        id: "lan-1",
        bank_id: "001",
        account_id: "00012345-6",
        account_kind: "bank",
        posted_on: "2026-09-01",
        amount_cents: -25000,
        currency: "BRL",
        trn_type: "DEBIT",
        description: "ALUGUEL SALA",
        key_source: "fitid",
        source: "ofx",
        category_id: null,
      },
    ];
    const { GET } = await import("@/app/api/v1/financeiro/lancamentos/route");
    const res = await GET(pedido("lancamentos", "GET"));
    expect(res.status).toBe(200);
    expect(vi.mocked(requireRole)).toHaveBeenCalledWith("viewer", expect.objectContaining({ requestId: "req-fin" }));

    const json = await res.json();
    expect(json.data[0]).toMatchObject({ id: "lan-1", amount_cents: -25000, key_source: "fitid" });

    const consulta = chamadas.find((c) => c.tabela === "ledger_entries")!;
    expect(filtroDeOrg(consulta)).toBe(ORG);
    expect(consulta.filtros).toContainEqual(["order", ["posted_on", { ascending: false }]]);
    // Sem `limit` na query, o default do Zod é 50 — e ele chega ao PostgREST.
    expect(consulta.filtros).toContainEqual(["limit", [50]]);
  });

  it("account_id, de e ate viram eq/gte/lte; sem eles a consulta vai limpa", async () => {
    const { GET } = await import("@/app/api/v1/financeiro/lancamentos/route");
    await GET(
      new NextRequest(
        "https://crm.exemplo/api/v1/financeiro/lancamentos?account_id=00012345-6&de=2026-08-01&ate=2026-08-31&limit=10",
        { method: "GET", headers: { "x-request-id": "req-fin" } },
      ),
    );
    const comFiltro = chamadas.find((c) => c.tabela === "ledger_entries")!;
    expect(comFiltro.filtros).toContainEqual(["eq", ["account_id", "00012345-6"]]);
    expect(comFiltro.filtros).toContainEqual(["gte", ["posted_on", "2026-08-01"]]);
    expect(comFiltro.filtros).toContainEqual(["lte", ["posted_on", "2026-08-31"]]);
    expect(comFiltro.filtros).toContainEqual(["limit", [10]]);

    chamadas.length = 0;
    await GET(pedido("lancamentos", "GET"));
    const semFiltro = chamadas.find((c) => c.tabela === "ledger_entries")!;
    expect(semFiltro.filtros.some(([m, a]) => m === "eq" && a[0] === "account_id")).toBe(false);
    expect(semFiltro.filtros.some(([m]) => m === "gte" || m === "lte")).toBe(false);
  });

  it("limit acima do teto e data impossível voltam 422, sem tocar o banco", async () => {
    const { GET } = await import("@/app/api/v1/financeiro/lancamentos/route");
    for (const query of ["limit=999", "limit=0", "de=2026-02-30", "ate=31-08-2026"]) {
      chamadas.length = 0;
      const res = await GET(
        new NextRequest(`https://crm.exemplo/api/v1/financeiro/lancamentos?${query}`, {
          method: "GET",
          headers: { "x-request-id": "req-fin" },
        }),
      );
      expect(res.status, query).toBe(422);
      expect(chamadas).toHaveLength(0);
    }
  });

  it("a recusa do requireRole volta como resposta, sem tocar o banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden_role", "não", 403) });
    const { GET } = await import("@/app/api/v1/financeiro/lancamentos/route");
    const res = await GET(pedido("lancamentos", "GET"));
    expect(res.status).toBe(403);
    expect(chamadas).toHaveLength(0);
  });
});
