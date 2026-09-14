/**
 * ADR-0017 NAS TELAS: o preço e a margem entram pelo tipo; o valor pago entra
 * pelo "Realizado".
 *
 * ─── O que se prova, e por que na tela ───────────────────────────────────
 *
 * A API já aceita `price_cents`/`margin_bps` (tipo) e `paid_cents` (PATCH com
 * `completed`) — `tests/unit/agenda-dinheiro-api.test.ts`. Campo que a API
 * aceita e nenhuma tela produz é o mesmo defeito de "Realizado"/"Faltou" antes
 * da fiação: capacidade inteira de um lado, botão cinza do outro.
 *
 * As duas conversões moram na tela, e são o que mais dói quando erra CALADO:
 *
 *   • reais → centavos. "200" vira 20000, e "150,50"/"150.50" vira 15050. Um
 *     `Number("200") ` sem `* 100` gravaria R$ 2,00 e o relatório das 8h diria
 *     que a clínica faturou um centésimo do dia.
 *   • % → pontos-base. "60" vira 6000. A margem é do Dono e não vai ao modelo
 *     (a API já prova isso); aqui o que se prova é que 60 não vira 60 bps.
 *
 * E a AUSÊNCIA é dado, não zero: deixar o valor em branco no "Realizado" envia
 * SEM `paid_cents`. Mandar 0 diria "atendeu de graça", e a tela não sabe isso.
 *
 * Molde: `tests/unit/canal-parceiro-tela.test.tsx` (mocks de `@/lib/api/client`
 * e `sonner`, sem servidor). O histórico é testado ISOLADO com props, como
 * `agenda-separar-historico`: `AgendaClient` inteiro arrasta Google, grade e
 * três hooks — e o que se mede aqui é o diálogo, não a tela.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postMock = vi.fn();
const patchMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: vi.fn(),
    post: (...a: unknown[]) => postMock(...a),
    patch: (...a: unknown[]) => patchMock(...a),
    delete: vi.fn(),
  },
}));
const toastOk = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastOk(m), error: vi.fn() },
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));

import { HistoricoDaAgenda } from "@/components/agenda/HistoricoDaAgenda";
import { TiposDeAgendamentoClient, type TipoRow } from "@/app/app/settings/tenant/agenda/_client";
import { useRegistrarDesfecho } from "@/hooks/agenda/useRemarcarAgendamento";

import type { Agendamento, Pessoa } from "@/components/agenda/tipos";

afterEach(cleanup);
beforeEach(() => {
  postMock.mockReset().mockResolvedValue({ data: { id: "novo" } });
  patchMock.mockReset().mockResolvedValue({ data: { id: "ag-1" } });
  toastOk.mockReset();
  refresh.mockReset();
});

// ─── Tipo de atendimento: preço e margem ───────────────────────────────────

const PESSOAS_DA_ORG = [{ id: "u-ana", papel: "manager", nome: "Ana" }];

/** O tipo como a página o entrega — as duas colunas novas incluídas. */
const CONSULTA: TipoRow = {
  id: "t-consulta",
  name: "Consulta",
  slug: "consulta",
  description: null,
  category: "consulta",
  duration_minutes: 30,
  location_kind: "in_person",
  location_details: null,
  default_owner_user_id: "u-ana",
  requires_confirmation: false,
  is_active: true,
  price_cents: 20000,
  margin_bps: 6000,
  reminder_enabled: false,
  reminder_minutes_before: 1440,
};

function renderTipos(tipos: TipoRow[] = []) {
  return render(
    <TiposDeAgendamentoClient
      tiposIniciais={tipos}
      pessoas={PESSOAS_DA_ORG}
      podeEditar
      usuarioAtualId="u-ana"
      podeConfigurarGoogle={false}
    />,
  );
}

