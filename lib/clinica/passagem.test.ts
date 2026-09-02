/**
 * Conteúdo Clínico provoca Passagem (ADR-0004): a conversa vai para humano
 * ANTES de qualquer despacho do Agente — despachar seria pedir a ele que
 * responda o que não pode ler.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { motivoDoAviso } from "@/lib/escalacao/aviso-ao-lead";
import { aplicarEfeitosPosEntrada } from "@/lib/channels/pos-entrada";
import { passarPorConteudoClinico } from "@/lib/clinica/passagem";

vi.mock("@/lib/ai/handoff/orchestrator", () => ({ triggerHandoff: vi.fn(async () => ({ triggered: true, reason: "ok" })) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({ garantirLeadDaConversa: vi.fn(async () => ({ criado: false, motivo: "teste" })) }));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({ acelerarPipelineDeEventos: vi.fn(async () => undefined) }));

const rpcs: { nome: string; args: unknown }[] = [];
const admin = {
  rpc: async (nome: string, args: unknown) => {
    rpcs.push({ nome, args });
    return { data: null, error: null };
  },
  from: () => ({ update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }),
} as never;

const ENTRADA = {
  organizationId: "org-1",
  contactId: "contact-1",
  conversationId: "conv-1",
  messageId: "msg-1",
  channelSessionId: "sess-1",
  nomeDoContato: null,
  origem: "fake_webhook",
};

beforeEach(() => {
  rpcs.length = 0;
  vi.mocked(triggerHandoff).mockClear();
});

describe("passarPorConteudoClinico", () => {
  it("chama triggerHandoff com clinical_mention e sem texto", async () => {
    await passarPorConteudoClinico({ organizationId: "org-1", conversationId: "conv-1", contactId: "contact-1" });
    expect(triggerHandoff).toHaveBeenCalledWith({
      organizationId: "org-1",
      conversationId: "conv-1",
      reason: "clinical_mention",
      metadata: { gatilho: "conteudo_clinico", contact_id: "contact-1" },
    });
  });

  it("o aviso ao Contato não diz por quê — cai em 'outro'", () => {
    expect(motivoDoAviso("clinical_mention")).toBe("outro");
  });
});

describe("aplicarEfeitosPosEntrada com redação", () => {
  it("passa para humano e NÃO pede despacho do Agente", async () => {
    await aplicarEfeitosPosEntrada(admin, { ...ENTRADA, texto: null, redigido: { motivo: "sintoma" } });
    expect(triggerHandoff).toHaveBeenCalledTimes(1);
    expect(rpcs.find((r) => r.nome === "emit_event")).toBeUndefined();
  });

  it("sem redação, pede despacho como sempre", async () => {
    await aplicarEfeitosPosEntrada(admin, { ...ENTRADA, texto: "oi", redigido: null });
    expect(triggerHandoff).not.toHaveBeenCalled();
    expect(rpcs.find((r) => r.nome === "emit_event")).toBeDefined();
  });
});
