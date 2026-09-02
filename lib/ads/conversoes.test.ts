import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A conversão offline: a consulta paga (ADR-0017) volta ao Google pelo clique
 * que a trouxe. Este teste dirige `subirConversoesDevidas` com um dublê de
 * admin encadeável (a forma de `lib/channels/meta/coexistencia/duble-de-admin.ts`)
 * e o cliente REST dublado — nada sai para a rede.
 *
 * O que ele prova, ramo a ramo:
 * - elegível = `completed` + `paid_cents` + contato com gclid/gbraid/wbraid em
 *   `source_metadata.ad_raw` + sem linha em `ad_conversion_uploads`;
 * - a linha vai com `orderId` = id do agendamento, valor em reais, moeda da
 *   Conta e `conversionDateTime` no fuso do agendamento;
 * - `enviada` para ok E para `ORDER_ID_ALREADY_IN_USE` / `CLICK_CONVERSION_ALREADY_EXISTS`
 *   (o Google já tem — não há o que reenviar);
 * - `falhou` com o erro para o resto; `TOO_RECENT_EVENT` NÃO grava (amanhã);
 * - Conta sem `conversion_action` → `ignorada` com motivo, uma vez;
 * - chamada inteira falhando → `last_error` na Conta e audit `ads.sync_falhou`;
 * - audit `ads.conversion_uploaded` só quando enviou;
 * - toda query filtra `organization_id` (o admin bypassa RLS).
 */

interface Op {
  tabela: string;
  op: string;
  payload?: unknown;
  filtros: [string, unknown[]][];
}

const ops: Op[] = [];
const auditados: Record<string, unknown>[] = [];
let linhas: Record<string, unknown[]>;

vi.mock("@/lib/audit", () => ({
  audit: async (entrada: Record<string, unknown>) => {
    auditados.push(entrada);
  },
}));

const subirConversoes = vi.fn();
vi.mock("@/lib/ads/google/conversoes", async () => {
  const real = await vi.importActual<Record<string, unknown>>("@/lib/ads/google/conversoes");
  return { ...real, subirConversoes: (...args: unknown[]) => subirConversoes(...args) };
});

import { subirConversoesDevidas } from "./conversoes";

