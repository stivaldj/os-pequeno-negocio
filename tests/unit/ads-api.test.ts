/**
 * A API de Anúncios (`/api/v1/ads/*`) — Fase 5, Tarefa 9.
 *
 * O que se prova aqui, e por que cada coisa:
 *
 *   • O gate é `requireRole("manager")` em toda rota, e a recusa dele VOLTA
 *     como resposta: nenhuma rota lê banco antes do gate.
 *   • O `organization_id` vem de `authz.org.orgId` — o body pode mandar outro
 *     e ele é IGNORADO. É a regra do service role (bypassa RLS, filtra à mão).
 *   • Zod recusa antes do Postgres: `customer_id` com 9 dígitos, WhatsApp sem
 *     `+`, `dias` fora de 7|30, `status` `aplicada` (Fase 8) — tudo 422.
 *   • `autonomy_level` e os três limites de orçamento SÃO editáveis desde a
 *     Fase 8 (ADR-0018): mudar o nível audita `ads.nivel_alterado` À PARTE de
 *     `ads.account_updated`, e só quando o nível DE FATO muda.
 *   • Toda mutação audita (`ads.account_updated`, `ads.link_created`,
 *     `ads.proposal_decided`) com a org e o ator.
 *   • O link de captura nasce com slug do NOME da campanha + 4 chars, e volta
 *     com a URL pública que o Dono cola no Google.
 *   • Campanhas juntam `sobraPorRealDaConta` com os cliques do `ad_spend`, e
 *     saem em snake_case.
 *
 * Molde: `tests/unit/canal-oficial-embedded-signup.test.ts` (mock de
 * require-role, audit e admin client).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/ads/relatorio", () => ({ sobraPorRealDaConta: vi.fn() }));

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

function pedido(caminho: string, metodo: "GET" | "POST" | "PATCH", body?: unknown): NextRequest {
  return new NextRequest(`https://crm.exemplo/api/v1/ads/${caminho}`, {
    method: metodo,
    headers: { "content-type": "application/json", "x-request-id": "req-ads" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const filtroDeOrg = (c: Chamada) => c.filtros.find(([m, a]) => m === "eq" && a[0] === "organization_id")?.[1][1];

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: orgAtiva });
  vi.mocked(audit).mockClear();
  chamadas.length = 0;
  for (const k of Object.keys(linhas)) delete linhas[k];
});

describe("todas as rotas param no gate de manager", () => {
  it("a recusa do requireRole volta como resposta, sem tocar o banco", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: fail("forbidden_role", "não", 403) });
    const conta = await import("@/app/api/v1/ads/conta/route");
    const links = await import("@/app/api/v1/ads/links/route");
    const campanhas = await import("@/app/api/v1/ads/campanhas/route");
    const propostas = await import("@/app/api/v1/ads/propostas/route");
    const respostas = await Promise.all([
      conta.GET(pedido("conta", "GET")),
      conta.PATCH(pedido("conta", "PATCH", { customer_id: "1234567890" })),
      links.GET(pedido("links", "GET")),
      links.POST(pedido("links", "POST", {})),
      campanhas.GET(pedido("campanhas?dias=7", "GET")),
      propostas.GET(pedido("propostas", "GET")),
      propostas.PATCH(pedido("propostas", "PATCH", {})),
    ]);
    for (const r of respostas) expect(r.status).toBe(403);
    expect(vi.mocked(requireRole)).toHaveBeenCalledWith("manager", expect.objectContaining({ requestId: "req-ads" }));
    expect(chamadas).toHaveLength(0);
  });
});

describe("GET/PATCH /api/v1/ads/conta", () => {
  it("GET devolve null quando a org ainda não configurou a Conta — filtrando a org", async () => {
    const { GET } = await import("@/app/api/v1/ads/conta/route");
    const res = await GET(pedido("conta", "GET"));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toBeNull();
    expect(filtroDeOrg(chamadas[0]!)).toBe(ORG);
  });

  it("GET devolve a Conta em snake_case com o nível de autonomia", async () => {
    linhas.ad_accounts = [{ id: "acc-1", customer_id: "1234567890", conversion_customer_id: null, conversion_action: "Lead WhatsApp", currency: "BRL", autonomy_level: 1, status: "active", last_sync_at: null, last_error: null }];
    const { GET } = await import("@/app/api/v1/ads/conta/route");
    const json = await (await GET(pedido("conta", "GET"))).json();
    expect(json.data).toMatchObject({ customer_id: "1234567890", autonomy_level: 1, conversion_action: "Lead WhatsApp" });
  });

  it("Zod recusa customer_id que não tem 10 dígitos", async () => {
    const { PATCH } = await import("@/app/api/v1/ads/conta/route");
    const res = await PATCH(pedido("conta", "PATCH", { customer_id: "123456789" }));
    expect(res.status).toBe(422);
    expect(chamadas).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });

  it("PATCH faz upsert por (organization_id, provider) com a org do gate — ignora organization_id do body, mas leva o autonomy_level (Fase 8)", async () => {
    linhas.ad_accounts = [{ id: "acc-1", customer_id: "1234567890", conversion_customer_id: "0987654321", conversion_action: "Lead", currency: "BRL", autonomy_level: 1, status: "active", last_sync_at: null, last_error: null }];
    const { PATCH } = await import("@/app/api/v1/ads/conta/route");
    const res = await PATCH(
      pedido("conta", "PATCH", { customer_id: "1234567890", conversion_customer_id: "0987654321", conversion_action: "Lead", organization_id: OUTRA_ORG, autonomy_level: 3 }),
    );
    expect(res.status).toBe(200);
    const upsert = chamadas.find((c) => c.op === "upsert" && c.tabela === "ad_accounts")!;
    expect(upsert.payload).toMatchObject({ organization_id: ORG, provider: "google_ads", customer_id: "1234567890", conversion_customer_id: "0987654321", conversion_action: "Lead", autonomy_level: 3 });
    expect(JSON.stringify(upsert.payload)).not.toContain(OUTRA_ORG);
    expect(upsert.opts).toMatchObject({ onConflict: "organization_id,provider" });
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ads.account_updated", organizationId: ORG, actorUserId: ANA, resourceType: "ad_accounts" }),
    );
    // O nível ANTERIOR (1, lido de `linhas.ad_accounts` antes da gravação) mudou para 3 — audita à parte.
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ads.nivel_alterado", organizationId: ORG, metadata: { nivel_anterior: 1, nivel_novo: 3 } }),
    );
  });

  it("PATCH sem autonomy_level no corpo: a coluna existente NÃO é tocada, e não audita ads.nivel_alterado", async () => {
    linhas.ad_accounts = [{ id: "acc-1", customer_id: "1234567890", conversion_customer_id: null, conversion_action: null, currency: "BRL", autonomy_level: 2, status: "active", last_sync_at: null, last_error: null }];
    const { PATCH } = await import("@/app/api/v1/ads/conta/route");
    const res = await PATCH(pedido("conta", "PATCH", { customer_id: "1234567890" }));
    expect(res.status).toBe(200);
    const upsert = chamadas.find((c) => c.op === "upsert" && c.tabela === "ad_accounts")!;
    expect(upsert.payload).not.toHaveProperty("autonomy_level");
    expect(vi.mocked(audit)).not.toHaveBeenCalledWith(expect.objectContaining({ action: "ads.nivel_alterado" }));
  });
});

describe("GET/POST /api/v1/ads/links", () => {
  it("GET lista os links da org com a URL pública", async () => {
    linhas.ad_capture_links = [{ id: "l-1", slug: "consulta-abcd", campaign_id: "c-1", campaign_name: "Consulta", whatsapp_e164: "+5565999990000", mensagem: "Oi", active: true, created_at: "2026-09-01T00:00:00Z" }];
    const { GET } = await import("@/app/api/v1/ads/links/route");
    const json = await (await GET(pedido("links", "GET"))).json();
    expect(filtroDeOrg(chamadas[0]!)).toBe(ORG);
    expect(json.data[0].url).toMatch(/^https?:\/\/.+\/ir\/consulta-abcd$/);
  });

  it("Zod recusa WhatsApp fora do E.164", async () => {
    const { POST } = await import("@/app/api/v1/ads/links/route");
    const res = await POST(pedido("links", "POST", { campaign_id: "c-1", campaign_name: "Consulta", whatsapp_e164: "65999990000", mensagem: "Oi" }));
    expect(res.status).toBe(422);
    expect(chamadas).toHaveLength(0);
  });

  it("POST cria com slug do nome da campanha + 4 chars, org do gate, e audita", async () => {
    linhas.ad_capture_links = [{ id: "l-2", slug: "sera-trocado", campaign_id: "c-9", campaign_name: "Consulta Ortopédica", whatsapp_e164: "+5565999990000", mensagem: "Oi", active: true, created_at: "2026-09-01T00:00:00Z" }];
    const { POST } = await import("@/app/api/v1/ads/links/route");
    const res = await POST(
      pedido("links", "POST", { campaign_id: "c-9", campaign_name: "Consulta Ortopédica", whatsapp_e164: "+5565999990000", mensagem: "Oi", organization_id: OUTRA_ORG }),
    );
    expect(res.status).toBe(201);
    const insert = chamadas.find((c) => c.op === "insert")!;
    const payload = insert.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ organization_id: ORG, campaign_id: "c-9", campaign_name: "Consulta Ortopédica", whatsapp_e164: "+5565999990000", mensagem: "Oi" });
    expect(payload.slug).toMatch(/^consulta-ortopedica-[a-z0-9]{4}$/);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ads.link_created", organizationId: ORG, actorUserId: ANA, resourceId: "l-2" }),
    );
  });
});

describe("GET /api/v1/ads/campanhas", () => {
  it("dias fora de 7|30 é 422", async () => {
    const { GET } = await import("@/app/api/v1/ads/campanhas/route");
    expect((await GET(pedido("campanhas?dias=15", "GET"))).status).toBe(422);
  });

  it("junta a Sobra por Real com os cliques do ad_spend, em snake_case, no período pedido", async () => {
    const { sobraPorRealDaConta } = await import("@/lib/ads/relatorio");
    vi.mocked(sobraPorRealDaConta).mockResolvedValue({
      periodo: { de: "2026-08-27", ate: "2026-09-02" },
      campanhas: [
        { campaignId: "c-1", campaignName: "Consulta", gastoCents: 10000, contatos: 4, vendas: 2, vendasSemMargem: 1, receitaCents: 40000, sobraCents: 25000, sobraPorReal: 2.5, diasSemGasto: ["2026-09-01"], incompleto: true },
      ],
      total: { gastoCents: 10000, receitaCents: 40000, sobraCents: 25000, sobraPorReal: 2.5, incompleto: true },
    });
    linhas.ad_spend = [
      { campaign_id: "c-1", clicks: 10 },
      { campaign_id: "c-1", clicks: 5 },
    ];
    const { GET } = await import("@/app/api/v1/ads/campanhas/route");
    const res = await GET(pedido("campanhas?dias=7", "GET"));
    expect(res.status).toBe(200);
    const json = await res.json();
    const [, org, periodo] = vi.mocked(sobraPorRealDaConta).mock.calls[0]!;
    expect(org).toBe(ORG);
    expect(periodo.ate >= periodo.de).toBe(true);
    // 7 dias, inclusivo: o `de` é o `ate` menos seis.
    const dias = (Date.parse(periodo.ate) - Date.parse(periodo.de)) / 86_400_000 + 1;
    expect(dias).toBe(7);
    expect(filtroDeOrg(chamadas.find((c) => c.tabela === "ad_spend")!)).toBe(ORG);
    expect(json.data.campanhas[0]).toEqual({
      campaign_id: "c-1",
      campaign_name: "Consulta",
      gasto_cents: 10000,
      cliques: 15,
      contatos: 4,
      agendamentos: 3,
      vendas: 2,
      vendas_sem_margem: 1,
      receita_cents: 40000,
      sobra_cents: 25000,
      sobra_por_real: 2.5,
      dias_sem_gasto: ["2026-09-01"],
      incompleto: true,
    });
    expect(json.data.total).toEqual({ gasto_cents: 10000, receita_cents: 40000, sobra_cents: 25000, sobra_por_real: 2.5, incompleto: true });
  });
});

describe("GET/PATCH /api/v1/ads/propostas", () => {
  it("GET lista as pendentes da org por padrão", async () => {
    linhas.ad_proposals = [{ id: "p-1", campaign_id: "c-1", kind: "orcamento", level: 1, title: "Subir 10%", body: "…", payload: {}, status: "pendente", decided_by: null, decided_at: null, created_at: "2026-09-01T00:00:00Z" }];
    const { GET } = await import("@/app/api/v1/ads/propostas/route");
    const json = await (await GET(pedido("propostas", "GET"))).json();
    const sel = chamadas[0]!;
    expect(filtroDeOrg(sel)).toBe(ORG);
    expect(sel.filtros).toContainEqual(["eq", ["status", "pendente"]]);
    expect(json.data[0]).toMatchObject({ id: "p-1", kind: "orcamento", status: "pendente" });
  });

  it("PATCH recusa `aplicada` (é da Fase 8) e id que não é uuid", async () => {
    const { PATCH } = await import("@/app/api/v1/ads/propostas/route");
    expect((await PATCH(pedido("propostas", "PATCH", { id: "44444444-4444-4444-8444-444444444444", status: "aplicada" }))).status).toBe(422);
    expect((await PATCH(pedido("propostas", "PATCH", { id: "p-1", status: "aprovada" }))).status).toBe(422);
    expect(chamadas).toHaveLength(0);
  });

  it("PATCH decide só proposta PENDENTE da org, grava quem e quando, e audita", async () => {
    const ID = "44444444-4444-4444-8444-444444444444";
    linhas.ad_proposals = [{ id: ID, status: "aprovada", decided_at: "2026-09-02T12:00:00Z" }];
    const { PATCH } = await import("@/app/api/v1/ads/propostas/route");
    const res = await PATCH(pedido("propostas", "PATCH", { id: ID, status: "aprovada" }));
    expect(res.status).toBe(200);
    const upd = chamadas.find((c) => c.op === "update")!;
    expect(upd.payload).toMatchObject({ status: "aprovada", decided_by: ANA });
    expect((upd.payload as { decided_at: string }).decided_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(filtroDeOrg(upd)).toBe(ORG);
    expect(upd.filtros).toContainEqual(["eq", ["status", "pendente"]]);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ads.proposal_decided", organizationId: ORG, actorUserId: ANA, resourceId: ID, metadata: expect.objectContaining({ status: "aprovada" }) }),
    );
  });

  it("PATCH em proposta já decidida (ou de outra org) é 404 e não audita", async () => {
    const { PATCH } = await import("@/app/api/v1/ads/propostas/route");
    const res = await PATCH(pedido("propostas", "PATCH", { id: "44444444-4444-4444-8444-444444444444", status: "recusada" }));
    expect(res.status).toBe(404);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});
