import { beforeEach, describe, expect, it, vi } from "vitest";

const downloadMock = vi.fn();
const updateEqMock = vi.fn();
const messageRow = {
  id: "msg1",
  organization_id: "org1",
  type: "audio" as string,
  media_mime: "audio/ogg",
  media_storage_path: "org1/conv1/msg1.ogg",
  media_derived_status: null as string | null,
};

/**
 * O dublê PRECISA saber em que tabela está.
 *
 * A versão anterior devolvia `messageRow` para qualquer `from(...)` e encadeava
 * exatamente dois `.eq`. Isso a tornava frágil nos dois eixos: o worker passou a
 * consultar `ai_purpose_bindings` (com três filtros) e o stub quebrava no
 * terceiro `.eq` — falha que aparece como "status error" e aponta para o lugar
 * errado. O Proxy devolve o chain para qualquer filtro, e a linha vem por
 * tabela: mensagem para `messages`, NENHUM binding para `ai_purpose_bindings`
 * (o caso "ninguém configurou nada", que é o comportamento anterior que estes
 * casos existem para preservar).
 */
const bindingDeVisao: { provider: string; model_id: string; credential_id: string | null } | null = null;

// A Conta que o preparador clínico lê (`organizations.settings`). Sem bloco
// `clinica`, redação desligada — o comportamento dos casos herdados.
const orgRow: { settings: unknown } = { settings: {} };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha =
        tabela === "ai_purpose_bindings" ? bindingDeVisao : tabela === "organizations" ? orgRow : messageRow;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const terminais: any = {
        maybeSingle: async () => ({ data: linha, error: null }),
        single: async () => ({ data: linha, error: null }),
        update: (patch: Record<string, unknown>) => {
          updateEqMock(patch);
          return { eq: () => ({ eq: async () => ({ error: null }) }) };
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: linha ? [linha] : [], error: null }).then(resolve),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy(terminais, {
        get: (alvo, prop) =>
          prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain,
      });
      return chain;
    },
    storage: { from: () => ({ download: downloadMock }) },
  }),
}));

vi.mock("@/lib/messaging/media/derive", () => ({
  deriveMediaText: vi.fn(async () => "transcrição do áudio real"),
}));

// resolveOrgLlmConfig e generateText mockados: o worker precisa de credencial p/
// montar as deps, mas o teste não exercita rede.
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: vi.fn(async () => ({
    provider: "openai",
    apiKey: "sk-test",
    defaultModel: "gpt-5",
    params: {},
    enabledModels: [],
    orcamento: { modo: "off", tetoCents: 0, efetivoEm: null, limiarPct: 80 },
    orcamentoIndisponivelPorque: null,
  })),
}));

import { deriveMessageMedia } from "@/workers/media-derive-worker";
import { deriveMediaText } from "@/lib/messaging/media/derive";

function eventRow(attempts = 0) {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "media.derive_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts,
  };
}

describe("deriveMessageMedia", () => {
  beforeEach(() => {
    downloadMock.mockReset().mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
    updateEqMock.mockReset();
    messageRow.media_derived_status = null;
    messageRow.type = "audio";
    orgRow.settings = {};
    vi.mocked(deriveMediaText).mockReset().mockResolvedValue("transcrição do áudio real");
  });

  it("em Conta de saúde, transcrição com Conteúdo Clínico grava o marcador, não o texto (ADR-0019)", async () => {
    orgRow.settings = { clinica: { redacao_clinica: true } };
    vi.mocked(deriveMediaText).mockResolvedValue("tô com dor no peito e tomo losartana");
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("ok");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ media_derived_text: "[conteúdo clínico redigido]", media_derived_status: "ready" }),
    );
    const gravado = JSON.stringify(updateEqMock.mock.calls);
    expect(gravado).not.toContain("losartana");
    expect(gravado).not.toContain("dor no peito");
  });

  it("em Conta de saúde, transcrição sem Conteúdo Clínico passa íntegra", async () => {
    orgRow.settings = { clinica: { redacao_clinica: true } };
    vi.mocked(deriveMediaText).mockResolvedValue("quero marcar consulta na quinta");
    await deriveMessageMedia(eventRow());
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ media_derived_text: "quero marcar consulta na quinta", media_derived_status: "ready" }),
    );
  });

  it("baixa a mídia, deriva e grava ready", async () => {
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("ok");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ media_derived_text: "transcrição do áudio real", media_derived_status: "ready" }),
    );
  });

  it("pula se já derivado (idempotência)", async () => {
    messageRow.media_derived_status = "ready";
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("skipped");
    expect(deriveMediaText).not.toHaveBeenCalled();
  });

  it("tipo sem derivado (sticker) → skipped sem baixar", async () => {
    messageRow.type = "sticker";
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("skipped");
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("erro na derivação marca failed no último attempt", async () => {
    vi.mocked(deriveMediaText).mockRejectedValue(new Error("transcription_503"));
    const r = await deriveMessageMedia(eventRow(4));
    expect(r.status).toBe("error");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ media_derived_status: "failed" }),
    );
  });
});
