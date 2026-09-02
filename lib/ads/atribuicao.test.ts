/**
 * Consumir o Código de Clique é PRIMEIRO TOQUE, como a atribuição da Meta:
 * o clique vale uma vez, o contato é atribuído uma vez. Código desconhecido
 * nunca bloqueia a entrada; código reusado não sobrescreve nada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { consumirCodigoDeClique } from "@/lib/ads/atribuicao";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

type Op = { tabela: string; op: string; payload?: unknown; filtros: [string, unknown][] };
const ops: Op[] = [];
let clique: Record<string, unknown> | null = null;
let contato: Record<string, unknown> | null = { source_metadata: {} };
let erroNoClique: { message: string } | null = null;

function chain(tabela: string, op: string, payload?: unknown) {
  const registro: Op = { tabela, op, payload, filtros: [] };
  ops.push(registro);
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "maybeSingle") {
          return async () => {
            if (tabela === "ad_clicks") return { data: erroNoClique ? null : clique, error: erroNoClique };
            if (tabela === "contacts") return { data: contato, error: null };
            return { data: null, error: null };
          };
        }
        if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: null, error: null });
        return (...args: unknown[]) => {
          if (prop === "eq" || prop === "is") registro.filtros.push([`${String(prop)}:${String(args[0])}`, args[1]]);
          return proxy;
        };
      },
    },
  );
  return proxy;
}

const admin = {
  rpc: async (nome: string, args: unknown) => {
    ops.push({ tabela: "rpc", op: nome, payload: args, filtros: [] });
    return { data: null, error: null };
  },
  from: (tabela: string) => ({
    select: (cols: string) => chain(tabela, "select", cols),
    update: (payload: unknown) => chain(tabela, "update", payload),
  }),
} as never;

const ENTRADA = { organizationId: "org-1", contactId: "contact-1", codigo: "X7K3MQ" };
const CLIQUE_VALIDO = {
  id: "click-1",
  code: "X7K3MQ",
  link_id: "link-1",
  campaign_id: "123",
  campaign_name: "Cardio Setembro",
  gclid: "gclid-1",
  gbraid: null,
  wbraid: null,
  consumed_at: null,
};

const escritas = () => ops.filter((o) => o.op === "update" || o.tabela === "rpc");

beforeEach(() => {
  ops.length = 0;
  clique = null;
  contato = { source_metadata: {} };
  erroNoClique = null;
});

describe("consumirCodigoDeClique", () => {
  it("código inexistente → desconhecido, sem escrever nada", async () => {
    const r = await consumirCodigoDeClique(admin, ENTRADA);
    expect(r).toEqual({ status: "desconhecido" });
    expect(escritas()).toHaveLength(0);
    const leitura = ops.find((o) => o.tabela === "ad_clicks" && o.op === "select");
    expect(leitura?.filtros).toEqual(expect.arrayContaining([["eq:organization_id", "org-1"], ["eq:code", "X7K3MQ"]]));
  });

  it("código já consumido → reusado, sem tocar no clique nem no contato", async () => {
    clique = { ...CLIQUE_VALIDO, consumed_at: "2026-09-01T10:00:00Z", contact_id: "outro" };
    const r = await consumirCodigoDeClique(admin, ENTRADA);
    expect(r).toEqual({ status: "reusado" });
    expect(escritas()).toHaveLength(0);
  });

  it("contato já atribuído (primeiro toque) → ja_atribuido, sem tocar em nada", async () => {
    clique = CLIQUE_VALIDO;
    contato = { source_metadata: { ad_platform: "meta_ads", ad_source_id: "clid-1" } };
    const r = await consumirCodigoDeClique(admin, ENTRADA);
    expect(r).toEqual({ status: "ja_atribuido" });
    expect(escritas()).toHaveLength(0);
  });

  it("código válido → estampa o contato como google_ads e marca o clique consumido", async () => {
    clique = CLIQUE_VALIDO;
    const r = await consumirCodigoDeClique(admin, ENTRADA);
    expect(r).toEqual({ status: "atribuido" });

    const estampa = ops.find((o) => o.op === "fn_estampar_atribuicao_de_anuncio")?.payload as Record<string, unknown>;
    expect(estampa.p_contact).toBe("contact-1");
    expect(estampa.p_platform).toBe("google_ads");
    expect(estampa.p_metadata).toMatchObject({
      ad_platform: "google_ads",
      ad_source_id: "123",
      ad_title: "Cardio Setembro",
      ad_body: null,
      ad_source_url: null,
      ad_raw: { click_code: "X7K3MQ", gclid: "gclid-1", gbraid: null, wbraid: null, link_id: "link-1" },
    });

    const update = ops.find((o) => o.tabela === "ad_clicks" && o.op === "update");
    expect(update?.payload).toMatchObject({ contact_id: "contact-1", consumed_at: expect.any(String) });
    expect(update?.filtros).toEqual(
      expect.arrayContaining([["eq:organization_id", "org-1"], ["eq:code", "X7K3MQ"], ["is:consumed_at", null]]),
    );
  });

  it("clique sem nome de campanha → título nulo", async () => {
    clique = { ...CLIQUE_VALIDO, campaign_name: null };
    await consumirCodigoDeClique(admin, ENTRADA);
    const estampa = ops.find((o) => o.op === "fn_estampar_atribuicao_de_anuncio")?.payload as Record<string, unknown>;
    expect((estampa.p_metadata as Record<string, unknown>).ad_title).toBeNull();
  });

  it("falha ao ler o clique não lança: desconhecido, e nada é escrito", async () => {
    erroNoClique = { message: "boom" };
    await expect(consumirCodigoDeClique(admin, ENTRADA)).resolves.toEqual({ status: "desconhecido" });
    expect(escritas()).toHaveLength(0);
  });

  it("código vazio ou malformado não consulta o banco", async () => {
    await expect(consumirCodigoDeClique(admin, { ...ENTRADA, codigo: "" })).resolves.toEqual({ status: "desconhecido" });
    await expect(consumirCodigoDeClique(admin, { ...ENTRADA, codigo: "abc" })).resolves.toEqual({ status: "desconhecido" });
    expect(ops).toHaveLength(0);
  });
});
