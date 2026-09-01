import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O vigia do "não é ato médico" — em OBSERVAÇÃO (ADR-0012).
 *
 * De hora em hora lê as respostas do Agente (`sent_via = 'ai'`, `outbound`)
 * da última hora nas Contas com a redação clínica ligada, passa cada uma por
 * `pareceAtoMedico` e, a cada acerto, abre um item na Central de avisos e
 * audita. Não bloqueia, não apaga, não responde: quem decide é uma pessoa.
 *
 * O texto da resposta NUNCA sai do `messages`: nem no item, nem no audit —
 * só o id e o motivo. Uma resposta que parece ato médico provavelmente cita
 * Conteúdo Clínico, e copiá-la para outra tabela seria persistir de novo o
 * que a ADR-0004 proíbe.
 */

const AGORA = new Date("2026-09-01T12:23:00.000Z");
const min = (n: number): string => new Date(AGORA.getTime() - n * 60_000).toISOString();

interface Op {
  tabela: string;
  op: string;
  payload?: unknown;
  filtros: [string, string, unknown][];
}

type Org = { id: string; settings: unknown };
type Msg = {
  id: string;
  organization_id: string;
  direction: string;
  sent_via: string;
  created_at: string;
  body: string | null;
};
type Item = { ref_kind: string; ref_id: string; organization_id: string };

let orgs: Org[];
let mensagens: Msg[];
let itens: Item[];
const ops: Op[] = [];
const auditados: Record<string, unknown>[] = [];

vi.mock("@/lib/audit", () => ({
  audit: async (entrada: Record<string, unknown>) => {
    auditados.push(entrada);
  },
}));

function passaNosFiltros(linha: Record<string, unknown>, filtros: Op["filtros"]): boolean {
  return filtros.every(([op, coluna, valor]) => {
    const atual = linha[coluna];
    if (op === "eq") return atual === valor;
    if (op === "gt") return String(atual) > String(valor);
    return true;
  });
}

/** Dublê do PostgREST no estilo de `lib/channels/meta/coexistencia/duble-de-admin.ts`. */
function adminFalso(): SupabaseClient {
  function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
    const registro: Op = { tabela, op, payload, filtros: [] };
    ops.push(registro);

    const resolver = (): { data: unknown; error: null } => {
      if (op === "insert") {
        if (tabela === "agent_inbox_items") itens.push(payload as Item);
        return { data: null, error: null };
      }
      const fonte: Record<string, unknown>[] =
        tabela === "organizations" ? orgs : tabela === "messages" ? mensagens : tabela === "agent_inbox_items" ? itens : [];
      return { data: fonte.filter((l) => passaNosFiltros(l, registro.filtros)), error: null };
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
            if (["eq", "neq", "gt", "gte", "lt", "in"].includes(String(prop))) {
              registro.filtros.push([String(prop), String(args[0]), args[1]]);
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
      insert: (payload: unknown) => chain(tabela, "insert", payload),
    }),
  } as unknown as SupabaseClient;
}

const { vigiarAtoMedico, redacaoLigada } = await import("./vigia");

const LIGADA = { clinica: { redacao_clinica: true } };
const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";

function resposta(id: string, body: string | null, extra: Partial<Msg> = {}): Msg {
  return {
    id,
    organization_id: ORG,
    direction: "outbound",
    sent_via: "ai",
    created_at: min(10),
    body,
    ...extra,
  };
}

function insertsEm(tabela: string): Record<string, unknown>[] {
  return ops.filter((o) => o.tabela === tabela && o.op === "insert").map((o) => o.payload as Record<string, unknown>);
}

beforeEach(() => {
  orgs = [{ id: ORG, settings: LIGADA }];
  mensagens = [];
  itens = [];
  ops.length = 0;
  auditados.length = 0;
});

describe("redacaoLigada", () => {
  it("só é verdade com settings.clinica.redacao_clinica === true", () => {
    expect(redacaoLigada(LIGADA)).toBe(true);
    expect(redacaoLigada({ clinica: { redacao_clinica: "true" } })).toBe(false);
    expect(redacaoLigada({ clinica: { redacao_clinica: false } })).toBe(false);
    expect(redacaoLigada({ clinica: {} })).toBe(false);
    expect(redacaoLigada({})).toBe(false);
    expect(redacaoLigada(null)).toBe(false);
    expect(redacaoLigada("x")).toBe(false);
  });
});

