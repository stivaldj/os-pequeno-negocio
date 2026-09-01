/**
 * Carregador reutilizável de atendentes elegíveis (G5-02/G5-03 → G6-01/INB-12).
 *
 * A lógica de "quem pode receber uma conversa agora" (disponível ∧ dentro do
 * horário ∧ com folga) vivia inline no worker de roteamento. G6-01 unifica: o
 * mesmo cálculo alimenta o worker (cron), o handoff v2 (crm_request_human_handoff)
 * e o crm_get_queue_status — UM algoritmo, não três divergentes.
 *
 * O client é injetado (worker passa admin; tools MCP passam ctx.supabase admin),
 * mantendo a org-scoping explícita em toda query (service role bypassa RLS).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isAttendantEligible, OPEN_LOAD_STATUSES } from "./eligibility";
import type { RoutingCandidate } from "./decide";
import { availabilityScheduleSchema } from "@/lib/schemas/routing";

/** Elegíveis = disponíveis ∧ dentro do horário ∧ com folga (carga < capacidade). */
export async function loadEligibleAttendants(
  supabase: SupabaseClient,
  organizationId: string,
  now: Date,
): Promise<RoutingCandidate[]> {
  const { data: avail } = await supabase
    .from("attendant_availability")
    .select("user_id, capacity, schedule")
    .eq("organization_id", organizationId)
    .eq("is_available", true);

  const rows = (avail ?? []) as Array<{ user_id: string; capacity: number; schedule: unknown }>;
  if (rows.length === 0) return [];

  const userIds = rows.map((r) => r.user_id);

  // Carga atual: conversas abertas atribuídas, contadas por dono (1 query).
  const { data: openConvs } = await supabase
    .from("conversations")
    .select("assigned_to_user_id")
    .eq("organization_id", organizationId)
    .in("assigned_to_user_id", userIds)
    .in("status", OPEN_LOAD_STATUSES as unknown as string[]);
  const loadByUser = new Map<string, number>();
  for (const c of (openConvs ?? []) as Array<{ assigned_to_user_id: string | null }>) {
    if (c.assigned_to_user_id) {
      loadByUser.set(c.assigned_to_user_id, (loadByUser.get(c.assigned_to_user_id) ?? 0) + 1);
    }
  }

  // Última atribuição recebida (rodízio real, sem coluna de estado).
  const { data: assignEvents } = await supabase
    .from("conversation_assignment_events")
    .select("to_user_id, created_at")
    .eq("organization_id", organizationId)
    .in("to_user_id", userIds)
    .order("created_at", { ascending: false });
  const lastAssignedByUser = new Map<string, number>();
  for (const e of (assignEvents ?? []) as Array<{ to_user_id: string | null; created_at: string }>) {
    if (e.to_user_id && !lastAssignedByUser.has(e.to_user_id)) {
      lastAssignedByUser.set(e.to_user_id, new Date(e.created_at).getTime());
    }
  }

  const candidates: RoutingCandidate[] = [];
  for (const r of rows) {
    const currentLoad = loadByUser.get(r.user_id) ?? 0;
    const schedule = availabilityScheduleSchema.parse(r.schedule ?? {});
    const eligible = isAttendantEligible(
      { isAvailable: true, capacity: r.capacity, currentLoad, schedule },
      now,
    );
    if (eligible) {
      candidates.push({
        userId: r.user_id,
        currentLoad,
        lastAssignedAt: lastAssignedByUser.get(r.user_id) ?? null,
      });
    }
  }
  return candidates;
}
