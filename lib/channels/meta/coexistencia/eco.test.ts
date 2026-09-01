/**
 * Eco do app (ADR-0014/0015): a recepção respondeu pelo WhatsApp Business no
 * telefone. A mensagem entra na Conversa como saída humana, e o Agente se cala
 * por um intervalo — duas superfícies escrevem no mesmo Número, e o sistema
 * precisa saber que alguém já está falando.
 */
import { describe, expect, it } from "vitest";
import { ingerirEcoDoApp } from "@/lib/channels/meta/coexistencia/eco";
import { novoDuble } from "@/lib/channels/meta/coexistencia/duble-de-admin";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import type { AppEchoEvent } from "@/lib/channels/meta/webhook";

const ECO: AppEchoEvent = {
  kind: "app_echo",
  wabaId: "waba",
  phoneNumberId: "pn-1",
  externalId: "wamid.ECO1",
  to: "553198966398",
  sentAt: new Date("2026-09-02T10:00:00Z"),
  type: "text",
  text: "Bom dia! Aqui é a recepção.",
};
const SESSAO = { id: "sess-1", organizationId: "org-1" };
const AGORA = new Date("2026-09-02T10:00:05Z");

describe("ingerirEcoDoApp", () => {
  it("grava a mensagem como SAÍDA vinda do app e marca a conversa", async () => {
    const d = novoDuble();
    const r = await ingerirEcoDoApp(d.admin, ECO, SESSAO, { silencioMinutos: 10, agora: AGORA });
    expect(r.status).toBe("ingested");
    const insert = d.ops.find((o) => o.tabela === "messages" && o.op === "insert")?.payload as Record<string, unknown>;
    expect(insert).toMatchObject({
      organization_id: "org-1",
      channel_session_id: "sess-1",
      contact_id: "contact-1",
      conversation_id: "conv-1",
      direction: "outbound",
      status: "delivered",
      external_id: "wamid.ECO1",
      body: "Bom dia! Aqui é a recepção.",
      metadata: { origem: "app" },
    });
    const marca = d.ops.find((o) => o.op === "fn_mark_conversation_message")?.payload as Record<string, unknown>;
    expect(marca.p_direction).toBe("outbound");
  });

  it("silencia o Agente até agora + intervalo", async () => {
    const d = novoDuble();
    await ingerirEcoDoApp(d.admin, ECO, SESSAO, { silencioMinutos: 10, agora: AGORA });
    const upd = d.ops.find((o) => o.tabela === "conversations" && o.op === "update");
    expect(upd?.payload).toEqual({ bot_silenced_until: "2026-09-02T10:10:05.000Z" });
    expect(upd?.filtros).toContainEqual(["id", "conv-1"]);
    expect(upd?.filtros).toContainEqual(["organization_id", "org-1"]);
  });

  it("com silenciar: false (histórico) não toca em bot_silenced_until", async () => {
    const d = novoDuble();
    await ingerirEcoDoApp(d.admin, ECO, SESSAO, { silencioMinutos: 10, agora: AGORA, silenciar: false });
    expect(d.ops.find((o) => o.tabela === "conversations" && o.op === "update")).toBeUndefined();
  });

  it("23505 é duplicata e não silencia de novo", async () => {
    const d = novoDuble();
    d.setInsertErro({ code: "23505", message: "dup" });
    const r = await ingerirEcoDoApp(d.admin, ECO, SESSAO, { silencioMinutos: 10, agora: AGORA });
    expect(r.status).toBe("duplicate");
    expect(d.ops.find((o) => o.tabela === "conversations" && o.op === "update")).toBeUndefined();
  });

  it("contato inexistente nasce pelas mesmas RPCs do ingest", async () => {
    const d = novoDuble();
    await ingerirEcoDoApp(d.admin, ECO, SESSAO, { silencioMinutos: 10, agora: AGORA });
    const contato = d.ops.find((o) => o.op === "fn_upsert_wa_contact")?.payload as Record<string, unknown>;
    expect(contato).toMatchObject({ p_org: "org-1", p_phone: canonicalPhoneBR("+553198966398"), p_chat_id: "553198966398" });
  });
});
