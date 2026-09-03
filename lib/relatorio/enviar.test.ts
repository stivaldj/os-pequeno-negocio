import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./janela", () => ({ janelaDoRelatorio: vi.fn() }));
vi.mock("./montar", () => ({ montarRelatorio: vi.fn() }));
vi.mock("@/lib/dono/destinatario", () => ({ enviarAoDono: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { janelaDoRelatorio } = await import("./janela");
const { montarRelatorio } = await import("./montar");
const { enviarAoDono } = await import("@/lib/dono/destinatario");
const { audit } = await import("@/lib/audit");
const { enviarRelatorioParaTodasAsContas } = await import("./enviar");

const RELATORIO = {
  organizationId: "org-1",
  hoje: "2026-09-03",
  atendimentos: { atendidos: 1, passadosParaHumano: 0, incompleto: false },
  agenda: { itens: [], incompleto: false },
  ads: { campanhas: [], gastoTotalCents: 0, sobraPorRealTotal: null, propostasPendentes: [], incompleto: false },
  financeiro: { caixaTotalCents: 0, vencemHojeCents: { payable: 0, receivable: 0 }, vencidasCents: { payable: 0, receivable: 0 }, vencemHojeItens: [], vencidasItens: [], incompleto: false },
  texto: "Relatório de 2026-09-03\n...",
  secoesIncompletas: [] as string[],
};

interface Insert {
  tabela: string;
  payload: Record<string, unknown>;
}

/** Dublê mínimo: `organizations` (select ativas) e `daily_reports` (maybeSingle + insert). */
function adminFalso(opts: { orgs: { id: string; settings: unknown }[]; jaEnviados: Set<string> }) {
  const inserts: Insert[] = [];
  const admin = {
    from(tabela: string) {
      if (tabela === "organizations") {
        return {
          select: () => ({
            eq: async () => ({ data: opts.orgs, error: null }),
          }),
        };
      }
      if (tabela === "daily_reports") {
        let orgFiltrada = "";
        return {
          select: () => ({
            eq: (col: string, val: string) => {
              if (col === "organization_id") orgFiltrada = val;
              return {
                eq: () => ({
                  maybeSingle: async () => ({
                    data: opts.jaEnviados.has(orgFiltrada) ? { id: "existente" } : null,
                    error: null,
                  }),
                }),
              };
            },
          }),
          insert: (payload: Record<string, unknown>) => {
            inserts.push({ tabela, payload });
            return { then: (ok: (v: unknown) => unknown) => ok({ error: null }) };
          },
        };
      }
      throw new Error(`tabela não dublada: ${tabela}`);
    },
  };
  return { admin: admin as never, inserts };
}

const AGORA = new Date("2026-09-03T11:00:00Z");

beforeEach(() => {
  vi.mocked(janelaDoRelatorio).mockResolvedValue({
    organizationId: "org-1",
    fuso: "America/Sao_Paulo",
    hoje: "2026-09-03",
    ontem: "2026-09-02",
    hojeInicioISO: "2026-09-03T03:00:00.000Z",
    hojeFimISO: "2026-09-04T03:00:00.000Z",
    ontemInicioISO: "2026-09-02T03:00:00.000Z",
  });
  vi.mocked(montarRelatorio).mockReset().mockResolvedValue(RELATORIO);
  vi.mocked(enviarAoDono).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(audit).mockClear();
});

describe("enviarRelatorioParaTodasAsContas", () => {
  it("só considera Contas ativas com WhatsApp do Dono configurado", async () => {
    const { admin } = adminFalso({
      orgs: [
        { id: "org-1", settings: { dono: { whatsapp: "+5511999999999" } } },
        { id: "org-2", settings: {} },
        { id: "org-3", settings: { dono: { whatsapp: "sem-mais-nem-menos" } } },
      ],
      jaEnviados: new Set(),
    });
    const r = await enviarRelatorioParaTodasAsContas(admin, AGORA);
    expect(r.contas).toBe(1);
    expect(r.enviados).toBe(1);
  });

  it("Conta já enviada hoje é pulada sem montar o relatório de novo nem chamar enviarAoDono", async () => {
    const { admin } = adminFalso({
      orgs: [{ id: "org-1", settings: { dono: { whatsapp: "+5511999999999" } } }],
      jaEnviados: new Set(["org-1"]),
    });
    const r = await enviarRelatorioParaTodasAsContas(admin, AGORA);
    expect(r.jaEnviadosHoje).toBe(1);
    expect(r.enviados).toBe(0);
    expect(montarRelatorio).not.toHaveBeenCalled();
    expect(enviarAoDono).not.toHaveBeenCalled();
  });

  it("falha de ENVIO não grava daily_reports — a rodada de amanhã tenta de novo", async () => {
    vi.mocked(enviarAoDono).mockResolvedValue({ ok: false, motivo: "sem_canal" });
    const { admin, inserts } = adminFalso({
      orgs: [{ id: "org-1", settings: { dono: { whatsapp: "+5511999999999" } } }],
      jaEnviados: new Set(),
    });
    const r = await enviarRelatorioParaTodasAsContas(admin, AGORA);
    expect(r.pulados).toBe(1);
    expect(inserts.filter((i) => i.tabela === "daily_reports")).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("envio com sucesso grava daily_reports com o texto e as seções incompletas, e audita", async () => {
    vi.mocked(montarRelatorio).mockResolvedValue({ ...RELATORIO, secoesIncompletas: ["ads"] });
    const { admin, inserts } = adminFalso({
      orgs: [{ id: "org-1", settings: { dono: { whatsapp: "+5511999999999" } } }],
      jaEnviados: new Set(),
    });
    const r = await enviarRelatorioParaTodasAsContas(admin, AGORA);
    expect(r.enviados).toBe(1);
    const gravado = inserts.find((i) => i.tabela === "daily_reports");
    expect(gravado?.payload).toMatchObject({
      organization_id: "org-1",
      report_date: "2026-09-03",
      status: "enviado",
      incomplete_sections: ["ads"],
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "relatorio.enviado", organizationId: "org-1" }));
  });

  it("uma Conta que lança não derruba as outras", async () => {
    vi.mocked(montarRelatorio).mockImplementation(async (_a, orgId) => {
      if (orgId === "org-1") throw new Error("boom");
      return RELATORIO;
    });
    const { admin } = adminFalso({
      orgs: [
        { id: "org-1", settings: { dono: { whatsapp: "+5511999999999" } } },
        { id: "org-2", settings: { dono: { whatsapp: "+5511888888888" } } },
      ],
      jaEnviados: new Set(),
    });
    const r = await enviarRelatorioParaTodasAsContas(admin, AGORA);
    expect(r.falhas).toBe(1);
    expect(r.enviados).toBe(1);
  });
});
