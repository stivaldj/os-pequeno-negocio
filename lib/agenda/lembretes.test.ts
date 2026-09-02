import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O lembrete de consulta — o cron que finalmente lê as colunas `reminder_*`.
 *
 * A cada 10 min (`app/api/v1/cron/agenda-lembretes`) seleciona os agendamentos
 * `pending`/`confirmed` sem `reminder_sent_at`, cujo tipo tem `reminder_enabled`
 * e cuja janela chegou (`starts_at - reminder_minutes_before <= agora < starts_at`),
 * e manda pela conversa do agendamento — ou, nos dados de hoje, pela ÚLTIMA
 * conversa do contato — o texto que o Dono combinou. Marca `reminder_sent_at`
 * e audita `agenda.reminder_sent`. Sem conversa: pula e diz por quê.
 *
 * O texto NÃO carrega motivo nem especialidade além do nome do serviço que o
 * próprio Paciente escolheu (ADR-0012).
 */

const AGORA = new Date("2026-09-01T12:00:00.000Z");
const min = (n: number): string => new Date(AGORA.getTime() + n * 60_000).toISOString();

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const DONO = "33333333-3333-4333-8333-333333333333";

interface Op {
  tabela: string;
  op: string;
  payload?: unknown;
  filtros: [string, string, unknown][];
  ordem?: { coluna: string; ascending: boolean };
}

type Tipo = { name: string; reminder_enabled: boolean; reminder_minutes_before: number };
type Agendamento = {
  id: string;
  organization_id: string;
  starts_at: string;
  time_zone: string;
  status: string;
  reminder_sent_at: string | null;
  contact_id: string | null;
  conversation_id: string | null;
  owner_user_id: string | null;
  calendar_event_types: Tipo | null;
};
type Conversa = { id: string; organization_id: string; contact_id: string; last_message_at: string | null };

let agendamentos: Agendamento[];
let conversas: Conversa[];
let nomes: Record<string, string | null>;
const ops: Op[] = [];
const auditados: Record<string, unknown>[] = [];

const { enviar } = vi.hoisted(() => ({ enviar: vi.fn() }));

vi.mock("@/lib/audit", () => ({
  audit: async (entrada: Record<string, unknown>) => {
    auditados.push(entrada);
  },
}));

vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: (...args: unknown[]) => enviar(...args),
}));

function passaNosFiltros(linha: Record<string, unknown>, filtros: Op["filtros"]): boolean {
  return filtros.every(([op, coluna, valor]) => {
    const atual = linha[coluna];
    if (op === "eq") return atual === valor;
    if (op === "is") return atual === valor;
    if (op === "in") return (valor as unknown[]).includes(atual);
    if (op === "gt") return String(atual) > String(valor);
    if (op === "lte") return String(atual) <= String(valor);
    return true;
  });
}

/** Dublê do PostgREST no estilo de `lib/clinica/vigia.test.ts`. */
function adminFalso(): SupabaseClient {
  function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
    const registro: Op = { tabela, op, payload, filtros: [] };
    ops.push(registro);

    const resolver = (): { data: unknown; error: null } => {
      const fonte: Record<string, unknown>[] =
        tabela === "calendar_appointments" ? agendamentos : tabela === "conversations" ? conversas : [];
      const linhas = fonte.filter((l) => passaNosFiltros(l, registro.filtros));
      if (op === "update") {
        for (const l of linhas) Object.assign(l, payload as Record<string, unknown>);
        return { data: linhas, error: null };
      }
      if (registro.ordem) {
        const { coluna, ascending } = registro.ordem;
        linhas.sort((a, b) => {
          const va = a[coluna] === null ? "" : String(a[coluna]);
          const vb = b[coluna] === null ? "" : String(b[coluna]);
          return ascending ? va.localeCompare(vb) : vb.localeCompare(va);
        });
      }
      return { data: linhas, error: null };
    };

    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "maybeSingle") {
            return async () => {
              const r = resolver();
              return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null };
            };
          }
          if (prop === "then") {
            return (ok: (v: unknown) => unknown) => ok(resolver());
          }
          return (...args: unknown[]) => {
            if (["eq", "neq", "gt", "gte", "lt", "lte", "in", "is"].includes(String(prop))) {
              registro.filtros.push([String(prop), String(args[0]), args[1]]);
            }
            if (prop === "order") {
              const opts = args[1] as { ascending?: boolean } | undefined;
              registro.ordem = { coluna: String(args[0]), ascending: opts?.ascending !== false };
            }
            return proxy;
          };
        },
      },
    ) as Record<string, unknown>;
    return proxy;
  }

  return {
    from: (tabela: string) => ({
      select: () => chain(tabela, "select"),
      update: (payload: unknown) => chain(tabela, "update", payload),
    }),
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: { user: { id, user_metadata: { full_name: nomes[id] ?? undefined } } },
          error: null,
        }),
      },
    },
  } as unknown as SupabaseClient;
}

