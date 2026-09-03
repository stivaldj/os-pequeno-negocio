import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agenda/consulta", () => ({ listaAgendamentos: vi.fn() }));

import { listaAgendamentos } from "@/lib/agenda/consulta";

import { agendaDeHoje } from "./agenda";
import type { JanelaDoRelatorio } from "./janela";

const JANELA: JanelaDoRelatorio = {
  organizationId: "org-1",
  fuso: "America/Sao_Paulo",
  hoje: "2026-09-03",
  ontem: "2026-09-02",
  hojeInicioISO: "2026-09-03T03:00:00.000Z",
  hojeFimISO: "2026-09-04T03:00:00.000Z",
  ontemInicioISO: "2026-09-02T03:00:00.000Z",
};

describe("agendaDeHoje", () => {
  it("usa de/ate (instantes), nunca o parâmetro dia", async () => {
    vi.mocked(listaAgendamentos).mockResolvedValue({ ok: true, agendamentos: [] });
    await agendaDeHoje({} as never, JANELA);
    const chamada = vi.mocked(listaAgendamentos).mock.calls[0]!;
    expect(chamada[2]).toMatchObject({ de: JANELA.hojeInicioISO, ate: JANELA.hojeFimISO });
    expect(chamada[2]).not.toHaveProperty("dia");
  });

  it("filtra compromissos cancelados e traz pagoCents intacto (null não vira 0)", async () => {
    vi.mocked(listaAgendamentos).mockResolvedValue({
      ok: true,
      agendamentos: [
        { id: "1", titulo: "Consulta", iniciaEm: "2026-09-03T13:00:00Z", terminaEm: "2026-09-03T13:30:00Z", fuso: "America/Sao_Paulo", situacao: "completed", donoId: null, contatoId: "c1", contatoNome: "Maria", precoCents: 15000, pagoCents: 15000 },
        { id: "2", titulo: "Retorno", iniciaEm: "2026-09-03T14:00:00Z", terminaEm: "2026-09-03T14:30:00Z", fuso: "America/Sao_Paulo", situacao: "cancelled", donoId: null, contatoId: "c2", contatoNome: "João", precoCents: null, pagoCents: null },
        { id: "3", titulo: "Avaliação", iniciaEm: "2026-09-03T15:00:00Z", terminaEm: "2026-09-03T15:30:00Z", fuso: "America/Sao_Paulo", situacao: "confirmed", donoId: null, contatoId: "c3", contatoNome: null, precoCents: 20000, pagoCents: null },
      ],
    });
    const r = await agendaDeHoje({} as never, JANELA);
    expect(r.incompleto).toBe(false);
    expect(r.itens).toHaveLength(2);
    expect(r.itens.map((i) => i.titulo)).toEqual(["Consulta", "Avaliação"]);
    expect(r.itens[0]!.pagoCents).toBe(15000);
    expect(r.itens[1]!.pagoCents).toBeNull();
  });

  it("resultado not-ok vira seção incompleta", async () => {
    vi.mocked(listaAgendamentos).mockResolvedValue({
      ok: false,
      codigo: "erro_interno",
      motivoParaOperador: "x",
      motivoParaCliente: "y",
    });
    const r = await agendaDeHoje({} as never, JANELA);
    expect(r).toEqual({ itens: [], incompleto: true });
  });
});
