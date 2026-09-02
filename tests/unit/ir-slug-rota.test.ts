import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isPublicPath } from "@/lib/auth/public-paths";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/ads/captura", () => ({
  registrarClique: vi.fn(async (_a: unknown, c: { slug: string; gclid?: string | null }) =>
    c.slug === "consulta-abc1" ? { destino: `https://wa.me/5565999990001?text=Oi%20(ref%20X7K3MQ)&g=${c.gclid ?? ""}`, codigo: "X7K3MQ" } : { destino: null, codigo: null },
  ),
}));

const { GET } = await import("@/app/ir/[slug]/route");

describe("/ir/<slug>", () => {
  it("é público, e só um segmento", () => {
    expect(isPublicPath("/ir/consulta-abc1")).toBe(true);
    expect(isPublicPath("/ir/consulta-abc1/x")).toBe(false);
    expect(isPublicPath("/ir")).toBe(false);
  });

  it("redireciona 302 ao WhatsApp, sem cache e sem indexação", async () => {
    const res = await GET(new NextRequest("https://app.exemplo/ir/consulta-abc1?gclid=Cj0"), { params: Promise.resolve({ slug: "consulta-abc1" }) });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("wa.me/5565999990001");
    expect(res.headers.get("location")).toContain("g=Cj0");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("slug desconhecido responde 404 sem explicar", async () => {
    const res = await GET(new NextRequest("https://app.exemplo/ir/nao-existe"), { params: Promise.resolve({ slug: "nao-existe" }) });
    expect(res.status).toBe(404);
  });
});