/** Dublê encadeável: responde as linhas programadas por tabela e registra cada operação. */
function novoDuble() {
  function chain(tabela: string, op: string, payload?: unknown): Record<string, unknown> {
    const registro: Op = { tabela, op, payload, filtros: [] };
    ops.push(registro);
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (ok: (v: unknown) => unknown) =>
              ok({ data: op === "select" ? (linhas[tabela] ?? []) : null, error: null });
          }
          return (...args: unknown[]) => {
            registro.filtros.push([String(prop), args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  return {
    from: (tabela: string) => ({
      select: () => chain(tabela, "select"),
      insert: (payload: unknown) => chain(tabela, "insert", payload),
      update: (payload: unknown) => chain(tabela, "update", payload),
    }),
  } as never;
}

const AGORA = new Date("2026-09-02T06:40:00.000Z");
const ORG = "org-1";
const CONTA = {
  id: "conta-1",
  organization_id: ORG,
  customer_id: "1234567890",
  conversion_customer_id: null,
  conversion_action: "customers/1234567890/conversionActions/99",
  currency: "BRL",
};

function agendamento(id: string, contactId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: ORG,
    contact_id: contactId,
    paid_cents: 25000,
    starts_at: "2026-09-01T13:30:00.000Z",
    time_zone: "America/Sao_Paulo",
    ...extra,
  };
}

function contato(id: string, adRaw: Record<string, unknown> | null) {
  return { id, source_metadata: adRaw ? { ad_platform: "google_ads", ad_raw: adRaw } : {} };
}

const inserts = (tabela: string) =>
  ops.filter((o) => o.tabela === tabela && o.op === "insert").flatMap((o) => o.payload as Record<string, unknown>[]);

beforeEach(() => {
  ops.length = 0;
  auditados.length = 0;
  subirConversoes.mockReset();
  linhas = { ad_accounts: [CONTA], calendar_appointments: [], contacts: [], ad_conversion_uploads: [] };
});

describe("subirConversoesDevidas — quem é elegível", () => {
  it("sobe a consulta paga cujo contato veio de um clique, com orderId = id, valor em reais e o fuso do agendamento", async () => {
    linhas.calendar_appointments = [agendamento("ag-1", "c-1")];
    linhas.contacts = [contato("c-1", { gclid: "Cj0KCQ" })];
    subirConversoes.mockResolvedValue({ ok: true, valor: [{ ok: true }] });

    const r = await subirConversoesDevidas(novoDuble(), { agora: AGORA });

    expect(subirConversoes).toHaveBeenCalledTimes(1);
    const [cid, enviadas] = subirConversoes.mock.calls[0]!;
    expect(cid).toBe("1234567890");
    expect(enviadas).toEqual([
      {
        gclid: "Cj0KCQ",
        gbraid: null,
        wbraid: null,
        conversionAction: CONTA.conversion_action,
        // 13:30Z em São Paulo (-03:00) é 10:30 local.
        conversionDateTime: "2026-09-01 10:30:00-03:00",
        conversionValue: 250,
        currencyCode: "BRL",
        orderId: "ag-1",
      },
    ]);
    expect(inserts("ad_conversion_uploads")).toEqual([
      expect.objectContaining({
        organization_id: ORG,
        appointment_id: "ag-1",
        gclid: "Cj0KCQ",
        conversion_value_cents: 25000,
        status: "enviada",
        error: null,
        uploaded_at: AGORA.toISOString(),
      }),
    ]);
    expect(r).toEqual({ contas: 1, elegiveis: 1, enviadas: 1, falhas: 0, ignoradas: 0, adiadas: 0 });
  });

  it("usa a conversion_customer_id quando a Conta tem uma, e a moeda da Conta", async () => {
    linhas.ad_accounts = [{ ...CONTA, conversion_customer_id: "9876543210", currency: "USD" }];
    linhas.calendar_appointments = [agendamento("ag-1", "c-1")];
    linhas.contacts = [contato("c-1", { wbraid: "wb-1" })];
    subirConversoes.mockResolvedValue({ ok: true, valor: [{ ok: true }] });

    await subirConversoesDevidas(novoDuble(), { agora: AGORA });

    const [cid, enviadas] = subirConversoes.mock.calls[0]!;
    expect(cid).toBe("9876543210");
    expect(enviadas[0]).toMatchObject({ wbraid: "wb-1", gclid: null, currencyCode: "USD" });
  });

  it("ignora contato sem identificador de clique e agendamento que já tem linha de upload", async () => {
    linhas.calendar_appointments = [agendamento("ag-1", "c-1"), agendamento("ag-2", "c-2"), agendamento("ag-3", "c-3")];
    linhas.contacts = [contato("c-1", { gclid: "g-1" }), contato("c-2", null), contato("c-3", { gclid: "g-3" })];
    linhas.ad_conversion_uploads = [{ appointment_id: "ag-3" }];
    subirConversoes.mockResolvedValue({ ok: true, valor: [{ ok: true }] });

    const r = await subirConversoesDevidas(novoDuble(), { agora: AGORA });

    const [, enviadas] = subirConversoes.mock.calls[0]!;
    expect(enviadas.map((l: { orderId: string }) => l.orderId)).toEqual(["ag-1"]);
    expect(r.elegiveis).toBe(1);
  });

  it("sem elegível não chama o Google, não grava e não audita", async () => {
    const r = await subirConversoesDevidas(novoDuble(), { agora: AGORA });
    expect(subirConversoes).not.toHaveBeenCalled();
    expect(inserts("ad_conversion_uploads")).toEqual([]);
    expect(auditados).toEqual([]);
    expect(r).toEqual({ contas: 1, elegiveis: 0, enviadas: 0, falhas: 0, ignoradas: 0, adiadas: 0 });
  });

  it("respeita o limite por rodada", async () => {
    linhas.calendar_appointments = [agendamento("ag-1", "c-1"), agendamento("ag-2", "c-1"), agendamento("ag-3", "c-1")];
    linhas.contacts = [contato("c-1", { gclid: "g-1" })];
    subirConversoes.mockResolvedValue({ ok: true, valor: [{ ok: true }, { ok: true }] });

    const r = await subirConversoesDevidas(novoDuble(), { agora: AGORA, limite: 2 });

    expect(subirConversoes.mock.calls[0]![1]).toHaveLength(2);
    expect(r.elegiveis).toBe(2);
  });

  it("toda query filtra organization_id (o admin bypassa RLS)", async () => {
    linhas.calendar_appointments = [agendamento("ag-1", "c-1")];
    linhas.contacts = [contato("c-1", { gclid: "g-1" })];
    subirConversoes.mockResolvedValue({ ok: true, valor: [{ ok: true }] });

    await subirConversoesDevidas(novoDuble(), { agora: AGORA });

    const porOrg = ops.filter((o) => o.tabela !== "ad_accounts");
    expect(porOrg.map((o) => o.tabela)).toEqual(
      expect.arrayContaining(["calendar_appointments", "contacts", "ad_conversion_uploads"]),
    );
    for (const o of porOrg) {
      const filtraOrg =
        o.filtros.some(([f, args]) => f === "eq" && args[0] === "organization_id" && args[1] === ORG) ||
        (o.op === "insert" && (o.payload as { organization_id: string }[]).every((p) => p.organization_id === ORG));
      expect(filtraOrg, `${o.op} em ${o.tabela} sem organization_id`).toBe(true);
    }
  });
});

describe("subirConversoesDevidas — o resultado por linha", () => {
  beforeEach(() => {
    linhas.calendar_appointments = [
      agendamento("ag-1", "c-1"),
      agendamento("ag-2", "c-2"),
      agendamento("ag-3", "c-3"),
      agendamento("ag-4", "c-4"),
      agendamento("ag-5", "c-5"),
    ];
    linhas.contacts = ["c-1", "c-2", "c-3", "c-4", "c-5"].map((c) => contato(c, { gclid: `g-${c}` }));
  });

  it("enviada para ok e para o que o Google já tinha; falhou com o erro; TOO_RECENT_EVENT não grava", async () => {
    subirConversoes.mockResolvedValue({
      ok: true,
      valor: [
        { ok: true },
        { ok: false, erro: "ORDER_ID_ALREADY_IN_USE" },
        { ok: false, erro: "CLICK_CONVERSION_ALREADY_EXISTS" },
        { ok: false, erro: "EXPIRED_EVENT" },
        { ok: false, erro: "TOO_RECENT_EVENT" },
      ],
    });

    const r = await subirConversoesDevidas(novoDuble(), { agora: AGORA });

    const gravadas = inserts("ad_conversion_uploads").map((l) => [l.appointment_id, l.status, l.error]);
    expect(gravadas).toEqual([
      ["ag-1", "enviada", null],
      ["ag-2", "enviada", null],
      ["ag-3", "enviada", null],
      ["ag-4", "falhou", "EXPIRED_EVENT"],
    ]);
    expect(r).toEqual({ contas: 1, elegiveis: 5, enviadas: 3, falhas: 1, ignoradas: 0, adiadas: 1 });

    expect(auditados).toHaveLength(1);
    expect(auditados[0]).toMatchObject({
      action: "ads.conversion_uploaded",
      organizationId: ORG,
      bypassedRls: true,
      metadata: { enviadas: 3, falhas: 1, ignoradas: 0 },
    });
  });

  it("só falhas não audita conversion_uploaded", async () => {
    subirConversoes.mockResolvedValue({
      ok: true,
      valor: [1, 2, 3, 4, 5].map(() => ({ ok: false, erro: "EXPIRED_EVENT" })),
    });

    const r = await subirConversoesDevidas(novoDuble(), { agora: AGORA });

    expect(r.falhas).toBe(5);
    expect(auditados).toEqual([]);
  });

  it("a chamada inteira falhando grava last_error na Conta, audita ads.sync_falhou e não grava linha", async () => {
    subirConversoes.mockResolvedValue({ ok: false, code: "http", motivo: "HTTP 500" });

    const r = await subirConversoesDevidas(novoDuble(), { agora: AGORA });

    expect(inserts("ad_conversion_uploads")).toEqual([]);
    const update = ops.find((o) => o.tabela === "ad_accounts" && o.op === "update");
    expect(update?.payload).toMatchObject({ last_error: expect.stringContaining("HTTP 500") });
    expect(update?.filtros).toEqual(
      expect.arrayContaining([
        ["eq", ["id", "conta-1"]],
        ["eq", ["organization_id", ORG]],
      ]),
    );
    expect(auditados).toEqual([
      expect.objectContaining({ action: "ads.sync_falhou", organizationId: ORG }),
    ]);
    expect(r).toEqual({ contas: 1, elegiveis: 5, enviadas: 0, falhas: 0, ignoradas: 0, adiadas: 0 });
  });
});

describe("subirConversoesDevidas — Conta sem conversion_action", () => {
  it("grava ignorada com o motivo para cada elegível, sem chamar o Google e sem auditar", async () => {
    linhas.ad_accounts = [{ ...CONTA, conversion_action: null }];
    linhas.calendar_appointments = [agendamento("ag-1", "c-1"), agendamento("ag-2", "c-1")];
    linhas.contacts = [contato("c-1", { gclid: "g-1" })];

    const r = await subirConversoesDevidas(novoDuble(), { agora: AGORA });

    expect(subirConversoes).not.toHaveBeenCalled();
    expect(inserts("ad_conversion_uploads")).toEqual([
      expect.objectContaining({ appointment_id: "ag-1", status: "ignorada", error: "sem_conversion_action", uploaded_at: null }),
      expect.objectContaining({ appointment_id: "ag-2", status: "ignorada", error: "sem_conversion_action", uploaded_at: null }),
    ]);
    expect(auditados).toEqual([]);
    expect(r).toEqual({ contas: 1, elegiveis: 2, enviadas: 0, falhas: 0, ignoradas: 2, adiadas: 0 });
  });
});

describe("subirConversoesDevidas — as Contas", () => {
  it("só olha Contas ativas e roda cada uma na sua organização", async () => {
    linhas.ad_accounts = [CONTA, { ...CONTA, id: "conta-2", organization_id: "org-2" }];
    subirConversoes.mockResolvedValue({ ok: true, valor: [] });

    const r = await subirConversoesDevidas(novoDuble(), { agora: AGORA });

    const contas = ops.find((o) => o.tabela === "ad_accounts" && o.op === "select");
    expect(contas?.filtros).toEqual(expect.arrayContaining([["eq", ["status", "active"]]]));
    const orgs = ops.filter((o) => o.tabela === "calendar_appointments").map((o) => o.filtros.find(([f, a]) => f === "eq" && a[0] === "organization_id")?.[1][1]);
    expect(orgs).toEqual([ORG, "org-2"]);
    expect(r.contas).toBe(2);
  });
});
