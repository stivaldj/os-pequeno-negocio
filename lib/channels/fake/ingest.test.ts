/**
 * Entrada do `fake_channel` pelo webhook genérico: corpo mínimo → contato,
 * conversa, mensagem, marca na conversa e efeitos pós-entrada — a MESMA cadeia
 * dos canais reais, para uma prova local exercitar o que produção exercita.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ingestFakeInbound } from "@/lib/channels/fake/ingest";
import { lerEnvelopeFake } from "@/lib/channels/fake/envelope";
import { acceptsInboundWebhook, handleInboundWebhook } from "@/lib/channels/inbound";

const ops: { tabela: string; op: string; payload?: unknown }[] = [];
let rpcResposta: Record<string, unknown> = {};
let insertErro: { code?: string; message: string } | null = null;

function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle" || prop === "single") {
          if (op === "select") return async () => ({ data: null, error: null });
          return async () =>
            insertErro ? { data: null, error: insertErro } : { data: { id: "msg-1" }, error: null };
        }
        if (prop === "then") {
          return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
        }
        return () => proxy;
      },
    },
  ) as Record<string, unknown>;
  ops.push({ tabela, op, payload });
  return proxy;
}

const admin = {
  rpc: async (nome: string, args: unknown) => {
    ops.push({ tabela: "rpc", op: nome, payload: args });
    const v = rpcResposta[nome];
    return v === null ? { data: null, error: { message: "falhou" } } : { data: v ?? null, error: null };
  },
  from: (tabela: string) => ({
    select: () => chain(tabela, "select"),
    insert: (payload: unknown) => chain(tabela, "insert", payload),
    update: (payload: unknown) => chain(tabela, "update", payload),
    upsert: (payload: unknown) => chain(tabela, "upsert", payload),
  }),
} as never;

const CORPO = { from: "5565999990001", text: "oi", external_id: "fake-in-1" };
const SESSAO = { id: "sess-1", organization_id: "org-1", provider: "fake_channel" };

beforeEach(() => {
  ops.length = 0;
  insertErro = null;
  rpcResposta = { fn_upsert_wa_contact: "contact-1", fn_upsert_wa_conversation: "conv-1" };
});

describe("envelope do fake", () => {
  it("aceita o corpo mínimo e recusa o que falta", () => {
    expect(lerEnvelopeFake(JSON.stringify(CORPO)).ok).toBe(true);
    const r = lerEnvelopeFake(JSON.stringify({ text: "oi" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toBe("contrato_violado");
    expect(lerEnvelopeFake("{").ok).toBe(false);
  });
});

describe("ingestFakeInbound grava a cadeia inteira", () => {
  it("contato → conversa → mensagem → marca → efeitos", async () => {
    const r = await ingestFakeInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      evento: { from: CORPO.from, text: CORPO.text, externalId: CORPO.external_id, sentAt: new Date("2026-09-02T10:00:00Z") },
    });
    expect(r.status).toBe("ingested");
    const rpcs = ops.filter((o) => o.tabela === "rpc").map((o) => o.op);
    expect(rpcs).toContain("fn_upsert_wa_contact");
    expect(rpcs).toContain("fn_upsert_wa_conversation");
    expect(rpcs).toContain("fn_mark_conversation_message");
    const contato = ops.find((o) => o.op === "fn_upsert_wa_contact")?.payload as Record<string, unknown>;
    expect(contato.p_org).toBe("org-1");
    expect(contato.p_phone).toBe("+5565999990001");
    const insert = ops.find((o) => o.tabela === "messages" && o.op === "insert")?.payload as Record<string, unknown>;
    expect(insert).toMatchObject({
      organization_id: "org-1",
      channel_session_id: "sess-1",
      contact_id: "contact-1",
      conversation_id: "conv-1",
      direction: "inbound",
      type: "text",
      body: "oi",
      external_id: "fake-in-1",
    });
  });

  it("23505 no insert é duplicata, não falha", async () => {
    insertErro = { code: "23505", message: "dup" };
    const r = await ingestFakeInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      evento: { from: CORPO.from, text: CORPO.text, externalId: CORPO.external_id, sentAt: new Date() },
    });
    expect(r.status).toBe("duplicate");
  });

  it("falha na RPC de contato devolve failed com o motivo", async () => {
    rpcResposta = { fn_upsert_wa_contact: null };
    const r = await ingestFakeInbound(admin, {
      organizationId: "org-1",
      channelSessionId: "sess-1",
      evento: { from: CORPO.from, text: CORPO.text, externalId: CORPO.external_id, sentAt: new Date() },
    });
    expect(r.status).toBe("failed");
  });
});

describe("pelo webhook genérico", () => {
  it("fake_channel é aceito pela rota genérica", () => {
    expect(acceptsInboundWebhook("fake_channel")).toBe(true);
    expect(acceptsInboundWebhook("waha")).toBe(false);
  });

  it("corpo válido é ingerido; corpo inválido é contrato_violado; JSON quebrado é invalid_json", async () => {
    const base = { session: SESSAO, headers: new Headers(), secret: "s".repeat(32) };
    const ok = await handleInboundWebhook(admin, { ...base, rawBody: JSON.stringify(CORPO) });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.body.status).toBe("ingested");

    const ruim = await handleInboundWebhook(admin, { ...base, rawBody: JSON.stringify({ text: "x" }) });
    expect(ruim.ok).toBe(false);
    if (!ruim.ok) expect(ruim.code).toBe("contrato_violado");

    const quebrado = await handleInboundWebhook(admin, { ...base, rawBody: "{" });
    expect(quebrado.ok).toBe(false);
    if (!quebrado.ok) expect(quebrado.code).toBe("invalid_json");
  });
});
