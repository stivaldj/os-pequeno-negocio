/**
 * A tela do Financeiro (`/app/financeiro`) — os quatro blocos mais o resumo da
 * importação, cada um ISOLADO com props, no molde de
 * `tests/unit/anuncios-tela.test.tsx`: montar o `FinanceiroClient` inteiro
 * arrastaria cinco hooks e um servidor; o que se mede aqui é o que cada bloco
 * MOSTRA e o que ele MANDA quando alguém clica.
 *
 * O que dói quando erra calado, e por isso está aqui:
 *
 *   • **`null` não é zero.** Conta sem saldo lido do banco tem de dizer
 *     "incompleto"; escrever R$ 0,00 afirmaria que a conta está zerada — a
 *     mentira exata que a Fase 6 existe para não contar. Idem o total: sem
 *     total, uma frase, nunca um número.
 *   • **A DATA do saldo aparece ao lado do número.** Saldo sem data é saldo de
 *     quando? O Dono confere contra o app do banco, e o app do banco mostra
 *     hoje; sem a data ele acha que o número está errado (ou pior, acha que
 *     está certo).
 *   • **`por_conteudo > 0` é um AVISO, não um contador.** É a única contagem do
 *     resumo que muda o que ele deve FAZER: aquele banco não manda
 *     identificador confiável, e reimportar período sobreposto pode duplicar.
 *   • **Os descartados aparecem com motivo E contexto.** É o que o Dono veio
 *     ler para decidir se reexporta o arquivo.
 *   • **Reais viram centavos por `lib/money.ts`.** "1.250,00" tem de sair como
 *     125000 no corpo — nenhuma conversão nova nesta tela.
 *   • **A baixa manda o dia da ORGANIZAÇÃO** (o `hoje` que veio do `/caixa`),
 *     não `new Date()` do navegador: o fuso do cliente não é o da clínica.
 *   • **Lançamento frágil é marcado** — `key_source: 'conteudo'`.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { toast } from "sonner";

import {
  CaixaPorConta,
  ContasCadastradas,
  UltimosLancamentos,
  VencimentosDoDia,
} from "@/app/app/financeiro/_client";
import { ResumoDaImportacaoNaTela } from "@/components/financeiro/ImportarExtratoDialog";
import type {
  Caixa,
  ContaDeCaixa,
  Lancamento,
  Obrigacao,
  ResumoDaImportacao,
  Vencimentos,
} from "@/hooks/financeiro/useFinanceiro";

afterEach(cleanup);

const CONTA: ContaDeCaixa = {
  bank_id: "001",
  account_id: "00012345-6",
  account_kind: "bank",
  saldo_cents: 100000,
  saldo_em: "2026-08-31",
  lancamentos_depois: 1,
  soma_depois_cents: 23456,
  saldo_estimado_cents: 123456,
  incompleto: false,
};

describe("caixa por conta", () => {
  it("mostra o saldo COM a data em que ele valia, e o estimado de hoje", () => {
    const caixa: Caixa = { total_cents: 123456, incompleto: false, contas: [CONTA] };
    render(<CaixaPorConta caixa={caixa} />);
    expect(screen.getByTestId("caixa-total").textContent).toMatch(/R\$\s?1\.234,56/);
    expect(screen.getByTestId("conta-00012345-6-saldo").textContent).toMatch(/R\$\s?1\.000,00/);
    // 31/08/2026 no formato do idioma — o que importa é a data estar lá.
    expect(screen.getByTestId("conta-00012345-6-saldo-em").textContent).toContain("31");
    expect(screen.getByTestId("conta-00012345-6-estimado").textContent).toMatch(/R\$\s?1\.234,56/);
    expect(screen.getByTestId("conta-00012345-6")).not.toHaveAttribute("data-incompleto");
    expect(screen.queryByTestId("caixa-total-incompleto")).toBeNull();
  });

  it("conta sem saldo lido diz “incompleto” — e NUNCA R$ 0,00", () => {
    const semSaldo: ContaDeCaixa = {
      ...CONTA,
      account_id: "4111",
      account_kind: "credit_card",
      saldo_cents: null,
      saldo_em: null,
      saldo_estimado_cents: null,
      incompleto: true,
    };
    render(<CaixaPorConta caixa={{ total_cents: null, incompleto: true, contas: [semSaldo] }} />);

    const celula = screen.getByTestId("conta-4111-saldo");
    expect(celula.textContent).toContain("incompleto");
    expect(celula.textContent).not.toMatch(/R\$\s?0,00/);
    expect(screen.getByTestId("conta-4111-estimado").textContent).toBe("—");
    expect(screen.getByTestId("conta-4111")).toHaveAttribute("data-incompleto", "true");
    expect(screen.getByTestId("caixa-aviso-incompleto")).toBeInTheDocument();
  });

  it("total nulo vira frase, nunca zero", () => {
    render(<CaixaPorConta caixa={{ total_cents: null, incompleto: true, contas: [CONTA] }} />);
    expect(screen.queryByTestId("caixa-total")).toBeNull();
    const aviso = screen.getByTestId("caixa-total-incompleto");
    expect(aviso.textContent).not.toMatch(/R\$\s?0,00/);
    expect(aviso.textContent?.length ?? 0).toBeGreaterThan(10);
  });

  it("sem extrato importado, diz isso em vez de tabela vazia", () => {
    render(<CaixaPorConta caixa={{ total_cents: 0, incompleto: false, contas: [] }} />);
    expect(screen.getByTestId("caixa-vazio")).toBeInTheDocument();
  });
});

describe("o que vence", () => {
  const vazio = { itens: [], total_cents: { payable: 0, receivable: 0 } };
  const VENCIMENTOS: Vencimentos = {
    hoje: "2026-09-02",
    vencem_hoje: {
      itens: [
        {
          id: "o-1",
          direction: "payable",
          description: "Aluguel da sala",
          amount_cents: 250000,
          due_on: "2026-09-02",
          status: "open",
        },
      ],
      total_cents: { payable: 250000, receivable: 0 },
    },
    vencidas: {
      itens: [
        {
          id: "o-2",
          direction: "receivable",
          description: "Convênio de agosto",
          amount_cents: 180000,
          due_on: "2026-08-25",
          status: "open",
        },
      ],
      total_cents: { payable: 0, receivable: 180000 },
    },
    proximos_7_dias: vazio,
  };

  it("separa vencidas, hoje e próximos 7 dias — com o total de cada direção", () => {
    render(<VencimentosDoDia vencimentos={VENCIMENTOS} />);
    expect(screen.getByTestId("vencimento-o-1").textContent).toContain("Aluguel da sala");
    expect(screen.getByTestId("vencem-hoje-totais").textContent).toMatch(/R\$\s?2\.500,00/);
    expect(screen.getByTestId("vencimento-o-2").textContent).toContain("Convênio de agosto");
    expect(screen.getByTestId("vencidas-totais").textContent).toMatch(/R\$\s?1\.800,00/);
  });

  it("grupo vazio diz que não há nada, em vez de sumir da tela", () => {
    render(<VencimentosDoDia vencimentos={{ ...VENCIMENTOS, vencem_hoje: vazio, vencidas: vazio }} />);
    const grupo = screen.getByTestId("vencem-hoje");
    expect(grupo.textContent).toMatch(/Nada vence hoje/);
    expect(screen.getByTestId("proximos-7").textContent).toMatch(/Nada nos próximos 7 dias/);
  });
});

describe("contas a pagar e a receber", () => {
  const OBRIGACAO: Obrigacao = {
    id: "o-9",
    direction: "payable",
    description: "Energia",
    amount_cents: 43000,
    currency: "BRL",
    due_on: "2026-09-10",
    status: "open",
    paid_on: null,
    paid_cents: null,
    category_id: null,
    reminder_sent_on: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  };

  it("o formulário converte reais em centavos por lib/money.ts e manda a direção escolhida", () => {
    const onCriar = vi.fn();
    render(
      <ContasCadastradas
        obrigacoes={[]}
        hoje="2026-09-02"
        criando={false}
        onCriar={onCriar}
        dandoBaixa={false}
        onBaixar={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("obrigacao-receivable"));
    fireEvent.change(screen.getByTestId("obrigacao-descricao"), { target: { value: "Convênio" } });
    fireEvent.change(screen.getByTestId("obrigacao-valor"), { target: { value: "1.250,00" } });
    fireEvent.change(screen.getByTestId("obrigacao-vencimento"), { target: { value: "2026-09-20" } });
    fireEvent.submit(screen.getByTestId("form-obrigacao"));

    expect(onCriar).toHaveBeenCalledWith({
      direction: "receivable",
      description: "Convênio",
      amount_cents: 125000,
      due_on: "2026-09-20",
    });
  });

  it("valor ilegível não vira zero nem chega à API: recusa com aviso", () => {
    const onCriar = vi.fn();
    render(
      <ContasCadastradas
        obrigacoes={[]}
        hoje="2026-09-02"
        criando={false}
        onCriar={onCriar}
        dandoBaixa={false}
        onBaixar={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("obrigacao-descricao"), { target: { value: "Energia" } });
    fireEvent.change(screen.getByTestId("obrigacao-valor"), { target: { value: "muito caro" } });
    fireEvent.change(screen.getByTestId("obrigacao-vencimento"), { target: { value: "2026-09-20" } });
    fireEvent.submit(screen.getByTestId("form-obrigacao"));

    expect(onCriar).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).toHaveBeenCalled();
  });

  it("a baixa manda o dia da ORGANIZAÇÃO, e cancelar não manda paid_on", () => {
    const onBaixar = vi.fn();
    render(
      <ContasCadastradas
        obrigacoes={[OBRIGACAO]}
        hoje="2026-09-02"
        criando={false}
        onCriar={vi.fn()}
        dandoBaixa={false}
        onBaixar={onBaixar}
      />,
    );
    fireEvent.click(screen.getByTestId("baixar-o-9"));
    expect(onBaixar).toHaveBeenCalledWith({ id: "o-9", status: "paid", paid_on: "2026-09-02" });
    fireEvent.click(screen.getByTestId("cancelar-o-9"));
    expect(onBaixar).toHaveBeenCalledWith({ id: "o-9", status: "cancelled" });
  });

  it("sem conta em aberto, diz isso", () => {
    render(
      <ContasCadastradas
        obrigacoes={[]}
        hoje="2026-09-02"
        criando={false}
        onCriar={vi.fn()}
        dandoBaixa={false}
        onBaixar={vi.fn()}
      />,
    );
    expect(screen.getByTestId("obrigacoes-vazio")).toBeInTheDocument();
  });
});

describe("últimos lançamentos", () => {
  const LANCAMENTO: Lancamento = {
    id: "l-1",
    bank_id: "001",
    account_id: "00012345-6",
    account_kind: "bank",
    posted_on: "2026-09-01",
    amount_cents: -25000,
    currency: "BRL",
    trn_type: "DEBIT",
    description: "ALUGUEL SALA",
    key_source: "fitid",
    source: "ofx",
    category_id: null,
    created_at: "2026-09-02T00:00:00Z",
  };

  it("mostra o valor assinado do extrato, com o sinal do banco", () => {
    render(<UltimosLancamentos lancamentos={[LANCAMENTO]} />);
    expect(screen.getByTestId("lancamento-l-1-valor").textContent).toMatch(/-\s?R\$\s?250,00/);
    expect(screen.getByTestId("lancamento-l-1")).not.toHaveAttribute("data-fragil");
  });

  it("linha sem identificador do banco é marcada — é ela que pode duplicar", () => {
    render(<UltimosLancamentos lancamentos={[{ ...LANCAMENTO, key_source: "conteudo" }]} />);
    expect(screen.getByTestId("lancamento-l-1")).toHaveAttribute("data-fragil", "true");
    expect(screen.getByTestId("lancamento-l-1-fragil")).toBeInTheDocument();
  });

  it("sem lançamento, diz isso em vez de tabela vazia", () => {
    render(<UltimosLancamentos lancamentos={[]} />);
    expect(screen.getByTestId("lancamentos-vazio")).toBeInTheDocument();
  });
});

describe("resumo da importação do extrato", () => {
  const RESUMO: ResumoDaImportacao = {
    total_lancamentos: 42,
    importados: 40,
    duplicados: 2,
    por_conteudo: 0,
    saldos_gravados: 1,
    descartados: [],
    contas: [{ bank_id: "001", account_id: "00012345-6", account_kind: "bank", lancamentos: 42 }],
  };

  it("mostra lidos, importados, já existentes e saldos gravados", () => {
    render(<ResumoDaImportacaoNaTela resumo={RESUMO} onOutro={vi.fn()} onConcluir={vi.fn()} />);
    expect(screen.getByTestId("resumo-total").textContent).toContain("42");
    expect(screen.getByTestId("resumo-importados").textContent).toContain("40");
    expect(screen.getByTestId("resumo-duplicados").textContent).toContain("2");
    expect(screen.getByTestId("resumo-saldos").textContent).toContain("1");
    expect(screen.queryByTestId("resumo-por-conteudo")).toBeNull();
    expect(screen.queryByTestId("resumo-lista-descartados")).toBeNull();
  });

  it("por_conteudo > 0 vira AVISO que explica o risco de duplicar", () => {
    render(<ResumoDaImportacaoNaTela resumo={{ ...RESUMO, por_conteudo: 7 }} onOutro={vi.fn()} onConcluir={vi.fn()} />);
    const aviso = screen.getByTestId("resumo-por-conteudo");
    expect(aviso.textContent).toContain("7");
    expect(aviso.textContent).toMatch(/duplic/i);
  });

  it("lista os descartados com motivo E contexto, numa área rolável", () => {
    render(
      <ResumoDaImportacaoNaTela
        resumo={{
          ...RESUMO,
          descartados: [
            { motivo: "TRNAMT ausente", contexto: "<STMTTRN> sem valor, linha 12" },
            { motivo: "DTPOSTED ilegível", contexto: "20261332" },
          ],
        }}
        onOutro={vi.fn()}
        onConcluir={vi.fn()}
      />,
    );
    expect(screen.getByTestId("resumo-descartados").textContent).toContain("2");
    const lista = screen.getByTestId("resumo-lista-descartados");
    expect(lista.className).toContain("overflow-y-auto");
    expect(lista.textContent).toContain("TRNAMT ausente");
    expect(lista.textContent).toContain("<STMTTRN> sem valor, linha 12");
    expect(lista.textContent).toContain("DTPOSTED ilegível");
  });

  it("o diálogo não fecha sozinho: “Concluir” e “Importar outro” são do usuário", () => {
    const onOutro = vi.fn();
    const onConcluir = vi.fn();
    render(<ResumoDaImportacaoNaTela resumo={RESUMO} onOutro={onOutro} onConcluir={onConcluir} />);
    expect(onConcluir).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("extrato-outro"));
    expect(onOutro).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("extrato-concluir"));
    expect(onConcluir).toHaveBeenCalled();
  });
});
