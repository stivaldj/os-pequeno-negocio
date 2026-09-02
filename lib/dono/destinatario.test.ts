import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O destinatário "dono" — um contato e uma conversa nos quais o produto escreve.
 *
 * `garantirConversaDoDono` acha ou cria o contato do Dono (pelo WhatsApp de
 * `settings.dono.whatsapp`) e a conversa dele na sessão de canal ativa da
 * Conta. `enviarAoDono` manda pelo `sendMessageHandler` — o MESMO caminho de
 * saída da tela, do MCP e do agente — e NUNCA lança: quem chama é um vigia, e
 * um aviso que não sai não pode derrubar quem avisa.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const WHATSAPP = "+5511999999999";

interface Op {
  tabela: string;
  op: string;
  payload?: unknown;
  filtros: [string, string, unknown][];
}

type Linha = Record<string, unknown>;

let tabelas: Record<string, Linha[]>;
const ops: Op[] = [];
const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
const envios: { ctx: Record<string, unknown>; input: Record<string, unknown> }[] = [];
let falhaNoEnvio: Error | null;
let proximoId = 0;

vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: async (_admin: unknown, ctx: Record<string, unknown>, input: Record<string, unknown>) => {
    if (falhaNoEnvio) throw falhaNoEnvio;
    envios.push({ ctx, input });
    return { id: "msg-1" };
  },
}));

function passaNosFiltros(linha: Linha, filtros: Op["filtros"]): boolean {
  return filtros.every(([op, coluna, valor]) => {
    const atual = linha[coluna];
    if (op === "eq") return atual === valor;
    if (op === "in") return (valor as unknown[]).includes(atual);
    if (op === "is") return (atual ?? null) === valor;
    return true;
  });
}

/** Dublê do PostgREST no estilo de `lib/clinica/vigia.test.ts`, com `in`/`is` mordendo. */
function adminFalso(): SupabaseClient {
  function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
    const registro: Op = { tabela, op, payload, filtros: [] };
    ops.push(registro);

    const resolver = (): { data: unknown; error: null } => {
      if (op === "insert") {
        proximoId += 1;
        const linha = { id: `${tabela}-${proximoId}`, ...(payload as Linha) };
        (tabelas[tabela] ??= []).push(linha);
        return { data: [linha], error: null };
      }
      const fonte = tabelas[tabela] ?? [];
      return { data: fonte.filter((l) => passaNosFiltros(l, registro.filtros)), error: null };
    };

    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "maybeSingle" || prop === "single") {
            return async () => {
              const r = resolver();
              return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null };
            };
          }
          if (prop === "then") {
            return (ok: (v: unknown) => unknown) => ok(resolver());
          }
          return (...args: unknown[]) => {
            if (["eq", "neq", "in", "is"].includes(String(prop))) {
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
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      if (fn === "fn_upsert_wa_conversation") return { data: `conv-${args.p_contact}`, error: null };
      return { data: null, error: { message: `rpc desconhecida: ${fn}` } };
    },
  } as unknown as SupabaseClient;
}

const { enviarAoDono, enviarAosDonos, garantirConversaDoDono } = await import("./destinatario");

function insertsEm(tabela: string): Linha[] {
  return ops.filter((o) => o.tabela === tabela && o.op === "insert").map((o) => o.payload as Linha);
}

function sessao(org: string, extra: Linha = {}): Linha {
  return { id: `sess-${org.slice(0, 4)}`, organization_id: org, status: "WORKING", archived_at: null, ...extra };
}

beforeEach(() => {
  tabelas = {
    organizations: [{ id: ORG, settings: { dono: { whatsapp: WHATSAPP } } }],
    channel_sessions: [sessao(ORG)],
    contacts: [],
  };
  ops.length = 0;
  rpcs.length = 0;
  envios.length = 0;
  falhaNoEnvio = null;
  proximoId = 0;
});

