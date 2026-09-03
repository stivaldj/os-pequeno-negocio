/**
 * Extração: lançamentos, saldos, descartes — e a chave de idempotência.
 *
 * A chave é o teste mais caro deste arquivo. Ela decide se reimportar o extrato
 * do mês seguinte, que sobrepõe uma semana, cria lançamento duplicado ou não —
 * e um duplicado no livro-caixa é saldo errado ao Dono sem nada ficar vermelho.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

import { lerOfx } from "@/lib/financeiro/ofx";
import type { ExtratoLido } from "@/lib/financeiro/ofx/tipos";

/** Relativo à raiz do repo, como o resto da casa faz — o `vitest run` roda de lá. */
const FIXTURES = "tests/fixtures/ofx/";
const bytes = (nome: string): Buffer => readFileSync(FIXTURES + nome);
const ler = (nome: string): ExtratoLido => lerOfx(bytes(nome));

describe("bradesco-like.ofx — o extrato que faz tudo de errado", () => {
  const r = ler("bradesco-like.ofx");

  it("lê os dois lançamentos com o sinal do TRNAMT, não do TRNTYPE", () => {
    expect(r.lancamentos.map((l) => l.valorCents)).toEqual([-53086, 84710]);
    expect(r.lancamentos.map((l) => l.tipo)).toEqual(["DEBIT", "CREDIT"]);
    // A soma dos dois é o MOVIMENTO da janela, e não o saldo — é por isso que
    // o caixa vem do LEDGERBAL e não daqui.
    expect(r.lancamentos.reduce((s, l) => s + l.valorCents, 0)).toBe(31624);
  });

  it("o acento cp1252 chega inteiro à descrição, com o `&` cru junto", () => {
    expect(r.lancamentos[0]?.descricao).toBe("PAGTO CARTÃO & COBRANÇA");
    expect(r.lancamentos[1]?.descricao).toBe("CRÉDITO EM CONTA");
  });

  it("ACCTID com espaço sobrando é aparado — senão viram duas contas diferentes", () => {
    expect(r.lancamentos[0]?.conta).toEqual({
      bankId: "237",
      acctId: "00012345-6",
      kind: "bank",
      acctType: "CHECKING",
    });
  });

  it("guarda o DTPOSTED bruto: `no mesmo dia do saldo` é decisão que precisa da hora", () => {
    expect(r.lancamentos[1]?.dtpostedBruto).toBe("20260805120000[-3:BRT]");
    expect(r.lancamentos[1]?.dia).toBe("2026-08-05");
  });

  it("LEDGERBAL e AVAILBAL viram saldos distintos, com a data que o banco declarou", () => {
    expect(r.saldos).toEqual([
      expect.objectContaining({ tipo: "ledger", valorCents: 131624, dia: "2026-08-31" }),
      expect.objectContaining({ tipo: "available", valorCents: 120000, dia: "2026-08-31" }),
    ]);
  });

  it("FITID honrado: a chave sai por fitid, e sem organization_id", () => {
    expect(r.lancamentos.map((l) => l.chaveOrigem)).toEqual(["fitid", "fitid"]);
    expect(r.lancamentos[0]?.chaveBruta).toBe("fitid|237|00012345-6|bank|000000000001");
  });

  it("nada foi descartado neste arquivo", () => {
    expect(r.descartados).toEqual([]);
  });
});

describe("um tokenizer só lê OFX 1.x e 2.x", () => {
  it("as duas fixtures do mesmo extrato produzem lançamentos IDÊNTICOS", () => {
    // Se um dia alguém precisar de um `if (versao === 2)`, este teste fica
    // vermelho antes de o ramo existir.
    const v1 = ler("bradesco-like.ofx");
    const v2 = ler("ofx2.xml.ofx");
    expect(v1.versao).toBe("1");
    expect(v2.versao).toBe("2");
    expect(v2.lancamentos).toEqual(v1.lancamentos);
    expect(v2.saldos).toEqual(v1.saldos);
  });
});

describe("cora-meia-noite-gmt.ofx — o extrato que chegou do banco de verdade", () => {
  const r = ler("cora-meia-noite-gmt.ofx");

  it("os três lançamentos ficam em 01/09, o dia que o banco declarou", () => {
    // O defeito que a prova de realidade pegou: `000000[0:GMT]` lido como
    // instante vira 21h de 31/08 em Brasília. Os três lançamentos mudavam de
    // dia — e, por ser virada de mês, a receita de setembro caía em agosto.
    expect(r.lancamentos.map((l) => l.dia)).toEqual(["2025-09-01", "2025-09-01", "2025-09-01"]);
    expect(r.saldos.map((s) => s.dia)).toEqual(["2025-09-01"]);
  });

  it("o saldo vem do LEDGERBAL e NÃO da soma da janela", () => {
    expect(r.lancamentos.reduce((soma, l) => soma + l.valorCents, 0)).toBe(466_666);
    expect(r.saldos[0]?.valorCents).toBe(777_777);
    expect(r.saldos[0]?.tipo).toBe("ledger");
  });

  it("ENCODING:UTF-8 sem linha CHARSET é lido, e o acento chega inteiro", () => {
    // A spec 1.x só prevê USASCII e UNICODE; a Cora manda UTF-8 e omite o
    // CHARSET. Recusar isso seria recusar o extrato do Dono.
    expect(r.charset).toBe("utf-8");
    expect(r.lancamentos[1]?.descricao).toContain("Transferência");
    expect(r.lancamentos[0]?.descricao).toContain("FICTÍCIA");
  });

  it("o FITID em UUID mantém a chave no modo forte", () => {
    expect(r.lancamentos.every((l) => l.chaveOrigem === "fitid")).toBe(true);
    expect(new Set(r.lancamentos.map((l) => l.chaveBruta)).size).toBe(3);
  });
});

