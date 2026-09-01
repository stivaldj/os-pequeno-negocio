/**
 * Embedded Signup em Coexistência (ADR-0015): o popup da Meta devolve um
 * `code`; o servidor troca por token, assina o webhook na WABA e a sessão
 * nasce com a credencial cifrada — sem ninguém colar token à mão.
 *
 * Opcional por instalação: sem app da Meta declarado, o recurso não existe e
 * o BYO manual continua sendo o caminho.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assinarWebhookNaWaba,
  embeddedSignupDisponivel,
  trocarCodigoPorToken,
} from "@/lib/channels/meta/coexistencia/embedded-signup";

function stubFetch(resposta: unknown, ok = true, status = ok ? 200 : 400) {
  const spy = vi.fn().mockResolvedValue({ ok, status, json: async () => resposta });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const APP = { appId: "123", appSecret: "segredo", configId: "cfg-1" };

describe("disponibilidade", () => {
  it("só existe quando a instalação declara app, secret e config", () => {
    expect(embeddedSignupDisponivel({})).toBe(false);
    expect(embeddedSignupDisponivel({ META_APP_ID: "1", META_APP_SECRET: "2" })).toBe(false);
    expect(
      embeddedSignupDisponivel({ META_APP_ID: "1", META_APP_SECRET: "2", META_EMBEDDED_SIGNUP_CONFIG_ID: "3" }),
    ).toBe(true);
  });
});

describe("trocarCodigoPorToken", () => {
  it("chama oauth/access_token com client_id, client_secret e code, e devolve o token", async () => {
    const spy = stubFetch({ access_token: "tok_abc" });
    const r = await trocarCodigoPorToken("codigo-1", APP, "v22.0");
    expect(r).toEqual({ ok: true, token: "tok_abc" });
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain("https://graph.facebook.com/v22.0/oauth/access_token");
    expect(url).toContain("client_id=123");
    expect(url).toContain("client_secret=segredo");
    expect(url).toContain("code=codigo-1");
  });

  it("erro HTTP vira meta_oauth_failed com o motivo da Meta", async () => {
    stubFetch({ error: { message: "Invalid verification code" } }, false);
    const r = await trocarCodigoPorToken("x", APP, "v22.0");
    expect(r).toEqual({ ok: false, code: "meta_oauth_failed", motivo: "Invalid verification code" });
  });

  it("rede caída também é meta_oauth_failed, nunca exceção", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const r = await trocarCodigoPorToken("x", APP, "v22.0");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain("ECONNRESET");
  });
});

describe("assinarWebhookNaWaba", () => {
  it("faz POST em /<waba>/subscribed_apps com o token", async () => {
    const spy = stubFetch({ success: true });
    const r = await assinarWebhookNaWaba("tok", "waba-9", "v22.0");
    expect(r).toEqual({ ok: true });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v22.0/waba-9/subscribed_apps");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
  });

  it("recusa da Meta vira meta_subscribe_failed", async () => {
    stubFetch({ error: { message: "nope" } }, false);
    const r = await assinarWebhookNaWaba("tok", "waba-9", "v22.0");
    expect(r).toEqual({ ok: false, code: "meta_subscribe_failed", motivo: "nope" });
  });
});