describe("garantirConversaDoDono", () => {
  it("sem WhatsApp do Dono configurado → sem_whatsapp_do_dono, e não toca em contatos nem conversas", async () => {
    tabelas.organizations = [{ id: ORG, settings: { clinica: { redacao_clinica: true } } }];

    const r = await garantirConversaDoDono(adminFalso(), ORG);

    expect(r).toEqual({ ok: false, motivo: "sem_whatsapp_do_dono" });
    expect(insertsEm("contacts")).toEqual([]);
    expect(rpcs).toEqual([]);
  });

  it("sem sessão de canal WORKING → sem_canal, e não cria o contato", async () => {
    tabelas.channel_sessions = [sessao(ORG, { status: "STOPPED" }), sessao(ORG, { archived_at: "2026-01-01" })];

    const r = await garantirConversaDoDono(adminFalso(), ORG);

    expect(r).toEqual({ ok: false, motivo: "sem_canal" });
    expect(insertsEm("contacts")).toEqual([]);
    expect(rpcs).toEqual([]);
  });

  it("a sessão é da PRÓPRIA Conta: a WORKING de outra org não serve", async () => {
    tabelas.channel_sessions = [sessao(OUTRA)];
    const r = await garantirConversaDoDono(adminFalso(), ORG);
    expect(r).toEqual({ ok: false, motivo: "sem_canal" });
  });

  it("contato inexistente → cria 'Dono' com telefone canônico e source 'dono', e abre a conversa na sessão", async () => {
    const r = await garantirConversaDoDono(adminFalso(), ORG);

    const [contato] = insertsEm("contacts");
    expect(contato).toMatchObject({
      organization_id: ORG,
      display_name: "Dono",
      name: "Dono",
      phone_number: WHATSAPP,
      source: "dono",
    });

    expect(rpcs).toEqual([
      { fn: "fn_upsert_wa_conversation", args: { p_org: ORG, p_contact: "contacts-1", p_session: "sess-1111" } },
    ]);
    expect(r).toEqual({ ok: true, contactId: "contacts-1", conversationId: "conv-contacts-1", channelSessionId: "sess-1111" });
  });

  it("é idempotente: na segunda chamada reencontra o contato e não cria outro", async () => {
    const admin = adminFalso();
    const primeira = await garantirConversaDoDono(admin, ORG);
    const segunda = await garantirConversaDoDono(admin, ORG);

    expect(insertsEm("contacts")).toHaveLength(1);
    expect(segunda).toEqual(primeira);
  });

  it("reencontra o contato gravado com a outra grafia do número (sem o nono dígito)", async () => {
    tabelas.contacts = [{ id: "c-antigo", organization_id: ORG, phone_number: "+551199999999", is_merged_into: null }];

    const r = await garantirConversaDoDono(adminFalso(), ORG);

    expect(insertsEm("contacts")).toEqual([]);
    expect(r).toMatchObject({ ok: true, contactId: "c-antigo" });
  });

  it("um contato fundido não é o Dono: ignora e cria o vivo", async () => {
    tabelas.contacts = [{ id: "c-fundido", organization_id: ORG, phone_number: WHATSAPP, is_merged_into: "c-x" }];
    const r = await garantirConversaDoDono(adminFalso(), ORG);
    expect(insertsEm("contacts")).toHaveLength(1);
    expect(r).toMatchObject({ ok: true, contactId: "contacts-1" });
  });
});

describe("enviarAoDono", () => {
  it("manda pelo sendMessageHandler como ai_agent 'dono' com role manager, e a linha se declara", async () => {
    const r = await enviarAoDono(adminFalso(), ORG, "A rotina x não rodou.");

    expect(r).toEqual({ ok: true });
    expect(envios).toHaveLength(1);
    expect(envios[0]?.ctx).toEqual({
      organization_id: ORG,
      actor: { type: "ai_agent", id: "dono", role: "manager" },
      requestId: expect.stringMatching(/^dono-/),
    });
    expect(envios[0]?.input).toEqual({
      conversation_id: "conv-contacts-1",
      type: "text",
      body: "A rotina x não rodou.",
      metadata: { aviso_ao_dono: true },
    });
  });

  it("sem WhatsApp configurado → devolve o motivo e não chama o handler", async () => {
    tabelas.organizations = [{ id: ORG, settings: {} }];
    const r = await enviarAoDono(adminFalso(), ORG, "oi");
    expect(r).toEqual({ ok: false, motivo: "sem_whatsapp_do_dono" });
    expect(envios).toEqual([]);
  });

  it("NUNCA lança: handler que explode vira { ok: false, motivo: 'envio_falhou:…' }", async () => {
    falhaNoEnvio = Object.assign(new Error("canal caído"), { name: "ChannelDownError" });
    const r = await enviarAoDono(adminFalso(), ORG, "oi");
    expect(r).toEqual({ ok: false, motivo: "envio_falhou:ChannelDownError" });
  });

  it("NUNCA lança: banco que explode antes do envio também vira { ok: false }", async () => {
    const quebrado = {
      from: () => {
        throw new Error("banco fora");
      },
    } as unknown as SupabaseClient;
    const r = await enviarAoDono(quebrado, ORG, "oi");
    expect(r.ok).toBe(false);
    expect(envios).toEqual([]);
  });
});

describe("enviarAosDonos", () => {
  it("avisa cada Conta que tem WhatsApp do Dono e pula as outras, sem lançar", async () => {
    tabelas.organizations = [
      { id: ORG, settings: { dono: { whatsapp: WHATSAPP } } },
      { id: OUTRA, settings: {} },
    ];

    const r = await enviarAosDonos(adminFalso(), "Uma rotina não rodou.");

    expect(r).toEqual({ enviados: [ORG], pulados: [{ organizationId: OUTRA, motivo: "sem_whatsapp_do_dono" }] });
    expect(envios.map((e) => e.ctx.organization_id)).toEqual([ORG]);
  });
});