describe("formulário de tipo: preço e margem", () => {
  it("cria com preço em REAIS e margem em % — e envia centavos e pontos-base", async () => {
    renderTipos();
    fireEvent.click(screen.getByTestId("abrir-novo-tipo"));
    fireEvent.change(screen.getByTestId("novo-tipo-nome"), { target: { value: "Retorno" } });
    fireEvent.change(screen.getByLabelText(/Preço \(R\$\)/), { target: { value: "200" } });
    fireEvent.change(screen.getByLabelText(/Margem declarada \(%\)/), { target: { value: "60" } });
    fireEvent.submit(screen.getByTestId("form-novo-tipo"));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [rota, corpo] = postMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(rota).toBe("/api/v1/agenda/tipos");
    expect(corpo).toMatchObject({ name: "Retorno", price_cents: 20000, margin_bps: 6000 });
  });

  it("centavos de verdade: 150,50 vira 15050, nunca 150.5 nem 15049", async () => {
    renderTipos();
    fireEvent.click(screen.getByTestId("abrir-novo-tipo"));
    fireEvent.change(screen.getByTestId("novo-tipo-nome"), { target: { value: "Retorno" } });
    fireEvent.change(screen.getByLabelText(/Preço \(R\$\)/), { target: { value: "150.50" } });
    fireEvent.submit(screen.getByTestId("form-novo-tipo"));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const corpo = postMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(corpo.price_cents).toBe(15050);
    expect(Number.isInteger(corpo.price_cents)).toBe(true);
  });

  it("sem preço nem margem, os campos NÃO vão — dado faltante não é zero", async () => {
    renderTipos();
    fireEvent.click(screen.getByTestId("abrir-novo-tipo"));
    fireEvent.change(screen.getByTestId("novo-tipo-nome"), { target: { value: "Retorno" } });
    fireEvent.submit(screen.getByTestId("form-novo-tipo"));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const corpo = postMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(corpo).not.toHaveProperty("price_cents");
    expect(corpo).not.toHaveProperty("margin_bps");
  });

  it("editar mostra o que está gravado EM REAIS e em % — e devolve convertido", async () => {
    renderTipos([CONSULTA]);
    fireEvent.click(screen.getByTestId(`editar-${CONSULTA.id}`));

    const preco = screen.getByTestId(`editar-preco-${CONSULTA.id}`) as HTMLInputElement;
    const margem = screen.getByTestId(`editar-margem-${CONSULTA.id}`) as HTMLInputElement;
    expect(Number(preco.value)).toBe(200);
    expect(Number(margem.value)).toBe(60);

    fireEvent.change(preco, { target: { value: "250" } });
    fireEvent.change(margem, { target: { value: "55" } });
    fireEvent.submit(screen.getByTestId(`form-editar-${CONSULTA.id}`));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock.mock.calls[0]?.[1]).toMatchObject({
      id: CONSULTA.id,
      price_cents: 25000,
      margin_bps: 5500,
    });
  });

  it("limpar o preço na edição manda `null` — controle que a tela oferece chega ao servidor", async () => {
    renderTipos([CONSULTA]);
    fireEvent.click(screen.getByTestId(`editar-${CONSULTA.id}`));
    fireEvent.change(screen.getByTestId(`editar-preco-${CONSULTA.id}`), { target: { value: "" } });
    fireEvent.submit(screen.getByTestId(`form-editar-${CONSULTA.id}`));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    const corpo = patchMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(corpo.price_cents).toBeNull();
  });
});

// ─── "Realizado": quanto foi pago ──────────────────────────────────────────

/** Quarta-feira, 14h37 — fixo, como em `agenda-separar-historico`. */
const AGORA = new Date("2026-08-26T14:37:00.000Z");

const ANA: Pessoa = { id: "u-ana", nome: "Ana", trilha: 1 };

