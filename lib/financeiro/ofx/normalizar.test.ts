/**
 * Valor, data, tipo e descrição — as quatro conversões onde errar custa caro.
 *
 * A tabela de `paraCentavos` é a mesa do plano da Fase 6, inteira. A de
 * `diaDoDtposted` guarda a armadilha do fuso, que só aparece em produção e só
 * em alguns dias do ano.
 */
import { describe, expect, it } from "vitest";

import {
  descricaoDe,
  diaDoDtposted,
  paraCentavos,
  tipoDeTransacao,
} from "@/lib/financeiro/ofx/normalizar";
import { parseReaisToCents } from "@/lib/money";
import { tokenizar, filho, type No } from "@/lib/financeiro/ofx/tokenizer";
import { TRN_TYPES } from "@/lib/financeiro/ofx/tipos";

describe("paraCentavos", () => {
  it.each([
    // Vírgula decimal com padding — Bradesco e Santander mandam exatamente assim.
    ["-1.234,56", -123456],
    ["            847,10", 84710],
    ["-530,86", -53086],
    ["            -11,76", -1176],
    // Ponto decimal (OFX 2.x e bancos que seguem a spec ao pé da letra).
    ["-12.0", -1200],
    ["1316.24", 131624],
    // Sem separador: o ponto decimal é implícito no fim (§3.2.9.2), `550.` = R$ 550,00.
    ["550", 55000],
    ["0", 0],
    ["+47,01", 4701],
  ])("%s → %s", (raw, esperado) => {
    expect(paraCentavos(raw)).toBe(esperado);
  });

  it.each([
    // Um separador com 3+ dígitos depois: milhar OU decimal, e o arquivo não
    // diz qual. Recusa, jamais adivinhação — num livro-caixa o erro é de 100x.
    ["1.234"],
    ["1,234"],
    ["1.234.567"],
    // Forma de número, nenhum dígito. `.` é o que a Caixa manda, e virar 0 seria
    // pior que falhar: zero entra no caixa como lançamento VÁLIDO.
    [""],
    ["."],
    ["            .  "],
    [","],
    ["-"],
    // Não é número.
    ["abc"],
    ["R$ 10,00"],
    ["10-20"],
  ])("recusa %s", (raw) => {
    expect(paraCentavos(raw)).toBeNull();
  });

  it("`.` NUNCA vira 0 — a distinção que o livro-caixa exige", () => {
    expect(paraCentavos("            .  ")).toBeNull();
    expect(paraCentavos("0,00")).toBe(0);
    // As duas coisas são diferentes: uma é "não sei", a outra é "sei que é zero".
  });

  it("nunca usa parseFloat: `1.005` não vira 100,49999999999999", () => {
    // Medido: `parseFloat("1.005") * 100 === 100.49999999999999`. A conversão
    // aqui é por string com BigInt, exata por construção. (E `1.005` é recusado
    // de todo modo pela regra do separador ambíguo — as duas guardas somam.)
    expect(parseFloat("1.005") * 100).not.toBe(100.5);
    expect(paraCentavos("1.005")).toBeNull();
    expect(paraCentavos("1,005")).toBeNull();
  });

  it("divergência DECLARADA com parseReaisToCents — duas regras, dois problemas", () => {
    // `lib/money.ts` lê DIGITAÇÃO HUMANA de formulário, onde `1.234` quase
    // sempre é milhar e ele acerta ao devolver 123400. `paraCentavos` lê
    // FORMATO DE FIO DE BANCO, onde a spec proíbe separador de milhar: ali o
    // mesmo texto é arquivo torto, e adivinhar custa 100x no caixa do Dono.
    // Este teste existe para que a divergência seja intencional e visível, não
    // "duplicação sem fonte declarada" (anti-pattern nomeado no CLAUDE.md).
    expect(parseReaisToCents("1.234")).toBe(123400);
    expect(paraCentavos("1.234")).toBeNull();
    // E onde não há ambiguidade, os dois concordam.
    expect(parseReaisToCents("249,90")).toBe(paraCentavos("249,90"));
  });

  it("valor absurdo que estouraria o inteiro seguro é recusado, não truncado", () => {
    expect(paraCentavos("999999999999999999999,99")).toBeNull();
  });
});

