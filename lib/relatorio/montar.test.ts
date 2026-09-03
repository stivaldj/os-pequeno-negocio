import { describe, expect, it, vi } from "vitest";

import type { SecaoAds, SecaoAgenda, SecaoAtendimentos, SecaoFinanceiro } from "./tipos";

vi.mock("./atendimentos", () => ({ atendimentosDaNoite: vi.fn() }));
vi.mock("./agenda", () => ({ agendaDeHoje: vi.fn() }));
vi.mock("./ads", () => ({ adsDeOntem: vi.fn() }));
vi.mock("./financeiro", () => ({ financeiroDeHoje: vi.fn() }));

const { atendimentosDaNoite } = await import("./atendimentos");
const { agendaDeHoje } = await import("./agenda");
const { adsDeOntem } = await import("./ads");
const { financeiroDeHoje } = await import("./financeiro");
const { montarRelatorio } = await import("./montar");

const COMPLETO: {
  atendimentos: SecaoAtendimentos;
  agenda: SecaoAgenda;
  ads: SecaoAds;
  financeiro: SecaoFinanceiro;
} = {
  atendimentos: { atendidos: 5, passadosParaHumano: 1, incompleto: false },
  agenda: { itens: [], incompleto: false },
  ads: { campanhas: [], gastoTotalCents: 0, sobraPorRealTotal: null, propostasPendentes: [], incompleto: false },
  financeiro: { caixaTotalCents: 100_000, vencemHojeCents: { payable: 0, receivable: 0 }, vencidasCents: { payable: 0, receivable: 0 }, vencemHojeItens: [], vencidasItens: [], incompleto: false },
};

function programar(partes: Partial<typeof COMPLETO> = {}) {
  const p = { ...COMPLETO, ...partes };
  vi.mocked(atendimentosDaNoite).mockResolvedValue(p.atendimentos);
  vi.mocked(agendaDeHoje).mockResolvedValue(p.agenda);
  vi.mocked(adsDeOntem).mockResolvedValue(p.ads);
  vi.mocked(financeiroDeHoje).mockResolvedValue(p.financeiro);
}

const adminComFuso = {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { timezone: "America/Sao_Paulo" }, error: null }),
      }),
    }),
  }),
} as never;

describe("montarRelatorio", () => {
  it("nenhuma seção incompleta: secoesIncompletas vazio e as 4 aparecem no texto", async () => {
    programar();
    const r = await montarRelatorio(adminComFuso, "org-1", new Date("2026-09-03T12:00:00Z"));
    expect(r.secoesIncompletas).toEqual([]);
    expect(r.texto).toContain("5 atendido(s)");
    expect(r.texto).toContain("Agenda de hoje: nada marcado.");
    expect(r.texto).toContain("Caixa:");
  });

  it("seção incompleta some da conta e vira texto explícito, nunca zero escondido", async () => {
    programar({
      ads: { campanhas: [], gastoTotalCents: 0, sobraPorRealTotal: null, propostasPendentes: [], incompleto: true },
      financeiro: { caixaTotalCents: null, vencemHojeCents: { payable: 0, receivable: 0 }, vencidasCents: { payable: 0, receivable: 0 }, vencemHojeItens: [], vencidasItens: [], incompleto: true },
    });
    const r = await montarRelatorio(adminComFuso, "org-1", new Date("2026-09-03T12:00:00Z"));
    expect(r.secoesIncompletas).toEqual(["ads", "financeiro"]);
    expect(r.texto).toContain("dado incompleto (falta saldo de alguma conta)");
    expect(r.texto).not.toMatch(/Caixa: R\$ 0,00/);
  });

  it("as 4 leituras rodam em paralelo — nenhuma espera a outra terminar", async () => {
    const ordem: string[] = [];
    vi.mocked(atendimentosDaNoite).mockImplementation(async () => {
      ordem.push("atendimentos-start");
      await new Promise((r) => setTimeout(r, 5));
      ordem.push("atendimentos-end");
      return COMPLETO.atendimentos;
    });
    vi.mocked(agendaDeHoje).mockImplementation(async () => {
      ordem.push("agenda-start");
      return COMPLETO.agenda;
    });
    vi.mocked(adsDeOntem).mockResolvedValue(COMPLETO.ads);
    vi.mocked(financeiroDeHoje).mockResolvedValue(COMPLETO.financeiro);

    await montarRelatorio(adminComFuso, "org-1", new Date("2026-09-03T12:00:00Z"));
    // Se fosse sequencial, "agenda-start" só apareceria depois de "atendimentos-end".
    expect(ordem.indexOf("agenda-start")).toBeLessThan(ordem.indexOf("atendimentos-end"));
  });
});
