/**
 * `fake_channel` — o adapter das provas locais.
 *
 * Copia a forma do `meta_cloud` sem o HTTP: envia para `lib/channels/fake/caixa.ts`
 * e recebe pelo webhook genérico (`lib/channels/fake/ingest.ts`). Registrado
 * só fora de produção (ver `lib/channels/index.ts`).
 */
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";
import { registrarEnvio, registrarTemplate } from "../fake/caixa";

function toE164Digits(raw: string): string {
  return raw.replace(/\D/g, "");
}

export const fakeChannelAdapter: ChannelAdapter = {
  provider: "fake_channel",

  resolveRecipient(input: RecipientInput): string | null {
    if (input.isGroup) return input.groupChatId ?? null;
    if (!input.phoneNumber) return null;
    const digits = toE164Digits(input.phoneNumber);
    return digits.length > 0 ? digits : null;
  },

  isConfigured(): boolean {
    return true;
  },

  async checkHealth(_input: ChannelTenantScope & { sessionRef: string }): Promise<ChannelHealth> {
    return { reachable: true, status: "WORKING", detail: null };
  },

  codes: {
    notConfigured: "fake_not_configured",
    sendFailed: "fake_send_failed",
    unknownError: "fake_unknown",
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    return { externalId: registrarEnvio(envelope.organizationId, envelope) };
  },

  echoExternalIds(input: { externalId: string; recipient: string }): string[] {
    return [input.externalId];
  },

  async sendTemplate(input): Promise<{ externalId: string | null }> {
    return {
      externalId: registrarTemplate({
        organizationId: input.organizationId,
        sessionRef: input.sessionRef,
        to: input.to,
        name: input.name,
        language: input.language,
        values: input.values,
      }),
    };
  },
};