describe("diaDoDtposted", () => {
  it.each([
    // Sem hora e sem offset: data CIVIL. O dia sai por fatia de string.
    ["20100826", "2010-08-26"],
    ["20150730120000", "2015-07-30"],
    ["20260803", "2026-08-03"],
    // Com offset há instante de verdade — e ele vira dia em America/Sao_Paulo.
    ["20260106000000[-3:GMT]", "2026-01-06"],
    ["20260805120000[-3:BRT]", "2026-08-05"],
    ["20150730120000.000[-3:BRT]", "2015-07-30"],
    ["20260106030000[0:GMT]", "2026-01-06"],
    // Meia-noite cravada é data civil, não instante — o formato da Cora.
    ["20250901000000[0:GMT]", "2025-09-01"],
    ["20250901000000.000[0:GMT]", "2025-09-01"],
    ["20250901[0:GMT]", "2025-09-01"],
  ])("%s → %s", (raw, esperado) => {
    expect(diaDoDtposted(raw)).toBe(esperado);
  });

  it("o caso da Cora: meia-noite em GMT não empurra o lançamento para o mês anterior", () => {
    // Medido no extrato real de 01/09/2025 da Clínica Humana (Cora SCD SA, FID
    // 0403). Os TRÊS lançamentos, o DTSTART, o DTEND e o LEDGERBAL vêm todos
    // com `000000[0:GMT]`, e o nome do arquivo do banco diz `01092025_a_01092025`.
    // Tratado como instante, 00:00Z é 21h de 31/08 em Brasília: R$ 10.000,00 de
    // receita de setembro caíam em agosto, e o Dono conferindo com o app da Cora
    // via data diferente da nossa.
    expect(diaDoDtposted("20250901000000[0:GMT]")).toBe("2025-09-01");

    // A mesma data sem o sufixo já respondia certo. Era o `[0:GMT]` que movia.
    expect(diaDoDtposted("20250901000000")).toBe("2025-09-01");

    // O controle que mostra por que 169 testes não pegaram: às 03:00Z a
    // conversão para Brasília cai em meia-noite do MESMO dia, então o defeito
    // some. Era o único `[0:GMT]` coberto.
    expect(diaDoDtposted("20260106030000[0:GMT]")).toBe("2026-01-06");
  });

  it("hora de verdade continua sendo instante, mesmo em GMT", () => {
    // A regra nova é sobre meia-noite CRAVADA, não sobre offset zero. O
    // `DTSERVER` do mesmo arquivo da Cora traz `105313` — hora real — e um
    // lançamento às 02:00Z pertence ao dia anterior em Brasília, como sempre.
    expect(diaDoDtposted("20250901020000[0:GMT]")).toBe("2025-08-31");
    expect(diaDoDtposted("20250901000001[0:GMT]")).toBe("2025-08-31");
  });

  it("o caso que UTC estragaria: 23h de 31/08 em -3 continua sendo 31/08", () => {
    // `20170831230000[-3:BRT]` é 2017-09-01T02:00Z. Quem converte para UTC lê
    // 01/09 e move o lançamento de mês — e o fechamento do mês do Dono passa a
    // mentir. O nome entre colchetes mente com frequência (banco manda
    // `[-3:GMT]`); só o número é lido.
    expect(diaDoDtposted("20170831230000[-3:BRT]")).toBe("2017-08-31");
    expect(new Date(Date.UTC(2017, 7, 31, 23) + 3 * 3_600_000).toISOString().slice(0, 10)).toBe(
      "2017-09-01",
    );
  });

  it("sem offset NÃO passa por Date: 20100826 é 26/08 em qualquer fuso do processo", () => {
    // `new Date("20100826")` lido em Cuiabá (UTC-4) volta 25/08 — medido. Um
    // lançamento que muda de dia estraga "o que venceu hoje".
    expect(diaDoDtposted("20100826")).toBe("2010-08-26");
    expect(diaDoDtposted("20100101")).toBe("2010-01-01");
    expect(diaDoDtposted("20261231")).toBe("2026-12-31");
  });

  it.each([
    [""],
    ["2026"],
    ["20260230"], // forma certa, dia inexistente
    ["20260931"],
    ["2026-08-03"], // ISO não é DTPOSTED
    ["abcdefgh"],
    ["20260803999999"],
  ])("recusa %s", (raw) => {
    expect(diaDoDtposted(raw)).toBeNull();
  });

  it("29/02 em ano bissexto continua valendo — a guarda não pode ser larga demais", () => {
    expect(diaDoDtposted("20240229")).toBe("2024-02-29");
    expect(diaDoDtposted("20230229")).toBeNull();
  });
});

describe("tipoDeTransacao", () => {
  it("os 18 da §11.4.4.3 passam inteiros", () => {
    for (const t of TRN_TYPES) expect(tipoDeTransacao(t)).toBe(t);
    expect(TRN_TYPES).toHaveLength(18);
  });

  it.each(["PIX", "", "  ", "TED", "boleto"])("`%s` fora da lista vira OTHER, sem lançar", (raw) => {
    // O tipo é RÓTULO. Foi classificar crédito/débito por ele que fez a
    // `ofx-data-extractor@1.5.0` reportar +94,02 de crédito num extrato que
    // soma exatamente R$ 0,00. O sinal do dinheiro está no TRNAMT.
    expect(tipoDeTransacao(raw)).toBe("OTHER");
  });

  it("caixa e espaço não atrapalham", () => {
    expect(tipoDeTransacao(" debit ")).toBe("DEBIT");
  });
});

describe("descricaoDe", () => {
  const trn = (sgml: string): No => filho(tokenizar(`<OFX>\r\n${sgml}\r\n</OFX>\r\n`), "OFX")!;

  it("prefere MEMO, cai para NAME e depois EXTDNAME", () => {
    expect(descricaoDe(trn("<MEMO>memo\r\n<NAME>nome"))).toBe("memo");
    expect(descricaoDe(trn("<NAME>nome"))).toBe("nome");
    expect(descricaoDe(trn("<EXTDNAME>estendido"))).toBe("estendido");
    expect(descricaoDe(trn("<TRNTYPE>DEBIT"))).toBe("");
  });

  it("colapsa o padding do banco — `PIX    ENVIADO` e `PIX ENVIADO` são a mesma frase", () => {
    expect(descricaoDe(trn("<MEMO>  PIX \t   ENVIADO  "))).toBe("PIX ENVIADO");
  });
});