function passado(extra: Partial<Agendamento> = {}): Agendamento {
  return {
    id: "ag-1",
    titulo: "Consulta",
    quemSeraAtendido: "Maria Ferraz",
    responsavelId: ANA.id,
    comeca: new Date(AGORA.getTime() - 3 * 60 * 60_000).toISOString(),
    termina: new Date(AGORA.getTime() - 2.5 * 60 * 60_000).toISOString(),
    origem: "ui",
    situacao: "confirmed",
    tipo: "Consulta",
    precoCents: 20000,
    ...extra,
  };
}

/**
 * A fiação REAL entre o histórico e a rota: o mesmo hook que
 * `app/app/agenda/_client.tsx` usa, ligado do mesmo jeito. O que se prova é o
 * corpo que chega ao `PATCH`, não o clique.
 */
function HistoricoLigado({ agendamentos }: { agendamentos: Agendamento[] }) {
  const desfecho = useRegistrarDesfecho();
  return (
    <HistoricoDaAgenda
      agendamentos={agendamentos}
      pessoas={[ANA]}
      agora={AGORA}
      onRealizado={(id, pagoCents) => desfecho.mutate({ id, status: "completed", paid_cents: pagoCents })}
      onFaltou={(id) => desfecho.mutate({ id, status: "no_show" })}
    />
  );
}

function renderHistorico(agendamentos: Agendamento[] = [passado()]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <HistoricoLigado agendamentos={agendamentos} />
    </QueryClientProvider>,
  );
}

/** Monta o histórico e abre o "Realizado" da linha pedida. */
function abrirRealizado(agendamentos: Agendamento[] = [passado()], id = "ag-1") {
  renderHistorico(agendamentos);
  fireEvent.click(screen.getByTestId("aba-passados"));
  fireEvent.click(screen.getByTestId(`realizado-${id}`));
  return screen.getByTestId("valor-pago") as HTMLInputElement;
}

describe("Realizado: quanto foi pago", () => {
  it("abre um diálogo com o valor PRÉ-PREENCHIDO pelo preço do tipo, em reais", () => {
    const campo = abrirRealizado();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(Number(campo.value)).toBe(200);
    // Nada foi enviado ainda: abrir não é confirmar.
    expect(patchMock).not.toHaveBeenCalled();
  });

  it("confirmar envia `{ id, status: completed, paid_cents }` — em centavos", async () => {
    const campo = abrirRealizado();
    fireEvent.change(campo, { target: { value: "150.50" } });
    fireEvent.click(screen.getByTestId("confirmar-valor-pago"));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock.mock.calls[0]?.[0]).toBe("/api/v1/agenda/agendamentos");
    expect(patchMock.mock.calls[0]?.[1]).toEqual({ id: "ag-1", status: "completed", paid_cents: 15050 });
    // O diálogo fecha depois de confirmar — reabrir a pergunta já respondida é o defeito de sempre.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("em branco: avisa que fica como dado faltante e envia SEM `paid_cents`", async () => {
    const campo = abrirRealizado();
    fireEvent.change(campo, { target: { value: "" } });
    expect(screen.getByText(/dado faltante/i)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("confirmar-valor-pago"));
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    const corpo = patchMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(corpo).toEqual({ id: "ag-1", status: "completed" });
    expect(corpo).not.toHaveProperty("paid_cents");
  });

  it("tipo sem preço cadastrado: o campo nasce vazio, com o aviso — não nasce com zero", () => {
    const campo = abrirRealizado([passado({ id: "ag-2", precoCents: null })], "ag-2");
    expect(campo.value).toBe("");
    expect(screen.getByText(/dado faltante/i)).toBeInTheDocument();
  });

  it("Faltou continua direto, sem diálogo: não há valor a perguntar de quem não veio", async () => {
    renderHistorico();
    fireEvent.click(screen.getByTestId("aba-passados"));
    fireEvent.click(screen.getByTestId("faltou-ag-1"));
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock.mock.calls[0]?.[1]).toEqual({ id: "ag-1", status: "no_show" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
