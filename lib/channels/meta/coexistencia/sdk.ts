/**
 * O SDK JavaScript da Meta, do lado do navegador — só o que o botão de
 * Embedded Signup precisa saber dele.
 *
 * Mora em `lib/channels/` por dois motivos: a URL e a origem do popup nomeiam
 * o provider, e a catraca `pnpm lint:channels` não deixa isso em `components/`;
 * e o formato do `postMessage` é contrato da Meta, não da tela — quando mudar,
 * muda aqui, junto do resto da Coexistência.
 *
 * Referência: "Embedded Signup — implementation" da documentação do WhatsApp
 * Business Platform (fluxo com `sessionInfoVersion: "3"`).
 */

export const META_SDK_URL = "https://connect.facebook.net/en_US/sdk.js";
export const META_SDK_VERSION = "v22.0";

/** O popup do Embedded Signup responde por `postMessage` de qualquer host da Meta. */
const ORIGEM_DA_META = /(^|\.)facebook\.com$/;

export interface FbLoginResponse {
  authResponse?: { code?: string } | null;
  status?: string;
}

export interface FbLoginOptions {
  config_id: string;
  response_type: "code";
  override_default_response_type: boolean;
  extras: {
    setup: Record<string, never>;
    featureType: "whatsapp_business_app_onboarding";
    sessionInfoVersion: "3";
  };
}

/** O pedaço do objeto global `FB` que usamos. */
export interface FbSdk {
  init(opts: { appId: string; version: string; xfbml?: boolean; cookie?: boolean }): void;
  login(callback: (response: FbLoginResponse) => void, options: FbLoginOptions): void;
}

export type EventoEmbeddedSignup =
  | { kind: "finish"; wabaId: string; phoneNumberId: string }
  | { kind: "cancel"; step: string | null }
  | { kind: "error"; message: string | null };

/**
 * Lê uma mensagem `postMessage` e devolve o evento do Embedded Signup, ou
 * `null` quando não é dele (outra origem, outro formato, outro tipo).
 *
 * `FINISH_ONLY_WABA` é o caso em que a pessoa criou a WABA mas não escolheu
 * número: sem `phone_number_id` não há o que conectar, então cai em `null` e o
 * callback do login decide o que dizer.
 */
export function lerEventoEmbeddedSignup(origin: string, data: unknown): EventoEmbeddedSignup | null {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (!ORIGEM_DA_META.test(host)) return null;
  if (typeof data !== "string") return null;

  let corpo: unknown;
  try {
    corpo = JSON.parse(data);
  } catch {
    return null;
  }
  if (!corpo || typeof corpo !== "object") return null;
  const m = corpo as {
    type?: unknown;
    event?: unknown;
    data?: { waba_id?: unknown; phone_number_id?: unknown; current_step?: unknown; error_message?: unknown };
  };
  if (m.type !== "WA_EMBEDDED_SIGNUP") return null;

  if (m.event === "FINISH" || m.event === "FINISH_ONLY_WABA") {
    const wabaId = m.data?.waba_id;
    const phoneNumberId = m.data?.phone_number_id;
    if (typeof wabaId !== "string" || typeof phoneNumberId !== "string") return null;
    return { kind: "finish", wabaId, phoneNumberId };
  }
  if (m.event === "CANCEL") {
    return { kind: "cancel", step: typeof m.data?.current_step === "string" ? m.data.current_step : null };
  }
  if (m.event === "ERROR") {
    return {
      kind: "error",
      message: typeof m.data?.error_message === "string" ? m.data.error_message : null,
    };
  }
  return null;
}
