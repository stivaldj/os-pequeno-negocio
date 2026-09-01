/**
 * G3-02 + G6-01 (INB-12) — crm_request_human_handoff v2.
 *
 * Prova, contra a tool REAL (ctx.supabase mockado, triggerHandoff mockado):
 *  - a escolha do destino usa o roteamento G5 (loadEligibleAttendants +
 *    selectRoundRobin) — DETERMINÍSTICO sobre elegíveis, NÃO o antigo
 *    pickRoundRobinAssignee random sobre user_organizations;
 *  - com elegível: rpc fn_conversation_assign p_reason='handoff' + retorno
 *    estruturado { assigned_to };
 *  - target_user_id elegível: atribui ao alvo;
 *  - sem elegível: fila — assignee_kind limpo + evento reason='handoff' from/to
 *    null + retorno { queued:true, position }.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { crmRequestHumanHandoff } from "@/lib/mcp/tools/handoff";
import type { McpContext } from "@/lib/mcp/types";

vi.mock("@/lib/ai/handoff/orchestrator", () => ({ triggerHandoff: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CONV_ID = "44444444-4444-4444-8444-444444444444";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_B = "33333333-3333-4333-8333-333333333333";

interface Query {
  table: string;
  select: string | null;
  count: boolean;
  terminal: "maybeSingle" | "then";
}

interface StubState {
  /** atendentes em attendant_availability (is_available=true). */
  attendants: Array<{ user_id: string; capacity: number; schedule: unknown }>;
  queuePositionCount: number;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  updates: Array<{ table: string; values: Record<string, unknown> }>;
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
}

function makeSupabaseStub(state: StubState) {
  const from = (table: string) => {
    const q: Query = { table, select: null, count: false, terminal: "then" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: (cols: string, opts?: { head?: boolean }) => {
        q.select = cols;
        q.count = Boolean(opts?.head);
        return chain;
      },
      eq: () => chain,
      is: () => chain,
      in: () => chain,
      lte: () => chain,
      order: () => chain,
      limit: () => chain,
      update: (values: Record<string, unknown>) => {
        state.updates.push({ table, values });
        return chain;
      },
      insert: (values: Record<string, unknown>) => {
        state.inserts.push({ table, values });
        return Promise.resolve({ data: null, error: null });
      },
      maybeSingle: () => {
        if (table === "conversations") {
          return Promise.resolve({
            data: {
              id: CONV_ID,
              organization_id: ORG_ID,
              contact_id: null,
              last_inbound_at: null,
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null }); // crm_leads lookup
      },
      then: (resolve: (v: unknown) => unknown) => {
        let result: { data?: unknown; count?: number; error: null } = { data: [], error: null };
        if (table === "attendant_availability") result = { data: state.attendants, error: null };
        else if (table === "conversations" && q.count) result = { count: state.queuePositionCount, error: null };
        return Promise.resolve(result).then(resolve);
      },
    };
    return chain;
  };
  return {
    from,
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve({ data: [{ id: CONV_ID }], error: null });
    },
  };
}

function makeCtx(state: StubState): McpContext {
  return {
    organizationId: ORG_ID,
    role: "agent",
    actor: { type: "user", id: AGENT_ID },
    apiTokenId: "tok",
    requestId: "req",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: makeSupabaseStub(state) as any,
  } as McpContext;
}

function stubState(over: Partial<StubState> = {}): StubState {
  return {
    attendants: [{ user_id: AGENT_ID, capacity: 5, schedule: {} }],
    queuePositionCount: 4,
    rpcCalls: [],
    updates: [],
    inserts: [],
    ...over,
  };
}

const baseInput = {
  conversation_id: CONV_ID,
  reason: "cliente pediu humano",
  urgency: "normal" as const,
  target_user_id: undefined,
  metadata: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(triggerHandoff).mockResolvedValue({ triggered: true, reason: "requested_human" });
});

describe("crm_request_human_handoff v2 (INB-12 — roteamento G5 unificado)", () => {
  it("com elegível: selectRoundRobin determinístico ⇒ fn_conversation_assign reason='handoff'", async () => {
    const state = stubState();
    const result = (await crmRequestHumanHandoff.handler(baseInput, makeCtx(state))) as {
      assigned_to: string | null;
      queued: boolean;
      position: number | null;
    };

    expect(state.rpcCalls).toEqual([
      {
        fn: "fn_conversation_assign",
        args: {
          p_organization_id: ORG_ID,
          p_conversation_id: CONV_ID,
          p_to_user_id: AGENT_ID,
          p_reason: "handoff",
          p_enforce_expected: false,
        },
      },
    ]);
    expect(result.assigned_to).toBe(AGENT_ID);
    expect(result.queued).toBe(false);
    expect(result.position).toBeNull();
    expect(state.inserts).toEqual([]);
  });

  it("target_user_id elegível ⇒ atribui ao alvo (não ao rodízio)", async () => {
    const state = stubState({
      attendants: [
        { user_id: AGENT_ID, capacity: 5, schedule: {} },
        { user_id: AGENT_B, capacity: 5, schedule: {} },
      ],
    });
    const result = (await crmRequestHumanHandoff.handler(
      { ...baseInput, target_user_id: AGENT_B },
      makeCtx(state),
    )) as { assigned_to: string | null };

    expect(state.rpcCalls[0]?.args.p_to_user_id).toBe(AGENT_B);
    expect(result.assigned_to).toBe(AGENT_B);
  });

  it("sem elegível: fila — kind limpo + evento reason='handoff' + queued+position", async () => {
    const state = stubState({ attendants: [], queuePositionCount: 4 });
    const result = (await crmRequestHumanHandoff.handler(baseInput, makeCtx(state))) as {
      assigned_to: string | null;
      queued: boolean;
      position: number | null;
    };

    expect(result.assigned_to).toBeNull();
    expect(result.queued).toBe(true);
    expect(result.position).toBe(4);
    expect(state.rpcCalls).toEqual([]);
    expect(state.updates).toContainEqual({
      table: "conversations",
      values: { assignee_kind: null },
    });
    expect(state.inserts).toContainEqual({
      table: "conversation_assignment_events",
      values: {
        organization_id: ORG_ID,
        conversation_id: CONV_ID,
        from_user_id: null,
        to_user_id: null,
        changed_by: null,
        reason: "handoff",
      },
    });
  });
});