describe("duas-contas.ofx — o asArray nos dois sentidos", () => {
  const r = ler("duas-contas.ofx");

  it("a conta com DUAS transações não perde a segunda, e a com UMA não quebra", () => {
    const porConta = new Map<string, number>();
    for (const l of r.lancamentos) {
      porConta.set(l.conta.acctId, (porConta.get(l.conta.acctId) ?? 0) + 1);
    }
    expect([...porConta.entries()].sort()).toEqual([
      ["11111-1", 2],
      ["22222-2", 1],
    ]);
  });

  it("cada conta traz o seu próprio saldo", () => {
    expect(r.saldos.map((s) => [s.conta.acctId, s.valorCents])).toEqual([
      ["11111-1", 1550],
      ["22222-2", 100107],
    ]);
  });

  it("a chave carrega a conta: mesmo banco, contas diferentes, chaves diferentes", () => {
    const chaves = new Set(r.lancamentos.map((l) => l.chaveBruta));
    expect(chaves.size).toBe(r.lancamentos.length);
  });
});

describe("caixa-decimal-quebrado.ofx — `.` não é zero", () => {
  const r = ler("caixa-decimal-quebrado.ofx");

  it("o lançamento sem valor legível é DESCARTADO, não importado como 0", () => {
    expect(r.lancamentos.map((l) => l.descricao)).toEqual(["SALDO DIA", "COMPRA CARTAO"]);
    expect(r.lancamentos.some((l) => l.valorCents === 0)).toBe(false);
    const d = r.descartados.find((x) => x.motivo === "valor_ilegivel");
    expect(d?.contexto).toContain("LANCAMENTO SEM VALOR");
  });

  it("saldo ilegível: a conta fica SEM saldo, nunca com saldo zero", () => {
    // Um zero fabricado é pior que a ausência — a tela sabe dizer "saldo não
    // lido", não sabe desmentir um número. É a mesma disciplina do "dia sem
    // gasto lido" de `lib/ads/sobra.ts`.
    expect(r.saldos).toEqual([]);
    expect(r.descartados.map((d) => d.motivo)).toContain("saldo_ilegivel");
  });

  it("`FITID:0` derruba a conta INTEIRA para a chave por conteúdo", () => {
    expect(r.lancamentos.every((l) => l.chaveOrigem === "conteudo")).toBe(true);
  });
});

describe("fitid-repetido.ofx — quando o FITID deixa de identificar", () => {
  const r = ler("fitid-repetido.ofx");

  it("FITID repetido na mesma conta derruba a conta inteira para conteúdo", () => {
    expect(r.lancamentos.every((l) => l.chaveOrigem === "conteudo")).toBe(true);
  });

  it("o ordinal separa dois lançamentos de mesmo dia e mesmo valor", () => {
    const saques = r.lancamentos.filter((l) => l.valorCents === -5000);
    expect(saques).toHaveLength(2);
    expect(saques[0]?.chaveBruta).toBe("conteudo|033|13000123456|bank|2026-09-16|-5000|0");
    expect(saques[1]?.chaveBruta).toBe("conteudo|033|13000123456|bank|2026-09-16|-5000|1");
  });

  it("o ordinal é POR GRUPO (dia, valor), não índice global", () => {
    // Índice global mudaria a chave de todo mundo quando o Dono importasse um
    // período que começa antes. Por grupo, reimportar período sobreposto
    // reencontra o mesmo ordinal.
    const ordinais = r.lancamentos.map((l) => l.chaveBruta.split("|").at(-1));
    expect(ordinais).toEqual(["0", "0", "0", "1"]);
  });
});

