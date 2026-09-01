import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseMetaWebhook, type InboundMessageEvent } from "@/lib/channels/meta/webhook";

/**
 * Payloads REAIS capturados da WABA de teste em 2026-07-29 — um texto e uma nota de
 * voz, enviados de um celular de verdade. Mock escrito por quem escreve o parser
 * concorda com ele por construção; foi assim que a Fase 3a descobriu que
 * `parameter_format` só vem se pedido e que `quality_score` vem como objeto.
 */
const REAIS = JSON.parse(
  readFileSync("tests/fixtures/meta/inbound-webhooks.json", "utf8"),
) as Parameters<typeof parseMetaWebhook>[0][];

const inbound = (i: number) =>
  parseMetaWebhook(REAIS[i]!).filter(
    (e): e is InboundMessageEvent => e.kind === "inbound_message",
  );

describe("inbound real — texto", () => {
  it("extrai a mensagem, o remetente e o número NOSSO que recebeu", () => {
    const [e] = inbound(0);
    expect(e).toMatchObject({
      kind: "inbound_message",
      from: "553198966398",
      phoneNumberId: "1103328999528818",
      type: "text",
      text: "oi",
      profileName: "Contato Teste",
    });
  });

  it("o `wamid` vira a chave de idempotência", () => {
    const [e] = inbound(0);
    expect(e!.externalId).toMatch(/^wamid\./);
  });

  it("o timestamp vem em SEGUNDOS — tratá-lo como ms daria 1970", () => {
    const [e] = inbound(0);
    expect(e!.sentAt.getUTCFullYear()).toBe(2026);
  });

  it("texto não tem mídia", () => {
    expect(inbound(0)[0]!.media).toBeNull();
  });
});

describe("inbound real — nota de voz", () => {
  it("reconhece áudio e marca `voice`", () => {
    const [e] = inbound(1);
    expect(e!.type).toBe("audio");
    expect(e!.media).toMatchObject({ voice: true, mime: "audio/ogg; codecs=opus" });
  });

  it("a Meta manda URL PRONTA, não só o media_id", () => {
    // Eu tinha antecipado que viria só o id, exigindo outra chamada à Graph API.
    // Vem os dois — e a URL tem `ext=` de expiração, então baixe na hora.
    const [e] = inbound(1);
    expect(e!.media!.id).toBeTruthy();
    expect(e!.media!.url).toContain("lookaside.fbsbx.com");
  });

  it("nota de voz não tem `text`", () => {
    expect(inbound(1)[0]!.text).toBeNull();
  });
});

describe("o que separa inbound de status de entrega", () => {
  it("`messages[]` é do CONTATO; `statuses[]` é das NOSSAS", () => {
    // Os dois chegam no mesmo `field: "messages"`. Tratá-los no mesmo `if` faria um
    // mascarar o outro quando viessem juntos no mesmo payload.
    const misto = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba1",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "pn1" },
                contacts: [{ wa_id: "5531", profile: { name: "Ana" } }],
                messages: [{ id: "wamid.IN", from: "5531", timestamp: "1785342028", type: "text", text: { body: "oi" } }],
              },
            },
            {
              field: "messages",
              value: { statuses: [{ id: "wamid.OUT", status: "delivered", recipient_id: "5531" }] },
            },
          ],
        },
      ],
    });
    expect(misto.map((e) => e.kind)).toEqual(["inbound_message", "message_status"]);
  });
});

describe("payload capenga não vira linha meia-boca", () => {
  it("mensagem sem id é descartada", () => {
    const r = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w",
          changes: [{ field: "messages", value: { messages: [{ from: "5531", type: "text" }] } }],
        },
      ],
    });
    expect(r).toEqual([]);
  });

  it("mensagem sem remetente é descartada", () => {
    const r = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w",
          changes: [{ field: "messages", value: { messages: [{ id: "wamid.X", type: "text" }] } }],
        },
      ],
    });
    expect(r).toEqual([]);
  });

  it("tipo que não conhecemos ainda atravessa, sem mídia inventada", () => {
    // Sticker/location/contact chegam com formas próprias. Descartar seria perder
    // mensagem do cliente; inventar mídia seria pior.
    const [e] = parseMetaWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "w",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "pn1" },
                messages: [{ id: "wamid.S", from: "5531", timestamp: "1785342028", type: "location" }],
              },
            },
          ],
        },
      ],
    }) as InboundMessageEvent[];
    expect(e).toMatchObject({ type: "location", text: null, media: null });
  });
});

/**
 * Coexistência (ADR-0015): três campos que só chegam para número que entrou
 * por Embedded Signup com o app ainda ativo. Fixtures escritas a partir da
 * referência dos webhooks da Meta (lida em 01/09/2026), não capturadas —
 * quando o primeiro número real entrar, trocar pelas capturadas.
 */
import type { AppEchoEvent, AppStateSyncEvent, HistoryEvent } from "@/lib/channels/meta/webhook";

describe("coexistência — eco do app (smb_message_echoes)", () => {
  it("vira app_echo com o número NOSSO, o destinatário e o wamid", () => {
    const [e] = parseMetaWebhook(REAIS[2]!).filter((x): x is AppEchoEvent => x.kind === "app_echo");
    expect(e).toMatchObject({
      kind: "app_echo",
      wabaId: "2434045433735175",
      phoneNumberId: "1103328999528818",
      to: "553198966398",
      externalId: "wamid.ECO1",
      type: "text",
      text: "Bom dia! Aqui é a recepção.",
    });
    expect(e!.sentAt.getUTCFullYear()).toBe(2026);
  });
});

describe("coexistência — sincronização de contatos (smb_app_state_sync)", () => {
  it("lista só os contatos ADICIONADOS, com telefone em dígitos e nome", () => {
    const [e] = parseMetaWebhook(REAIS[3]!).filter((x): x is AppStateSyncEvent => x.kind === "app_state_sync");
    expect(e!.contacts).toEqual([{ phone: "553198966398", name: "Contato Teste" }]);
  });
});

describe("coexistência — histórico (history)", () => {
  it("cada mensagem sabe se foi nossa ou do contato, com o timestamp original", () => {
    const [e] = parseMetaWebhook(REAIS[4]!).filter((x): x is HistoryEvent => x.kind === "history");
    expect(e!.messages).toHaveLength(2);
    expect(e!.messages[0]).toMatchObject({ direction: "inbound", from: "553198966398", externalId: "wamid.HIST1", text: "quero marcar" });
    expect(e!.messages[1]).toMatchObject({ direction: "outbound", to: "553198966398", externalId: "wamid.HIST2", text: "claro, qual dia?" });
    expect(e!.messages[0]!.sentAt.toISOString()).toBe("2026-08-03T12:00:00.000Z");
  });
});
