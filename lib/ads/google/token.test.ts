import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONFIG, stubFetch, TOKEN_OK } from "./_duble.test-util";
import { accessToken, ENDERECO_DE_TOKEN, limparCacheDeToken } from "./token";

beforeEach(() => limparCacheDeToken());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("accessToken", () => {
  it("troca o refresh token no endpoint v3 com grant_type=refresh_token", async () => {
    const { chamadas } = stubFetch([TOKEN_OK]);
    const r = await accessToken(CONFIG);
    expect(r).toEqual({ ok: true, valor: "ya29.teste" });

    expect(chamadas).toHaveLength(1);
    const [c] = chamadas;
    expect(c!.url).toBe(ENDERECO_DE_TOKEN);
    expect(ENDERECO_DE_TOKEN).toBe("https://www.googleapis.com/oauth2/v3/token");
    expect(c!.metodo).toBe("POST");
    expect(c!.cabecalhos["content-type"]).toBe("application/x-www-form-urlencoded");
    const corpo = new URLSearchParams(String(c!.corpo));
    expect(corpo.get("grant_type")).toBe("refresh_token");
    expect(corpo.get("client_id")).toBe("client-id-teste");
    expect(corpo.get("client_secret")).toBe("client-secret-teste");
    expect(corpo.get("refresh_token")).toBe("refresh-token-teste");
  });

  it("cacheia até expires_in - 60s e renova depois", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T12:00:00Z"));
    const { spy } = stubFetch([
      TOKEN_OK,
      { corpo: { access_token: "ya29.renovado", expires_in: 3599 } },
    ]);

    expect(await accessToken(CONFIG)).toEqual({ ok: true, valor: "ya29.teste" });
    expect(await accessToken(CONFIG)).toEqual({ ok: true, valor: "ya29.teste" });
    expect(spy).toHaveBeenCalledTimes(1);

    // 3599 - 60 = 3539s: um segundo ANTES da folga ainda é cache.
    vi.setSystemTime(new Date("2026-09-02T12:58:58Z"));
    expect(await accessToken(CONFIG)).toEqual({ ok: true, valor: "ya29.teste" });
    expect(spy).toHaveBeenCalledTimes(1);

    // Na folga, renova.
    vi.setSystemTime(new Date("2026-09-02T12:59:00Z"));
    expect(await accessToken(CONFIG)).toEqual({ ok: true, valor: "ya29.renovado" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("limparCacheDeToken força nova troca", async () => {
    const { spy } = stubFetch([TOKEN_OK, TOKEN_OK]);
    await accessToken(CONFIG);
    limparCacheDeToken();
    await accessToken(CONFIG);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("refresh token revogado não lança: devolve { ok: false, code: 'token' } com o erro do Google", async () => {
    stubFetch([
      {
        status: 400,
        corpo: { error: "invalid_grant", error_description: "Token has been expired or revoked." },
      },
    ]);
    const r = await accessToken(CONFIG);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("token");
    expect(r.motivo).toMatch(/invalid_grant/);
    expect(r.motivo).toMatch(/GOOGLE_ADS_REFRESH_TOKEN/);
  });

  it("rede fora não lança: devolve { ok: false, code: 'rede' }", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const r = await accessToken(CONFIG);
    expect(r).toMatchObject({ ok: false, code: "rede" });
  });

  it("sem configuração devolve { ok: false, code: 'nao_configurado' }", async () => {
    const { spy } = stubFetch([]);
    const r = await accessToken(null);
    expect(r).toMatchObject({ ok: false, code: "nao_configurado" });
    expect(spy).not.toHaveBeenCalled();
  });
});
