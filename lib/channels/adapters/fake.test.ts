/**
 * O adapter fake é um `ChannelAdapter` a mais — não um mock. Ele existe para
 * que toda prova local (Fases 3 a 7 da Spec 0003) corra pelo seam de canal
 * de verdade: registry, capabilities, cadeia `before_send`, ingest.
 *
 * Só fora de produção: em `NODE_ENV=production` o registry devolve `null` e
 * `getAdapter` lança, como para qualquer provider desconhecido.
 */
import { afterEach, describe, expect, it } from "vitest";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import { getAdapter } from "@/lib/channels";
import { fakeChannelAdapter } from "@/lib/channels/adapters/fake";
import { lerEnviados, limparCaixaFake } from "@/lib/channels/fake/caixa";
import { fakeChannelDisponivel } from "@/lib/channels/fake/registro";
import type { OutboundEnvelope } from "@/lib/channels/types";

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";

function envelope(over: Partial<OutboundEnvelope> = {}): OutboundEnvelope {
  return {
    organizationId: ORG_A,
    sessionRef: "fake-aaaaaaaa",
    to: "5565999990001",
    kind: "text",
    body: "olá",
    ...over,
  };
}

afterEach(() => {
  limparCaixaFake();
});

describe("fake_channel no registry", () => {
  it("é resolvido fora de produção", () => {
    expect(getAdapter("fake_channel").provider).toBe("fake_channel");
  });

  it("declara capabilities de canal sem restrição", () => {
    expect(capabilitiesOf("fake_channel")).toEqual({
      freeformOutsideWindow: true,
      requiresTemplates: false,
      canManageTemplates: false,
      banRisk: false,
      minIntervalMs: null,
      voiceNote: "server-convert",
      groups: "full",
      costPerMessage: false,
    });
  });

  it("em produção não existe — a decisão do registry é pura e diz não", () => {
    expect(fakeChannelDisponivel("production")).toBe(false);
    expect(fakeChannelDisponivel("test")).toBe(true);
    expect(fakeChannelDisponivel("development")).toBe(true);
    expect(fakeChannelDisponivel(undefined)).toBe(true);
  });
});

describe("fake_channel envia para uma caixa em memória", () => {
  it("externalId é determinístico e cresce por org", async () => {
    const a1 = await fakeChannelAdapter.send(envelope());
    const a2 = await fakeChannelAdapter.send(envelope({ body: "de novo" }));
    const b1 = await fakeChannelAdapter.send(envelope({ organizationId: ORG_B }));
    expect(a1.externalId).toBe(`fake:${ORG_A}:1`);
    expect(a2.externalId).toBe(`fake:${ORG_A}:2`);
    expect(b1.externalId).toBe(`fake:${ORG_B}:1`);
  });

  it("a caixa é lida por org e zerada por limparCaixaFake", async () => {
    await fakeChannelAdapter.send(envelope());
    await fakeChannelAdapter.send(envelope({ organizationId: ORG_B }));
    expect(lerEnviados(ORG_A)).toHaveLength(1);
    expect(lerEnviados(ORG_A)[0]?.envelope?.body).toBe("olá");
    expect(lerEnviados(ORG_B)).toHaveLength(1);
    limparCaixaFake();
    expect(lerEnviados(ORG_A)).toHaveLength(0);
  });

  it("depois de limpar, a numeração recomeça — determinismo entre execuções", async () => {
    await fakeChannelAdapter.send(envelope());
    limparCaixaFake();
    const r = await fakeChannelAdapter.send(envelope());
    expect(r.externalId).toBe(`fake:${ORG_A}:1`);
  });

  it("echoExternalIds devolve o próprio id", () => {
    expect(fakeChannelAdapter.echoExternalIds?.({ externalId: "fake:x:1", recipient: "1" })).toEqual([
      "fake:x:1",
    ]);
  });

  it("resolveRecipient normaliza telefone e aceita grupo", () => {
    expect(
      fakeChannelAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "+55 (65) 99999-0001",
        waIdentity: null,
      }),
    ).toBe("5565999990001");
    expect(
      fakeChannelAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: "grupo-1",
        phoneNumber: null,
        waIdentity: null,
      }),
    ).toBe("grupo-1");
    expect(
      fakeChannelAdapter.resolveRecipient({ isGroup: false, groupChatId: null, phoneNumber: null, waIdentity: null }),
    ).toBeNull();
  });

  it("está sempre configurado e sempre alcançável", async () => {
    expect(fakeChannelAdapter.isConfigured()).toBe(true);
    await expect(fakeChannelAdapter.checkHealth?.({ organizationId: ORG_A, sessionRef: "s" })).resolves.toEqual({
      reachable: true,
      status: "WORKING",
      detail: null,
    });
  });

  it("sendTemplate grava entrada com kind template", async () => {
    const r = await fakeChannelAdapter.sendTemplate?.({
      organizationId: ORG_A,
      sessionRef: "s",
      to: "5565999990001",
      name: "aviso",
      language: "pt_BR",
      values: { "1": "x" },
    });
    expect(r?.externalId).toBe(`fake:${ORG_A}:1`);
    expect(lerEnviados(ORG_A)[0]?.kind).toBe("template");
  });
});
