/**
 * Histórico do app: até 6 meses de conversa que a recepção já teve. Entra com
 * o timestamp original, sem efeitos pós-entrada (não é mensagem nova: sem
 * follow-up, sem turno do Agente) e sem silenciar o Agente pelas saídas antigas.
 */
import { describe, expect, it } from "vitest";
import { importarHistoricoDoApp } from "@/lib/channels/meta/coexistencia/historico";
import { novoDuble } from "@/lib/channels/meta/coexistencia/duble-de-admin";
import type { HistoryEvent } from "@/lib/channels/meta/webhook";

const HIST: HistoryEvent = {
  kind: "history",
  wabaId: "w",
  phoneNumberId: "pn-1",
  chunk: { phase: 0, order: 1, progress: 100 },
  messages: [
    { direction: "inbound", externalId: "wamid.H1", from: "553198966398", to: "556540421817", sentAt: new Date("2026-08-03T12:00:00Z"), type: "text", text: "quero marcar" },
    { direction: "outbound", externalId: "wamid.H2", from: "556540421817", to: "553198966398", sentAt: new Date("2026-08-03T12:01:00Z"), type: "text", text: "claro, qual dia?" },
  ],
};
const SESSAO = { id: "sess-1", organizationId: "org-1" };

describe("importarHistoricoDoApp", () => {
  it("entrada e saída entram com sent_at original; nada de efeitos nem silêncio", async () => {
    const d = novoDuble();
    const r = await importarHistoricoDoApp(d.admin, HIST, SESSAO);
    expect(r).toEqual({ importadas: 2, duplicadas: 0 });
    const inserts = d.ops.filter((o) => o.tabela === "messages" && o.op === "insert").map((o) => o.payload as Record<string, unknown>);
    expect(inserts.map((i) => i.direction)).toEqual(["inbound", "outbound"]);
    expect(inserts[0]!.sent_at).toBe("2026-08-03T12:00:00.000Z");
    expect(inserts.every((i) => (i.metadata as Record<string, unknown>).origem === "history")).toBe(true);
    expect(d.ops.find((o) => o.tabela === "conversations" && o.op === "update")).toBeUndefined();
    // Sem efeitos pós-entrada: nenhum emit_event, nenhum job.
    expect(d.ops.find((o) => o.op === "emit_event")).toBeUndefined();
  });

  it("duplicata por external_id é contada, não é erro", async () => {
    const d = novoDuble();
    d.setInsertErro({ code: "23505", message: "dup" });
    const r = await importarHistoricoDoApp(d.admin, HIST, SESSAO);
    expect(r).toEqual({ importadas: 0, duplicadas: 2 });
  });
});
