/**
 * ADR-0017 na API: preço e margem entram pelo tipo e chegam ao Agente pela
 * tool; o valor pago entra pelo PATCH de "compareceu", só com `completed`,
 * e é auditado — dinheiro no registro nunca passa calado.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/agenda/consulta", async (original) => {
  const real = (await original()) as Record<string, unknown>;
  return { ...real, listaTiposDeAtendimento: vi.fn() };
});

const { audit } = await import("@/lib/audit");
const { listaTiposDeAtendimento } = await import("@/lib/agenda/consulta");
const { crmListEventTypes } = await import("@/lib/mcp/tools/agendamento");
const { alterarAgendamentoHandler } = await import("@/app/api/v1/agenda/agendamentos/_handler");

const ctxMcp: McpContext = {
  organizationId: "org-1",
  role: "manager",
  actor: { type: "ai_agent", id: "agent-1" } as never,
  apiTokenId: "tok",
  requestId: "req",
  supabase: {} as unknown as SupabaseClient,
};

describe("crm_list_event_types leva o preço ao Agente", () => {
  it("preco_cents vem do tipo; nulo quando o Dono não cadastrou", async () => {
    vi.mocked(listaTiposDeAtendimento).mockResolvedValue({
      ok: true,
      tipos: [
        { id: "t1", nome: "Consulta", slug: "consulta", descricao: null, categoria: "consulta", duracaoMin: 30, localKind: "in_person", localDetalhes: null, precisaConfirmacao: false, ativo: true, donoPadraoId: null, bufferAntesMin: 0, bufferDepoisMin: 0, antecedenciaMinimaMin: 0, janelaDeAgendamentoDias: 14, precoCents: 20000, margemBps: 6000 },
        { id: "t2", nome: "Retorno", slug: "retorno", descricao: null, categoria: "retorno", duracaoMin: 15, localKind: "in_person", localDetalhes: null, precisaConfirmacao: false, ativo: true, donoPadraoId: null, bufferAntesMin: 0, bufferDepoisMin: 0, antecedenciaMinimaMin: 0, janelaDeAgendamentoDias: 14, precoCents: null, margemBps: null },
      ],
    } as never);
    const r = (await crmListEventTypes.handler({}, ctxMcp)) as { tipos: Record<string, unknown>[] };
    expect(r.tipos[0]).toMatchObject({ slug: "consulta", preco_cents: 20000, moeda: "BRL" });
    expect(r.tipos[1]).toMatchObject({ slug: "retorno", preco_cents: null });
    // A margem é do Dono, não do paciente: NÃO vai ao modelo.
    expect(JSON.stringify(r)).not.toContain("6000");
  });
});

describe("PATCH compareceu com valor", () => {
  const updates: Record<string, unknown>[] = [];
  const atual = { id: "ap-1", event_type_id: "t1", owner_user_id: "u1", contact_id: "c1", starts_at: "2026-09-01T12:00:00.000Z", status: "confirmed", time_zone: "America/Cuiaba" };
  /** Dublê encadeável: qualquer cadeia resolve; `calendar_appointments` devolve `atual`, updates são capturados. */
  function chain(tabela: string, op: string, payload?: Record<string, unknown>): unknown {
    if (op === "update" && payload) updates.push(payload);
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "maybeSingle" || prop === "single") {
            return async () => ({
              data: tabela === "calendar_appointments" ? (op === "update" ? { ...atual, ...payload } : atual) : null,
              error: null,
            });
          }
          if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
          return () => proxy;
        },
      },
    );
    return proxy;
  }
  const supabase = {
    from: (tabela: string) => ({
      select: () => chain(tabela, "select"),
      update: (payload: Record<string, unknown>) => chain(tabela, "update", payload),
      insert: (payload: Record<string, unknown>) => chain(tabela, "insert", payload),
    }),
    rpc: async () => ({ data: null, error: null }),
  } as never;
  const ctx = { organization_id: "org-1", requestId: "req", actor: { type: "user", id: "u1" } } as never;

  beforeEach(() => {
    updates.length = 0;
    vi.mocked(audit).mockClear();
  });

  it("grava paid_cents e paid_currency e audita agenda.appointment_paid", async () => {
    await alterarAgendamentoHandler(supabase, ctx, { id: "ap-1", status: "completed", paid_cents: 20000 });
    expect(updates[0]).toMatchObject({ status: "completed", paid_cents: 20000, paid_currency: "BRL" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "agenda.appointment_paid", metadata: expect.objectContaining({ paid_cents: 20000 }) }));
  });

  it("compareceu sem valor não grava zero — dado faltante", async () => {
    await alterarAgendamentoHandler(supabase, ctx, { id: "ap-1", status: "completed" });
    expect(updates[0]).not.toHaveProperty("paid_cents");
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "agenda.appointment_paid" }));
  });

  it("corrigir o valor num agendamento já completed atualiza, não devolve inalterado", async () => {
    atual.status = "completed";
    const r = await alterarAgendamentoHandler(supabase, ctx, { id: "ap-1", status: "completed", paid_cents: 18000 });
    expect(r).not.toHaveProperty("inalterado");
    expect(updates[0]).toMatchObject({ paid_cents: 18000 });
    atual.status = "confirmed";
  });
});
