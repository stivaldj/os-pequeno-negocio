import { beforeEach, describe, expect, it, vi } from "vitest";
import { destinoDoWhatsApp, registrarClique } from "@/lib/ads/captura";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const inserts: Record<string, unknown>[] = [];
let link: Record<string, unknown> | null = { id: "l1", organization_id: "org-1", campaign_id: "111", whatsapp_e164: "+5565999990001", mensagem: "Olá! Quero marcar uma consulta.", active: true };
let erroInsert: { code?: string; message: string } | null = null;
const admin = {
  from: (t: string) => ({
    select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: t === "ad_capture_links" ? link : null, error: null }) }) }) }),
    insert: async (p: Record<string, unknown>) => {
      inserts.push(p);
      return { error: erroInsert };
    },
  }),
} as never;

beforeEach(() => {
  inserts.length = 0;
  erroInsert = null;
  link = { id: "l1", organization_id: "org-1", campaign_id: "111", whatsapp_e164: "+5565999990001", mensagem: "Olá! Quero marcar uma consulta.", active: true };
});

describe("registrarClique", () => {
  it("grava o clique com código novo e manda ao WhatsApp com a frase e o código", async () => {
    const r = await registrarClique(admin, { slug: "consulta-abc1", gclid: "Cj0KCQ", userAgent: "Mozilla" });
    expect(r.codigo).toMatch(/^[A-Z2-9]{6}$/);
    expect(inserts[0]).toMatchObject({ organization_id: "org-1", campaign_id: "111", link_id: "l1", gclid: "Cj0KCQ", code: r.codigo });
    expect(r.destino).toBe(`https://wa.me/5565999990001?text=${encodeURIComponent(`Olá! Quero marcar uma consulta. (ref ${r.codigo})`)}`);
  });

  it("slug desconhecido ou inativo: destino nulo, nada gravado", async () => {
    link = null;
    expect(await registrarClique(admin, { slug: "nao-existe" })).toEqual({ destino: null, codigo: null });
    expect(inserts).toHaveLength(0);
  });

  it("slug malformado nem consulta o banco", async () => {
    expect(await registrarClique(admin, { slug: "../x" })).toEqual({ destino: null, codigo: null });
    expect(inserts).toHaveLength(0);
  });

  it("gclid com lixo é descartado, o clique ainda é gravado", async () => {
    const r = await registrarClique(admin, { slug: "consulta-abc1", gclid: "<script>" });
    expect(inserts[0]).toMatchObject({ gclid: null });
    expect(r.destino).toContain("wa.me");
  });

  it("banco fora do ar: o paciente ainda vai ao WhatsApp, sem código", async () => {
    erroInsert = { code: "XX000", message: "boom" };
    const r = await registrarClique(admin, { slug: "consulta-abc1" });
    expect(r.codigo).toBeNull();
    expect(r.destino).toContain("wa.me/5565999990001");
  });

  it("destinoDoWhatsApp tira o + e codifica a frase", () => {
    expect(destinoDoWhatsApp("+55 65 99999-0001", "Oi", "X7K3MQ")).toBe("https://wa.me/5565999990001?text=Oi%20(ref%20X7K3MQ)");
  });
});
