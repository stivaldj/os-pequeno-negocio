/**
 * Embedded Signup em Coexistência (ADR-0015).
 *
 * O popup da Meta (SDK no navegador, `featureType: whatsapp_business_app_onboarding`)
 * devolve um `code` de uso único e, por `postMessage`, o `waba_id` e o
 * `phone_number_id` escolhidos. Aqui, no servidor: troca o código por token,
 * assina o app nos webhooks da WABA. Quem grava a sessão é `../conectar.ts`.
 *
 * Opcional por instalação (doutrina: Embedded Signup não cabe em self-host):
 * sem `META_APP_ID`, `META_APP_SECRET` e `META_EMBEDDED_SIGNUP_CONFIG_ID`, o
 * recurso não existe e a tela mostra só o formulário manual.
 */

export interface AppDaMeta {
  appId: string;
  appSecret: string;
  configId: string;
}

type Env = Record<string, string | undefined>;

export function appDaMetaDoAmbiente(env: Env = process.env): AppDaMeta | null {
  const appId = env.META_APP_ID?.trim();
  const appSecret = env.META_APP_SECRET?.trim();
  const configId = env.META_EMBEDDED_SIGNUP_CONFIG_ID?.trim();
  if (!appId || !appSecret || !configId) return null;
  return { appId, appSecret, configId };
}

export function embeddedSignupDisponivel(env: Env = process.env): boolean {
  return appDaMetaDoAmbiente(env) !== null;
}

export function versaoDaGraph(env: Env = process.env): string {
  return env.META_GRAPH_VERSION ?? "v22.0";
}

type ErroMeta = { error?: { message?: string; error_data?: { details?: string } } };

function motivoDe(body: ErroMeta, status: number): string {
  return body.error?.error_data?.details ?? body.error?.message ?? `http_${status}`;
}

export type TrocaDeCodigo =
  | { ok: true; token: string }
  | { ok: false; code: "meta_oauth_failed"; motivo: string };

export async function trocarCodigoPorToken(
  code: string,
  app: AppDaMeta,
  version: string = versaoDaGraph(),
): Promise<TrocaDeCodigo> {
  const params = new URLSearchParams({
    client_id: app.appId,
    client_secret: app.appSecret,
    code,
  });
  try {
    const res = await fetch(`https://graph.facebook.com/${version}/oauth/access_token?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as ErroMeta & { access_token?: string };
    if (!res.ok || body.error || !body.access_token) {
      return { ok: false, code: "meta_oauth_failed", motivo: motivoDe(body, res.status) };
    }
    return { ok: true, token: body.access_token };
  } catch (err) {
    const motivo = err instanceof Error ? err.message : "erro";
    return { ok: false, code: "meta_oauth_failed", motivo: `rede indisponível: ${motivo}` };
  }
}

export type AssinaturaDeWebhook =
  | { ok: true }
  | { ok: false; code: "meta_subscribe_failed"; motivo: string };

export async function assinarWebhookNaWaba(
  token: string,
  wabaId: string,
  version: string = versaoDaGraph(),
): Promise<AssinaturaDeWebhook> {
  try {
    const res = await fetch(`https://graph.facebook.com/${version}/${wabaId}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as ErroMeta & { success?: boolean };
    if (!res.ok || body.error) {
      return { ok: false, code: "meta_subscribe_failed", motivo: motivoDe(body, res.status) };
    }
    return { ok: true };
  } catch (err) {
    const motivo = err instanceof Error ? err.message : "erro";
    return { ok: false, code: "meta_subscribe_failed", motivo: `rede indisponível: ${motivo}` };
  }
}