const { enviarLembretesDevidos } = await import("./lembretes");

const TIPO_LIGADO: Tipo = { name: "Consulta nutricional", reminder_enabled: true, reminder_minutes_before: 1440 };

function agendamento(id: string, extra: Partial<Agendamento> = {}): Agendamento {
  return {
    id,
    organization_id: ORG,
    // 4 h à frente, no fuso de São Paulo: 12:00Z + 4 h = 16:00Z = 13:00 local.
    starts_at: min(240),
    time_zone: "America/Sao_Paulo",
    status: "confirmed",
    reminder_sent_at: null,
    contact_id: CONTATO,
    conversation_id: null,
    owner_user_id: DONO,
    calendar_event_types: TIPO_LIGADO,
    ...extra,
  };
}

function conversa(id: string, lastMessageAt: string | null): Conversa {
  return { id, organization_id: ORG, contact_id: CONTATO, last_message_at: lastMessageAt };
}

function updatesEm(tabela: string): Op[] {
  return ops.filter((o) => o.tabela === tabela && o.op === "update");
}

beforeEach(() => {
  agendamentos = [];
  conversas = [];
  nomes = { [DONO]: "Dra. Ana" };
  ops.length = 0;
  auditados.length = 0;
  enviar.mockReset();
  enviar.mockResolvedValue({ id: "msg-enviada" });
});

describe("enviarLembretesDevidos — o caminho primário (última conversa do contato)", () => {
  it("manda pela conversa mais recente do contato, marca reminder_sent_at e audita", async () => {
    agendamentos = [agendamento("apt-1")];
    conversas = [conversa("conv-velha", min(-10_000)), conversa("conv-nova", min(-30)), conversa("conv-sem-data", null)];

    const r = await enviarLembretesDevidos(adminFalso(), { agora: AGORA });

    expect(r).toEqual({ candidatos: 1, enviados: 1, pulados: [] });

    expect(enviar).toHaveBeenCalledTimes(1);
    const [, ctx, input] = enviar.mock.calls[0] as [unknown, Record<string, unknown>, Record<string, unknown>];
    expect(ctx).toMatchObject({ organization_id: ORG, actor: { type: "ai_agent" } });
    expect(input).toMatchObject({
      conversation_id: "conv-nova",
      type: "text",
      body:
        "Lembrete: sua consulta de Consulta nutricional é terça-feira 01/09 às 13:00 com Dra. Ana. " +
        "Responda SIM para confirmar ou avise se precisar remarcar.",
      metadata: { lembrete_de_agendamento: true, appointment_id: "apt-1" },
    });

    const [marca] = updatesEm("calendar_appointments");
    expect(marca?.payload).toEqual({ reminder_sent_at: AGORA.toISOString() });
    expect(marca?.filtros).toContainEqual(["eq", "id", "apt-1"]);
    // A marca só pega quem ainda não foi marcado — dois crons concorrentes não mandam dois.
    expect(marca?.filtros).toContainEqual(["is", "reminder_sent_at", null]);
    expect(agendamentos[0]?.reminder_sent_at).toBe(AGORA.toISOString());

    expect(auditados).toHaveLength(1);
    expect(auditados[0]).toMatchObject({
      action: "agenda.reminder_sent",
      organizationId: ORG,
      resourceType: "calendar_appointment",
      resourceId: "apt-1",
      bypassedRls: true,
      metadata: { appointment_id: "apt-1", conversation_id: "conv-nova", minutos_antes: 1440 },
    });
  });

  it("usa conversation_id do agendamento quando existe, sem procurar a conversa do contato", async () => {
    agendamentos = [agendamento("apt-2", { conversation_id: "conv-do-agendamento" })];
    conversas = [conversa("conv-nova", min(-30))];

    const r = await enviarLembretesDevidos(adminFalso(), { agora: AGORA });

    expect(r.enviados).toBe(1);
    expect((enviar.mock.calls[0] as [unknown, unknown, Record<string, unknown>])[2]).toMatchObject({
      conversation_id: "conv-do-agendamento",
    });
    expect(ops.filter((o) => o.tabela === "conversations")).toHaveLength(0);
  });

  it("o texto fala só do serviço: sem motivo, sem especialidade, sem dado clínico", async () => {
    agendamentos = [agendamento("apt-3")];
    conversas = [conversa("conv-1", min(-30))];

    await enviarLembretesDevidos(adminFalso(), { agora: AGORA });

    const body = String((enviar.mock.calls[0] as [unknown, unknown, Record<string, unknown>])[2]?.body);
    expect(body).toMatch(/^Lembrete: sua consulta de Consulta nutricional é /);
    expect(body).not.toMatch(/motivo|sintoma|diagn/i);
  });

  it("Profissional sem nome resolvido: a frase sai sem o 'com'", async () => {
    nomes = {};
    agendamentos = [agendamento("apt-4")];
    conversas = [conversa("conv-1", min(-30))];

    await enviarLembretesDevidos(adminFalso(), { agora: AGORA });

    const body = String((enviar.mock.calls[0] as [unknown, unknown, Record<string, unknown>])[2]?.body);
    expect(body).toBe(
      "Lembrete: sua consulta de Consulta nutricional é terça-feira 01/09 às 13:00. " +
        "Responda SIM para confirmar ou avise se precisar remarcar.",
    );
  });
});