describe("a chave de fallback NÃO usa a descrição", () => {
  it("o mesmo extrato com os MEMOs trocados gera as MESMAS chaves", () => {
    // Foi a correção mais cara da revisão do plano. Bancos brasileiros
    // reescrevem a descrição entre um extrato e o seguinte. Uma chave que
    // dependesse dela geraria `external_id` novo na reimportação, SEM `23505`,
    // criando lançamento duplicado que o caixa somaria — saldo errado ao Dono,
    // sem nada ficar vermelho. Este teste é o que impede a volta disso.
    const original = ler("fitid-repetido.ofx");

    const texto = bytes("fitid-repetido.ofx").toString("latin1");
    const reescrito = texto
      .replace("TARIFA PACOTE SERVICOS", "TAR PACOTE SERV 09/26")
      .replace("SAQUE TERMINAL 1", "SAQ TERM AG 0001")
      .replace("SAQUE TERMINAL 2", "SAQ TERM AG 0002")
      .replace("IOF", "IOF S/ TARIFA");
    const depois = lerOfx(Buffer.from(reescrito, "latin1"));

    // As descrições MUDARAM de verdade — senão o teste passaria por vacuidade.
    expect(depois.lancamentos.map((l) => l.descricao)).not.toEqual(
      original.lancamentos.map((l) => l.descricao),
    );
    // E as chaves continuam idênticas, uma a uma.
    expect(depois.lancamentos.map((l) => l.chaveBruta)).toEqual(
      original.lancamentos.map((l) => l.chaveBruta),
    );
  });

  it("nem no modo fitid a descrição entra na chave", () => {
    const original = ler("bradesco-like.ofx");
    const reescrito = bytes("bradesco-like.ofx")
      .toString("latin1")
      .replace("PAGTO CARTÃO & COBRANÇA", "PGTO CART COBR");
    const depois = lerOfx(Buffer.from(reescrito, "latin1"));
    expect(depois.lancamentos.map((l) => l.chaveBruta)).toEqual(
      original.lancamentos.map((l) => l.chaveBruta),
    );
  });
});

describe("cartao.ofx — o outro ramo da árvore", () => {
  const r = ler("cartao.ofx");

  it("lê CREDITCARDMSGSRSV1 > CCSTMTTRNRS > CCSTMTRS", () => {
    expect(r.lancamentos).toHaveLength(2);
    expect(r.lancamentos.every((l) => l.conta.kind === "credit_card")).toBe(true);
  });

  it("cartão não tem BANKID: fica `''`, nunca null", () => {
    // No PG17 o `unique` é NULLS DISTINCT por padrão — `NULL` não deduplica, e
    // a fatura importada duas vezes viraria duas linhas.
    expect(r.lancamentos[0]?.conta).toEqual({
      bankId: "",
      acctId: "XXXXXXXXXXXX4321",
      kind: "credit_card",
      acctType: null,
    });
    expect(r.lancamentos[0]?.chaveBruta).toBe("fitid||XXXXXXXXXXXX4321|credit_card|CC0001");
  });

  it("o estorno entra com sinal oposto, não some", () => {
    expect(r.lancamentos.map((l) => l.valorCents)).toEqual([-8990, 8990]);
  });
});

describe("memo-com-sinal.ofx — o `<` que derruba a ofx-js", () => {
  it("o arquivo inteiro sobrevive e a descrição guarda o sinal", () => {
    const r = ler("memo-com-sinal.ofx");
    expect(r.lancamentos).toHaveLength(2);
    expect(r.lancamentos[0]?.descricao).toBe("TARIFA < 5 REAIS & SEM IOF");
    expect(r.descartados).toEqual([]);
  });
});

describe("varredura de tests/fixtures/ofx/", () => {
  // O teste varre a PASTA, não uma lista. Foi o que permitiu o extrato real da
  // Clínica Humana entrar como `cora-meia-noite-gmt.ofx` sem tocar em linha de
  // teste — e foi esta contagem que cobrou o README quando ele entrou.
  const arquivos = readdirSync(FIXTURES)
    .filter((n) => n.endsWith(".ofx"))
    .sort();

  it("a pasta tem as oito fixtures declaradas no README", () => {
    expect(arquivos).toHaveLength(8);
  });

  it.each(arquivos)("%s: parseia, e toda chave é única dentro do arquivo", (nome) => {
    const r = ler(nome);
    expect(r.lancamentos.length).toBeGreaterThan(0);

    const chaves = new Set(r.lancamentos.map((l) => l.chaveBruta));
    // Chave repetida dentro do MESMO arquivo significa que a segunda linha some
    // na importação (o `23505` a engole) — perda silenciosa de lançamento.
    expect(chaves.size).toBe(r.lancamentos.length);

    for (const l of r.lancamentos) {
      expect(l.dia).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isSafeInteger(l.valorCents)).toBe(true);
      expect(l.chaveBruta.startsWith(`${l.chaveOrigem}|`)).toBe(true);
      // A chave sai SEM org: quem hasheia com o `organization_id` é o importador.
      expect(l.moeda).toBe("BRL");
    }
    for (const s of r.saldos) {
      expect(s.dia).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isSafeInteger(s.valorCents)).toBe(true);
    }
    for (const d of r.descartados) {
      // Descarte sem motivo legível é descarte que ninguém consegue explicar
      // ao Dono na tela de importação.
      expect(d.motivo).toMatch(/^[a-z_]+$/);
      expect(d.contexto.length).toBeGreaterThan(0);
    }
  });

  it.each(arquivos)("%s: reler os mesmos bytes dá exatamente o mesmo resultado", (nome) => {
    // Determinismo é o que torna a chave uma chave. Se `extrair` dependesse de
    // `Date.now()`, de ordem de `Map` ou do fuso do processo, a segunda
    // importação criaria lançamento novo.
    expect(ler(nome)).toEqual(ler(nome));
  });
});
