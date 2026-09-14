/**
 * POST /api/v1/channels/official/embedded-signup — o Número entra por
 * Coexistência (ADR-0015): código do popup → token → webhook assinado na WABA
 * → sessão gravada com `meta_coexistence = true` → audit. Sem app da Meta na
 * instalação, a rota não existe (404) e o BYO manual segue sendo o caminho.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/require-role";
import { audit } from "@/lib/audit";
import type { ActiveOrg, AuthUser } from "@/lib/auth/types";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
// Este teste isola o handler; autoridade de suporte é exercitada na suíte própria.
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/channels/meta/validate-credentials", () => ({
  validateMetaCredentials: vi.fn(async () => ({
    ok: true,
    displayPhoneNumber: "+55 65 4042-1817",
    verifiedName: "Clínica Humana",
    qualityRating: "GREEN",
  })),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: vi.fn(async () => "\\xdeadbeef") }));

const inserts: Record<string, unknown>[] = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => ({
      select: () => {
        const chain: Record<string, unknown> = {};
        chain.eq = () => chain;
        chain.is = () => chain;
        chain.maybeSingle = async () => ({ data: null, error: null });
        return chain;
      },
      insert: async (linha: Record<string, unknown>) => {
        inserts.push({ tabela, ...linha });
        return { error: null };
      },
    }),
  }),
}));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const usuario: AuthUser = {
  id: ANA,
  email: "ana@clinica.com.br",
  full_name: "Ana",
  avatar_url: null,
  is_platform_admin: false,
  idioma: "pt-BR" as const,
  organizations: [{ organization_id: ORG, organization_name: "Clínica", role: "admin" }],
};
const orgAtiva: ActiveOrg = { orgId: ORG, name: "Clínica", role: "admin" };

function pedido(body: unknown): NextRequest {
  return new NextRequest("https://crm.exemplo/api/v1/channels/official/embedded-signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function rotaComEnv(vars: Record<string, string>) {
  vi.resetModules();
  for (const k of ["META_APP_ID", "META_APP_SECRET", "META_EMBEDDED_SIGNUP_CONFIG_ID"]) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
  return import("@/app/api/v1/channels/official/embedded-signup/route");
}

const APP = { META_APP_ID: "123", META_APP_SECRET: "segredo", META_EMBEDDED_SIGNUP_CONFIG_ID: "cfg" };
const CORPO = { code: "codigo-do-popup", waba_id: "waba-9", phone_number_id: "pn-77777" };

function stubMeta() {
  const spy = vi.fn(async (url: string) => {
    if (String(url).includes("/oauth/access_token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "tok_do_signup" }) };
    }
    if (String(url).includes("/subscribed_apps")) {
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: "rota inesperada" } }) };
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: usuario, org: orgAtiva });
  vi.mocked(audit).mockClear();
  inserts.length = 0;
  vi.unstubAllGlobals();
});

describe("POST /api/v1/channels/official/embedded-signup", () => {
  it("sem app da Meta na instalação, a rota responde 404 embedded_signup_unavailable", async () => {
    const { POST } = await rotaComEnv({});
    const res = await POST(pedido(CORPO));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("embedded_signup_unavailable");
  });

  it("Zod recusa código vazio", async () => {
    const { POST } = await rotaComEnv(APP);
    const res = await POST(pedido({ ...CORPO, code: "" }));
    expect(res.status).toBe(422);
  });

  it("troca o código, assina o webhook, grava a sessão em coexistência e audita", async () => {
    const spy = stubMeta();
    const { POST } = await rotaComEnv(APP);
    const res = await POST(pedido(CORPO));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({ connected: true, displayName: "Clínica Humana", coexistence: true });

    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/oauth/access_token") && u.includes("code=codigo-do-popup"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/waba-9/subscribed_apps"))).toBe(true);

    const sessao = inserts.find((i) => i.tabela === "channel_sessions");
    expect(sessao).toMatchObject({
      organization_id: ORG,
      meta_phone_number_id: "pn-77777",
      meta_waba_id: "waba-9",
      meta_coexistence: true,
      meta_token_encrypted: "\\xdeadbeef",
    });
    expect(JSON.stringify(sessao)).not.toContain("tok_do_signup");

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channels.official.embedded_signup", organizationId: ORG, actorUserId: ANA }),
    );
  });

  it("recusa da Meta na troca do código vira 422 sem gravar nada", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "Invalid code" } }) })),
    );
    const { POST } = await rotaComEnv(APP);
    const res = await POST(pedido(CORPO));
    expect(res.status).toBe(422);
    expect(inserts).toHaveLength(0);
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/channels/official informa a disponibilidade", () => {
  it("embeddedSignup traz appId e configId, nunca o secret", async () => {
    vi.resetModules();
    for (const [k, v] of Object.entries(APP)) process.env[k] = v;
    const { GET } = await import("@/app/api/v1/channels/official/route");
    const res = await GET(new NextRequest("https://crm.exemplo/api/v1/channels/official"));
    const json = await res.json();
    expect(json.data.embeddedSignup).toEqual({ available: true, appId: "123", configId: "cfg" });
    expect(JSON.stringify(json)).not.toContain("segredo");
  });
});