describe("enviarLembretesDevidos — quem é candidato", () => {
  it("só entra quem está na janela, com lembrete ligado, sem marca e em pending/confirmed", async () => {
    agendamentos = [
      agendamento("na-janela"),
      agendamento("pending-na-janela", { status: "pending" }),
      agendamento("tipo-desligado", { calendar_event_types: { ...TIPO_LIGADO, reminder_enabled: false } }),
      agendamento("sem-tipo", { calendar_event_types: null }),
      agendamento("ja-marcado", { reminder_sent_at: min(-5) }),
      agendamento("cancelado", { status: "cancelled" }),
      agendamento("concluido", { status: "completed" }),
      agendamento("longe-demais", { starts_at: min(1440 + 30) }),
      agendamento("ja-passou", { starts_at: min(-5) }),
      agendamento("janela-curta-ainda-nao", {
        calendar_event_types: { ...TIPO_LIGADO, reminder_minutes_before: 60 },
        starts_at: min(90),
      }),
    ];
    conversas = [conversa("conv-1", min(-30))];

    const r = await enviarLembretesDevidos(adminFalso(), { agora: AGORA });

    expect(r.candidatos).toBe(2);
    expect(r.enviados).toBe(2);
    const marcados = updatesEm("calendar_appointments").map((o) => o.filtros.find(([, c]) => c === "id")?.[2]);
    expect(marcados.sort()).toEqual(["na-janela", "pending-na-janela"]);
  });

  it("a consulta ao banco já recorta status, marca e horizonte — não varre a agenda inteira", async () => {
    await enviarLembretesDevidos(adminFalso(), { agora: AGORA });

    const [leitura] = ops.filter((o) => o.tabela === "calendar_appointments" && o.op === "select");
    expect(leitura?.filtros).toContainEqual(["in", "status", ["pending", "confirmed"]]);
    expect(leitura?.filtros).toContainEqual(["is", "reminder_sent_at", null]);
    expect(leitura?.filtros).toContainEqual(["gt", "starts_at", AGORA.toISOString()]);
    expect(leitura?.filtros.some(([op, col]) => op === "lte" && col === "starts_at")).toBe(true);
  });
});

describe("enviarLembretesDevidos — quando não dá para mandar", () => {
  it("a seco devolve os candidatos sem enviar, marcar nem auditar", async () => {
    agendamentos = [agendamento("apt-1"), agendamento("apt-2", { contact_id: null })];
    conversas = [conversa("conv-1", min(-30))];

    const r = await enviarLembretesDevidos(adminFalso(), { agora: AGORA, dryRun: true });

    expect(r).toEqual({
      candidatos: 2,
      enviados: 0,
      pulados: [{ appointment_id: "apt-2", motivo: "sem_canal" }],
    });
    expect(enviar).not.toHaveBeenCalled();
    expect(updatesEm("calendar_appointments")).toHaveLength(0);
    expect(auditados).toHaveLength(0);
  });

  it("contato sem conversa → pula com sem_canal, não marca, não audita", async () => {
    agendamentos = [agendamento("apt-1")];
    conversas = [];

    const r = await enviarLembretesDevidos(adminFalso(), { agora: AGORA });

    expect(r).toEqual({ candidatos: 1, enviados: 0, pulados: [{ appointment_id: "apt-1", motivo: "sem_canal" }] });
    expect(enviar).not.toHaveBeenCalled();
    expect(updatesEm("calendar_appointments")).toHaveLength(0);
    expect(auditados).toHaveLength(0);
  });

  it("envio que falha → pula com envio_falhou, não marca (tenta de novo na próxima), não audita", async () => {
    agendamentos = [agendamento("apt-1"), agendamento("apt-2")];
    conversas = [conversa("conv-1", min(-30))];
    enviar.mockRejectedValueOnce(Object.assign(new Error("contato bloqueado"), { name: "ApiError" }));

    const r = await enviarLembretesDevidos(adminFalso(), { agora: AGORA });

    expect(r).toEqual({
      candidatos: 2,
      enviados: 1,
      pulados: [{ appointment_id: "apt-1", motivo: "envio_falhou:ApiError" }],
    });
    expect(updatesEm("calendar_appointments")).toHaveLength(1);
    expect(auditados).toHaveLength(1);
    expect(auditados[0]).toMatchObject({ resourceId: "apt-2" });
  });
});