describe("vigiarAtoMedico", () => {
  it("resposta que prescreve → item na Central e audit, sem o texto", async () => {
    mensagens = [resposta("msg-1", "você deve tomar 1 comprimido de 8 em 8 horas")];

    const r = await vigiarAtoMedico(adminFalso(), { agora: AGORA });

    expect(r).toEqual({ organizacoes: 1, mensagens: 1, suspeitas: 1 });

    const [item] = insertsEm("agent_inbox_items");
    expect(item).toMatchObject({
      organization_id: ORG,
      kind: "other",
      severity: "critical",
      title: "Possível ato médico na resposta do Agente",
      ref_kind: "message",
      ref_id: "msg-1",
    });
    expect(String(item?.body)).toContain("prescricao");
    expect(String(item?.body)).toContain("msg-1");
    expect(String(item?.body)).not.toContain("comprimido");

    expect(auditados).toHaveLength(1);
    expect(auditados[0]).toMatchObject({
      action: "clinica.ato_medico_suspeito",
      organizationId: ORG,
      resourceType: "message",
      resourceId: "msg-1",
      bypassedRls: true,
      metadata: { motivo: "prescricao" },
    });
    expect(JSON.stringify(auditados[0])).not.toContain("comprimido");
  });

  it("resposta de atendimento normal não gera nada", async () => {
    mensagens = [resposta("msg-2", "posso agendar para quinta às 9h?"), resposta("msg-3", null)];

    const r = await vigiarAtoMedico(adminFalso(), { agora: AGORA });

    expect(r).toEqual({ organizacoes: 1, mensagens: 2, suspeitas: 0 });
    expect(insertsEm("agent_inbox_items")).toEqual([]);
    expect(auditados).toEqual([]);
  });

  it("dedup: mensagem já apontada na Central não vira segundo item nem segundo audit", async () => {
    mensagens = [resposta("msg-1", "pode ser gastrite")];
    itens = [{ ref_kind: "message", ref_id: "msg-1", organization_id: ORG }];

    const r = await vigiarAtoMedico(adminFalso(), { agora: AGORA });

    expect(r.suspeitas).toBe(0);
    expect(insertsEm("agent_inbox_items")).toEqual([]);
    expect(auditados).toEqual([]);
  });

  it("só lê respostas do Agente da última hora: filtros mordem em direction, sent_via e created_at", async () => {
    mensagens = [
      resposta("msg-1", "pode ser gastrite"),
      resposta("msg-humano", "pode ser gastrite", { sent_via: "user" }),
      resposta("msg-contato", "pode ser gastrite", { direction: "inbound" }),
      resposta("msg-velha", "pode ser gastrite", { created_at: min(61) }),
    ];

    const r = await vigiarAtoMedico(adminFalso(), { agora: AGORA });

    expect(r.mensagens).toBe(1);
    expect(r.suspeitas).toBe(1);
    expect(insertsEm("agent_inbox_items").map((i) => i.ref_id)).toEqual(["msg-1"]);

    const consulta = ops.find((o) => o.tabela === "messages" && o.op === "select");
    expect(consulta?.filtros).toEqual(
      expect.arrayContaining([
        ["eq", "organization_id", ORG],
        ["eq", "direction", "outbound"],
        ["eq", "sent_via", "ai"],
        ["gt", "created_at", min(60)],
      ]),
    );
  });

  it("Conta com a redação desligada não é lida — nem as mensagens dela", async () => {
    orgs = [
      { id: ORG, settings: LIGADA },
      { id: OUTRA, settings: { clinica: { redacao_clinica: false } } },
    ];
    mensagens = [
      resposta("msg-1", "pode ser gastrite"),
      resposta("msg-outra", "pode ser gastrite", { organization_id: OUTRA }),
    ];

    const r = await vigiarAtoMedico(adminFalso(), { agora: AGORA });

    expect(r).toEqual({ organizacoes: 1, mensagens: 1, suspeitas: 1 });
    expect(insertsEm("agent_inbox_items").map((i) => i.organization_id)).toEqual([ORG]);
  });

  it("nenhuma Conta com redação ligada: não toca em messages", async () => {
    orgs = [{ id: ORG, settings: {} }];
    mensagens = [resposta("msg-1", "pode ser gastrite")];

    const r = await vigiarAtoMedico(adminFalso(), { agora: AGORA });

    expect(r).toEqual({ organizacoes: 0, mensagens: 0, suspeitas: 0 });
    expect(ops.some((o) => o.tabela === "messages")).toBe(false);
  });
});
