import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

const ORG = "org-1";

function reqPatch(body: unknown) {
  return new NextRequest("http://localhost/api/v1/ads/conta", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function authOk() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG, role: "manager" },
    user: { id: "user-1" },
  } as never);
}

/**
 * Dublê da `ad_accounts`: a rota faz um SELECT (nível anterior) e depois um
 * UPSERT + SELECT (a gravação). `linhaExistente` é o que o SELECT devolve
 * ANTES da gravação — `null` simula Conta ainda não criada.
 */
function dbFalso(linhaExistente: { autonomy_level: number } | null) {
  const upserts: Record<string, unknown>[] = [];
  const admin = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: linhaExistente, error: null }),
          }),
        }),
      }),
      upsert: (payload: Record<string, unknown>) => {
        upserts.push(payload);
        return {
          select: () => ({
            single: async () => ({
              data: {
                id: "conta-1",
                customer_id: payload.customer_id,
                conversion_customer_id: payload.conversion_customer_id ?? null,
                conversion_action: payload.conversion_action ?? null,
                currency: "BRL",
                autonomy_level: payload.autonomy_level ?? linhaExistente?.autonomy_level ?? 1,
                budget_floor_cents: "budget_floor_cents" in payload ? payload.budget_floor_cents : null,
                budget_ceiling_cents: "budget_ceiling_cents" in payload ? payload.budget_ceiling_cents : null,
                max_cost_per_conversation_cents: "max_cost_per_conversation_cents" in payload ? payload.max_cost_per_conversation_cents : null,
                status: "active",
                last_sync_at: null,
                last_error: null,
              },
              error: null,
            }),
          }),
        };
      },
    }),
  };
  vi.mocked(createAdminClient).mockReturnValue(admin as never);
  return { upserts };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/v1/ads/conta — Fase 8: nível e limites viram painel", () => {
  it("nível omitido no corpo: NÃO entra no upsert — a coluna existente fica intocada", async () => {
    const { upserts } = dbFalso({ autonomy_level: 2 });
    authOk();
    const { PATCH } = await import("./route");
    await PATCH(reqPatch({ customer_id: "1234567890" }));
    expect(upserts[0]).not.toHaveProperty("autonomy_level");
  });

  it("nível 1→2: entra no upsert e audita ads.nivel_alterado com from/to", async () => {
    dbFalso({ autonomy_level: 1 });
    authOk();
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ customer_id: "1234567890", autonomy_level: 2 }));
    expect(res.status).toBe(200);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ads.nivel_alterado", metadata: { nivel_anterior: 1, nivel_novo: 2 } }),
    );
  });

  it("nível igual ao que já estava: NÃO audita ads.nivel_alterado (sem efeito, sem linha)", async () => {
    dbFalso({ autonomy_level: 2 });
    authOk();
    const { PATCH } = await import("./route");
    await PATCH(reqPatch({ customer_id: "1234567890", autonomy_level: 2 }));
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "ads.nivel_alterado" }));
  });

  it("Conta nova (sem linha existente) ganhando nível 2 direto: nivel_anterior é null", async () => {
    dbFalso(null);
    authOk();
    const { PATCH } = await import("./route");
    await PATCH(reqPatch({ customer_id: "1234567890", autonomy_level: 2 }));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ads.nivel_alterado", metadata: { nivel_anterior: null, nivel_novo: 2 } }),
    );
  });

  it("limite explicitamente null limpa a coluna (diferente de omitido)", async () => {
    const { upserts } = dbFalso({ autonomy_level: 2 });
    authOk();
    const { PATCH } = await import("./route");
    await PATCH(reqPatch({ customer_id: "1234567890", budget_floor_cents: null }));
    expect(upserts[0]).toHaveProperty("budget_floor_cents", null);
  });

  it("piso maior que o teto no mesmo corpo: 422, nenhuma gravação", async () => {
    const { upserts } = dbFalso({ autonomy_level: 2 });
    authOk();
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ customer_id: "1234567890", budget_floor_cents: 9000, budget_ceiling_cents: 3000 }));
    expect(res.status).toBe(422);
    expect(upserts).toHaveLength(0);
  });

  it("nível fora de 1-3: 422", async () => {
    dbFalso({ autonomy_level: 1 });
    authOk();
    const { PATCH } = await import("./route");
    const res = await PATCH(reqPatch({ customer_id: "1234567890", autonomy_level: 4 }));
    expect(res.status).toBe(422);
  });

  it("piso/teto/custo máximo dentro dos CHECKs (inteiro >= 0) gravam e voltam no ads.account_updated", async () => {
    const { upserts } = dbFalso({ autonomy_level: 2 });
    authOk();
    const { PATCH } = await import("./route");
    await PATCH(reqPatch({ customer_id: "1234567890", budget_floor_cents: 3000, budget_ceiling_cents: 8000, max_cost_per_conversation_cents: 5000 }));
    expect(upserts[0]).toMatchObject({ budget_floor_cents: 3000, budget_ceiling_cents: 8000, max_cost_per_conversation_cents: 5000 });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ads.account_updated",
        metadata: expect.objectContaining({ budget_floor_cents: 3000, budget_ceiling_cents: 8000, max_cost_per_conversation_cents: 5000 }),
      }),
    );
  });
});
