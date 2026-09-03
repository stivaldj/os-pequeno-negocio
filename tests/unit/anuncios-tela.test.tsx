/**
 * A tela de Anúncios (`/app/anuncios`) — os quatro blocos, cada um ISOLADO com
 * props, no molde de `tests/unit/agenda-dinheiro-tela.test.tsx`: montar o
 * `AnunciosClient` inteiro arrastaria quatro hooks e um servidor; o que se mede
 * aqui é o que cada bloco mostra e o que ele MANDA quando alguém clica.
 *
 * O que dói quando erra calado, e por isso está aqui:
 *
 *   • Sobra por Real é o número do produto. `2.5` tem de sair como
 *     "R$ 2,50 por real" — não "2.5", não "250%". E `null` (sem gasto) é
 *     travessão, nunca "R$ 0,00": zero diria "gastou e não sobrou nada".
 *   • Agendamentos = vendas COM margem + SEM margem. Mostrar só as com margem
 *     esconderia consulta paga do Dono.
 *   • Dia incompleto é destacado: a linha carrega o marcador e o aviso.
 *   • A URL do link de captura é copiada pelo helper `copyToClipboard`
 *     (regra do repo: nunca `navigator.clipboard` direto).
 *   • Nível de autonomia (Fase 8, ADR-0018) é editável, mas mudar de nível
 *     precisa de confirmação — o agente passa a gastar sozinho.
 *   • Piso/teto/custo máximo em branco viram `null`, nunca zero.
 *   • Aprovar/Recusar mandam o id e o status certos — e nada mais.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copiar = vi.fn(async (_texto: string) => true);
vi.mock("@/lib/clipboard", () => ({ copyToClipboard: (t: string) => copiar(t) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// O `Select` do controle de autonomia (Fase 8) é Radix — ele chama
// `scrollIntoView` ao abrir a lista, que o jsdom não implementa. Sem isto o
// componente inteiro desmonta com uma exceção não tratada.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}

import { ContaCard, LinksDeCaptura, PropostasPendentes, TabelaDeCampanhas } from "@/app/app/anuncios/_client";
import type { Campanha, ContaDeAnuncios, LinkDeCaptura, Proposta } from "@/hooks/ads/useAnuncios";

afterEach(cleanup);
beforeEach(() => copiar.mockClear());

const CAMPANHA: Campanha = {
  campaign_id: "c-1",
  campaign_name: "Consulta",
  gasto_cents: 10000,
  cliques: 15,
  contatos: 4,
  agendamentos: 3,
  vendas: 2,
  vendas_sem_margem: 1,
  receita_cents: 40000,
  sobra_cents: 25000,
  sobra_por_real: 2.5,
  dias_sem_gasto: [],
  incompleto: false,
};

describe("tabela de campanhas", () => {
  it("formata a Sobra por Real como R$ x,xx por real e soma os agendamentos", () => {
    render(<TabelaDeCampanhas campanhas={[CAMPANHA]} />);
    const linha = screen.getByTestId("campanha-c-1");
    expect(linha.textContent).toMatch(/R\$\s?2,50 por real/);
    expect(screen.getByTestId("campanha-c-1-agendamentos").textContent).toBe("3");
    expect(screen.getByTestId("campanha-c-1-cliques").textContent).toBe("15");
    expect(linha.textContent).toMatch(/R\$\s?100,00/);
    expect(linha).not.toHaveAttribute("data-incompleto");
  });

  it("sem gasto a Sobra por Real é travessão, nunca zero; sem cliques também", () => {
    render(<TabelaDeCampanhas campanhas={[{ ...CAMPANHA, gasto_cents: 0, cliques: null, sobra_por_real: null }]} />);
    expect(screen.getByTestId("campanha-c-1-sobra-por-real").textContent).toBe("—");
    expect(screen.getByTestId("campanha-c-1-cliques").textContent).toBe("—");
  });

  it("dia incompleto marca a linha e diz quantos dias faltam", () => {
    render(<TabelaDeCampanhas campanhas={[{ ...CAMPANHA, incompleto: true, dias_sem_gasto: ["2026-09-01", "2026-09-02"] }]} />);
    const linha = screen.getByTestId("campanha-c-1");
    expect(linha).toHaveAttribute("data-incompleto", "true");
    expect(linha.textContent).toContain("2");
    expect(screen.getByTestId("campanha-c-1-incompleto")).toBeInTheDocument();
  });

  it("sem campanha no período, diz isso em vez de tabela vazia", () => {
    render(<TabelaDeCampanhas campanhas={[]} />);
    expect(screen.getByTestId("campanhas-vazio")).toBeInTheDocument();
  });
});

describe("links de captura", () => {
  const LINK: LinkDeCaptura = {
    id: "l-1",
    slug: "consulta-ab12",
    campaign_id: "c-1",
    campaign_name: "Consulta",
    whatsapp_e164: "+5565999990000",
    mensagem: "Quero marcar",
    active: true,
    url: "https://crm.exemplo/ir/consulta-ab12",
    created_at: "2026-09-01T00:00:00Z",
  };

  it("copia a URL pública pelo helper do repo", async () => {
    render(<LinksDeCaptura links={[LINK]} criando={false} onCriar={vi.fn()} />);
    expect(screen.getByTestId("link-l-1").textContent).toContain("https://crm.exemplo/ir/consulta-ab12");
    fireEvent.click(screen.getByTestId("copiar-l-1"));
    await waitFor(() => expect(copiar).toHaveBeenCalledWith("https://crm.exemplo/ir/consulta-ab12"));
  });

  it("o formulário manda campaign_id, campaign_name, whatsapp_e164 e mensagem", () => {
    const onCriar = vi.fn();
    render(<LinksDeCaptura links={[]} criando={false} onCriar={onCriar} />);
    fireEvent.change(screen.getByTestId("link-campaign-id"), { target: { value: "c-7" } });
    fireEvent.change(screen.getByTestId("link-campaign-name"), { target: { value: "Retorno" } });
    fireEvent.change(screen.getByTestId("link-whatsapp"), { target: { value: "+5565988880000" } });
    fireEvent.change(screen.getByTestId("link-mensagem"), { target: { value: "Oi, vim do anúncio" } });
    fireEvent.submit(screen.getByTestId("form-link"));
    expect(onCriar).toHaveBeenCalledWith({
      campaign_id: "c-7",
      campaign_name: "Retorno",
      whatsapp_e164: "+5565988880000",
      mensagem: "Oi, vim do anúncio",
    });
  });
});

describe("cartão da Conta", () => {
  const CONTA: ContaDeAnuncios = {
    id: "acc-1",
    customer_id: "1234567890",
    conversion_customer_id: null,
    conversion_action: "Lead WhatsApp",
    currency: "BRL",
    autonomy_level: 1,
    budget_floor_cents: 3000,
    budget_ceiling_cents: 8000,
    max_cost_per_conversation_cents: null,
    status: "error",
    last_sync_at: "2026-09-02T08:00:00Z",
    last_error: "invalid customer id",
  };

  it("mostra nível de autonomia, último sync e erro; salva os três campos do formulário principal", () => {
    const onSalvar = vi.fn();
    render(<ContaCard conta={CONTA} salvando={false} onSalvar={onSalvar} />);
    expect(screen.getByTestId("conta-autonomia").textContent).toContain("1");
    expect(screen.getByTestId("conta-erro").textContent).toContain("invalid customer id");

    fireEvent.change(screen.getByTestId("conta-customer-id"), { target: { value: "1112223334" } });
    fireEvent.change(screen.getByTestId("conta-conversion-customer-id"), { target: { value: "9998887776" } });
    fireEvent.change(screen.getByTestId("conta-conversion-action"), { target: { value: "Consulta marcada" } });
    fireEvent.submit(screen.getByTestId("form-conta"));
    expect(onSalvar).toHaveBeenCalledWith({
      customer_id: "1112223334",
      conversion_customer_id: "9998887776",
      conversion_action: "Consulta marcada",
    });
  });

  it("sem Conta ainda, o formulário nasce vazio e o campo opcional em branco vai como null; sem controle de autonomia (nada para promover)", () => {
    const onSalvar = vi.fn();
    render(<ContaCard conta={null} salvando={false} onSalvar={onSalvar} />);
    expect(screen.queryByTestId("conta-autonomia-input")).toBeNull();
    fireEvent.change(screen.getByTestId("conta-customer-id"), { target: { value: "1234567890" } });
    fireEvent.submit(screen.getByTestId("form-conta"));
    expect(onSalvar).toHaveBeenCalledWith({ customer_id: "1234567890", conversion_customer_id: null, conversion_action: null });
  });

  describe("Fase 8 — autonomia do agente", () => {
    it("o controle de nível existe (Fase 8 tornou o Nível 2/3 configuráveis pelo painel)", () => {
      render(<ContaCard conta={CONTA} salvando={false} onSalvar={vi.fn()} />);
      expect(screen.getByTestId("conta-autonomia-input")).toBeTruthy();
    });

    it("salvar SEM mudar o nível não abre confirmação — manda a Conta inteira mais os limites em centavos", () => {
      const onSalvar = vi.fn();
      render(<ContaCard conta={CONTA} salvando={false} onSalvar={onSalvar} />);
      fireEvent.click(screen.getByTestId("conta-salvar-autonomia"));
      expect(screen.queryByTestId("conta-autonomia-confirmar")).toBeNull();
      expect(onSalvar).toHaveBeenCalledWith({
        customer_id: "1234567890",
        conversion_customer_id: null,
        conversion_action: "Lead WhatsApp",
        autonomy_level: 1,
        budget_floor_cents: 3000,
        budget_ceiling_cents: 8000,
        max_cost_per_conversation_cents: null,
      });
    });

    it("piso e teto em branco viram null — nunca 0, que fingiria limite zero", () => {
      const onSalvar = vi.fn();
      render(<ContaCard conta={{ ...CONTA, budget_floor_cents: null, budget_ceiling_cents: null }} salvando={false} onSalvar={onSalvar} />);
      fireEvent.click(screen.getByTestId("conta-salvar-autonomia"));
      expect(onSalvar).toHaveBeenCalledWith(
        expect.objectContaining({ budget_floor_cents: null, budget_ceiling_cents: null }),
      );
    });

    it("mudar o nível pede confirmação, e só chama onSalvar depois de confirmar", async () => {
      const onSalvar = vi.fn();
      render(<ContaCard conta={CONTA} salvando={false} onSalvar={onSalvar} />);

      fireEvent.click(screen.getByTestId("conta-autonomia-input"));
      const opcaoNivel2 = await screen.findByTestId("conta-autonomia-opcao-2");
      fireEvent.click(opcaoNivel2);

      fireEvent.click(screen.getByTestId("conta-salvar-autonomia"));
      expect(onSalvar).not.toHaveBeenCalled();
      const confirmar = await screen.findByTestId("conta-autonomia-confirmar");
      fireEvent.click(confirmar);
      expect(onSalvar).toHaveBeenCalledWith(expect.objectContaining({ autonomy_level: 2 }));
    });
  });
});

describe("propostas pendentes", () => {
  const PROPOSTA: Proposta = {
    id: "p-1",
    campaign_id: "c-1",
    kind: "orcamento",
    level: 1,
    title: "Subir o orçamento em 10%",
    body: "A campanha Consulta rendeu R$ 2,50 por real nos últimos 7 dias.",
    payload: { delta_pct: 10 },
    status: "pendente",
    decided_by: null,
    decided_at: null,
    created_at: "2026-09-02T07:55:00Z",
  };

  it("Aprovar e Recusar mandam o id e o status certos", () => {
    const onDecidir = vi.fn();
    render(<PropostasPendentes propostas={[PROPOSTA]} decidindo={false} onDecidir={onDecidir} />);
    expect(screen.getByTestId("proposta-p-1").textContent).toContain("Subir o orçamento em 10%");
    fireEvent.click(screen.getByTestId("aprovar-p-1"));
    expect(onDecidir).toHaveBeenCalledWith("p-1", "aprovada");
    fireEvent.click(screen.getByTestId("recusar-p-1"));
    expect(onDecidir).toHaveBeenCalledWith("p-1", "recusada");
  });

  it("sem proposta pendente, diz isso", () => {
    render(<PropostasPendentes propostas={[]} decidindo={false} onDecidir={vi.fn()} />);
    expect(screen.getByTestId("propostas-vazio")).toBeInTheDocument();
  });
});
