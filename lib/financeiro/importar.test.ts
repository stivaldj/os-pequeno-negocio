/**
 * A prova que a issue #24 nomeia: importar o mesmo extrato duas vezes não cria
 * um lançamento a mais. E a prova da decisão 6 do plano: a chave de fallback
 * NÃO usa a descrição — reimportar com os `MEMO` reescritos pelo banco continua
 * devolvendo `importados: 0`.
 *
 * O dublê do supabase-js implementa o que o importador realmente depende: o
 * `unique (organization_id, external_id)` devolvendo `23505` e o `upsert` com
 * `onConflict`. Sem isso o teste passaria com um Map qualquer e não provaria a
 * idempotência, que é toda a tarefa.
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: vi.fn(() => true),
}));

const { audit } = await import("@/lib/audit");
const { importarExtrato } = await import("./importar");
const { externalIdDe } = await import("./chave");
const { lerOfx } = await import("./ofx");

const ORG = "org-clinica-humana";
const OUTRA_ORG = "org-outra";

function fixture(nome: string): Buffer {
  return readFileSync(`tests/fixtures/ofx/${nome}`);
}

type Linha = Record<string, unknown>;
interface ErroFalso {
  code: string;
  message: string;
}

/** Dublê do admin client: índice único de verdade, `23505` de verdade. */
function criarAdmin() {
  const entries: Linha[] = [];
  const balances: Linha[] = [];
  const upserts: { linhas: Linha[]; onConflict?: string }[] = [];
  const filtros: { tabela: string; coluna: string; valor: unknown }[] = [];
  const unico = new Set<string>();
  let categorias: Linha[] = [];
  let falha: ((row: Linha) => ErroFalso | null) | null = null;
  let falhaNoUpsert: ErroFalso | null = null;

  const client = {
    from(tabela: string) {
      return {
        select(_colunas: string) {
          const q = {
            eq(coluna: string, valor: unknown) {
              filtros.push({ tabela, coluna, valor });
              return q;
            },
            then(ok: (r: unknown) => unknown) {
              return ok({ data: tabela === "ledger_categories" ? categorias : [], error: null });
            },
          };
          return q;
        },
        insert(row: Linha) {
          return {
            then(ok: (r: unknown) => unknown) {
              const forcada = falha?.(row) ?? null;
              if (forcada) return ok({ data: null, error: forcada });
              const chave = `${String(row.organization_id)}|${String(row.external_id)}`;
              if (unico.has(chave)) {
                return ok({
                  data: null,
                  error: {
                    code: "23505",
                    message:
                      'duplicate key value violates unique constraint "ledger_entries_organization_id_external_id_key"',
                  },
                });
              }
              unico.add(chave);
              entries.push(row);
              return ok({ data: null, error: null });
            },
          };
        },
        upsert(linhas: Linha[], opts?: { onConflict?: string }) {
          return {
            then(ok: (r: unknown) => unknown) {
              upserts.push({ linhas, onConflict: opts?.onConflict });
              if (falhaNoUpsert) return ok({ data: null, error: falhaNoUpsert });
              const colunas = (opts?.onConflict ?? "").split(",");
              const chaveDe = (l: Linha) => colunas.map((c) => String(l[c])).join("|");
              for (const l of linhas) {
                const i = balances.findIndex((b) => chaveDe(b) === chaveDe(l));
                if (i >= 0) balances[i] = l;
                else balances.push(l);
              }
              return ok({ data: null, error: null });
            },
          };
        },
      };
    },
  };

  return {
    admin: client as never,
    entries,
    balances,
    upserts,
    filtros,
    semearCategorias(c: Linha[]) {
      categorias = c;
    },
    falharInsert(f: ((row: Linha) => ErroFalso | null) | null) {
      falha = f;
    },
    falharUpsert(e: ErroFalso | null) {
      falhaNoUpsert = e;
    },
  };
}

beforeEach(() => {
  vi.mocked(audit).mockClear();
});

describe("importarExtrato", () => {
  it("lê o extrato, grava lançamentos assinados e os saldos declarados pelo banco", async () => {
    const db = criarAdmin();
    const r = await importarExtrato(db.admin, {
      organizationId: ORG,
      buffer: fixture("bradesco-like.ofx"),
      nomeDoArquivo: "extrato-agosto.ofx",
    });

    expect(r).toMatchObject({
      total_lancamentos: 2,
      importados: 2,
      duplicados: 0,
      por_conteudo: 0,
      saldos_gravados: 2,
      descartados: [],
      contas: [{ bank_id: "237", account_id: "00012345-6", account_kind: "bank", lancamentos: 2 }],
    });

    // A saída é negativa porque o TRNAMT é negativo — nunca porque o TRNTYPE
    // diz DEBIT (OFX 2.2 §3.2.9.2).
    expect(db.entries[0]).toMatchObject({
      organization_id: ORG,
      bank_id: "237",
      account_id: "00012345-6",
      account_kind: "bank",
      posted_on: "2026-08-03",
      amount_cents: -53086,
      currency: "BRL",
      trn_type: "DEBIT",
      description: "PAGTO CARTÃO & COBRANÇA",
      fitid: "000000000001",
      checknum: "000000000001",
      key_source: "fitid",
      source: "ofx",
      category_id: null,
    });
    expect(db.entries[1]).toMatchObject({ amount_cents: 84710, trn_type: "CREDIT" });

    // O caixa sai do LEDGERBAL com seu DTASOF, não da soma dos lançamentos
    // (-530,86 + 847,10 = 316,24 ≠ 1316,24).
    expect(db.balances).toEqual([
      expect.objectContaining({ kind: "ledger", as_of: "2026-08-31", balance_cents: 131624, currency: "BRL" }),
      expect.objectContaining({ kind: "available", as_of: "2026-08-31", balance_cents: 120000 }),
    ]);
    expect(db.upserts[0]?.onConflict).toBe(
      "organization_id,bank_id,account_id,account_kind,kind,as_of",
    );

    // Service role bypassa RLS: a leitura de categorias filtra a org à mão.
    expect(db.filtros).toContainEqual({
      tabela: "ledger_categories",
      coluna: "organization_id",
      valor: ORG,
    });
  });

  it("a segunda importação do mesmo arquivo devolve importados: 0", async () => {
    const db = criarAdmin();
    const buffer = fixture("bradesco-like.ofx");
    const opts = { organizationId: ORG, buffer, nomeDoArquivo: "extrato-agosto.ofx" };

    const primeira = await importarExtrato(db.admin, opts);
    const segunda = await importarExtrato(db.admin, opts);

    expect(primeira.importados).toBe(2);
    expect(segunda).toMatchObject({ total_lancamentos: 2, importados: 0, duplicados: 2 });
    expect(db.entries).toHaveLength(2); // nada empilhou
    // Nem o saldo: o upsert reescreve a mesma linha na chave da conta.
    expect(db.balances).toHaveLength(2);
    expect(db.upserts).toHaveLength(2);
  });

  it("reimportar com os MEMO trocados AINDA devolve importados: 0 (a chave não usa a descrição)", async () => {
    const db = criarAdmin();
    const original = fixture("fitid-repetido.ofx");
    // Bancos brasileiros reescrevem a descrição entre um extrato e o seguinte.
    // Se a chave de fallback dependesse do MEMO, esta segunda importação
    // geraria `external_id` novo, não haveria 23505, e o caixa somaria
    // lançamentos duplicados — saldo errado ao Dono sem nada ficar vermelho.
    let n = 0;
    const trocado = Buffer.from(
      original.toString("latin1").replace(/<MEMO>[^\r\n<]*/g, () => `<MEMO>DESCRICAO REESCRITA ${++n}`),
      "latin1",
    );

    // Guarda contra teste vacuário: as descrições têm mesmo de ter mudado, e as
    // chaves de idempotência têm de ter ficado iguais.
    const antes = lerOfx(original).lancamentos;
    const depois = lerOfx(trocado).lancamentos;
    expect(depois.map((l) => l.descricao)).not.toEqual(antes.map((l) => l.descricao));
    expect(depois.map((l) => l.chaveBruta)).toEqual(antes.map((l) => l.chaveBruta));

    const primeira = await importarExtrato(db.admin, {
      organizationId: ORG,
      buffer: original,
      nomeDoArquivo: "setembro.ofx",
    });
    const segunda = await importarExtrato(db.admin, {
      organizationId: ORG,
      buffer: trocado,
      nomeDoArquivo: "setembro-de-novo.ofx",
    });

    expect(primeira.importados).toBe(4);
    expect(segunda.importados).toBe(0);
    expect(segunda.duplicados).toBe(4);
    expect(db.entries).toHaveLength(4);
    // As descrições gravadas continuam as do primeiro arquivo.
    expect(db.entries.map((e) => e.description)).toEqual([
      "TARIFA PACOTE SERVICOS",
      "IOF",
      "SAQUE TERMINAL 1",
      "SAQUE TERMINAL 2",
    ]);
  });

  it("FITID repetido põe a conta inteira em modo frágil e o resumo mostra por_conteudo", async () => {
    const db = criarAdmin();
    const r = await importarExtrato(db.admin, {
      organizationId: ORG,
      buffer: fixture("fitid-repetido.ofx"),
      nomeDoArquivo: "setembro.ofx",
    });

    expect(r.importados).toBe(4);
    // O Dono precisa de saber que aquela conta está no modo frágil: sem FITID
    // confiável, dois lançamentos do mesmo dia e valor só se distinguem pelo
    // ordinal — e é o que as duas últimas linhas da fixture são.
    expect(r.por_conteudo).toBe(4);
    expect(db.entries.every((e) => e.key_source === "conteudo")).toBe(true);
    expect(new Set(db.entries.map((e) => e.external_id)).size).toBe(4);
  });

  it("TRNAMT ilegível vira descartado e NÃO grava lançamento de valor zero", async () => {
    const db = criarAdmin();
    const r = await importarExtrato(db.admin, {
      organizationId: ORG,
      buffer: fixture("caixa-decimal-quebrado.ofx"),
      nomeDoArquivo: "caixa.ofx",
    });

    expect(r.importados).toBe(2);
    expect(db.entries.some((e) => e.amount_cents === 0)).toBe(false);
    expect(r.descartados).toContainEqual(
      expect.objectContaining({ motivo: "valor_ilegivel" }),
    );
    // Saldo ilegível também não vira zero: a conta fica SEM saldo.
    expect(r.descartados).toContainEqual(expect.objectContaining({ motivo: "saldo_ilegivel" }));
    expect(r.saldos_gravados).toBe(0);
    expect(db.balances).toHaveLength(0);
    expect(db.upserts).toHaveLength(0);
  });

  it("cartão de crédito grava bank_id vazio, nunca null", async () => {
    const db = criarAdmin();
    const r = await importarExtrato(db.admin, {
      organizationId: ORG,
      buffer: fixture("cartao.ofx"),
      nomeDoArquivo: "fatura.ofx",
    });

    // `bank_id` é `not null default ''` no schema (e `unique` no PG17 é NULLS
    // DISTINCT): `null` aqui derrubaria a fatura e faria o saldo empilhar.
    expect(db.entries.every((e) => e.bank_id === "")).toBe(true);
    expect(db.entries.every((e) => e.bank_id !== null)).toBe(true);
    expect(db.balances[0]).toMatchObject({ bank_id: "", account_kind: "credit_card", balance_cents: -124055 });
    expect(r.contas).toEqual([
      { bank_id: "", account_id: "XXXXXXXXXXXX4321", account_kind: "credit_card", lancamentos: 2 },
    ]);
  });

  it("conta o arquivo com duas contas separadamente", async () => {
    const db = criarAdmin();
    const r = await importarExtrato(db.admin, {
      organizationId: ORG,
      buffer: fixture("duas-contas.ofx"),
      nomeDoArquivo: "duas.ofx",
    });
    expect(r.importados).toBe(3);
    expect(r.contas).toEqual([
      { bank_id: "001", account_id: "11111-1", account_kind: "bank", lancamentos: 2 },
      { bank_id: "001", account_id: "22222-2", account_kind: "bank", lancamentos: 1 },
    ]);
    expect(r.saldos_gravados).toBe(2);
  });

  it("classifica o lançamento pela categoria da organização na hora do insert", async () => {
    const db = criarAdmin();
    db.semearCategorias([
      { id: "cat-cartao", slug: "cartao", match_terms: ["CARTAO"] },
      { id: "cat-receita", slug: "receita", match_terms: ["CRÉDITO EM CONTA"] },
    ]);
    await importarExtrato(db.admin, {
      organizationId: ORG,
      buffer: fixture("bradesco-like.ofx"),
      nomeDoArquivo: "extrato.ofx",
    });
    // "PAGTO CARTÃO & COBRANÇA" casa "CARTAO" sem acento.
    expect(db.entries[0]?.category_id).toBe("cat-cartao");
    expect(db.entries[1]?.category_id).toBe("cat-receita");
  });

  it("organizações diferentes nunca colidem no external_id", async () => {
    const db = criarAdmin();
    const buffer = fixture("bradesco-like.ofx");
    await importarExtrato(db.admin, { organizationId: ORG, buffer, nomeDoArquivo: "e.ofx" });
    const outra = await importarExtrato(db.admin, {
      organizationId: OUTRA_ORG,
      buffer,
      nomeDoArquivo: "e.ofx",
    });
    expect(outra.importados).toBe(2);
    expect(outra.duplicados).toBe(0);
    expect(db.entries).toHaveLength(4);

    const chave = "fitid|237|00012345-6|bank|000000000001";
    expect(externalIdDe(ORG, chave)).toBe(externalIdDe(ORG, chave)); // determinística
    expect(externalIdDe(ORG, chave)).not.toBe(externalIdDe(OUTRA_ORG, chave));
    // O separador não é decoração: sem ele "org1"+"2abc" e "org12"+"abc"
    // dariam o mesmo hash, e duas organizações compartilhariam idempotência.
    expect(externalIdDe("org1", "2abc")).not.toBe(externalIdDe("org12", "abc"));
    expect(externalIdDe(ORG, chave)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("erro do banco numa linha vira descartado e não derruba as outras", async () => {
    const db = criarAdmin();
    db.falharInsert((row) =>
      row.description === "PAGTO CARTÃO & COBRANÇA"
        ? { code: "23514", message: 'violates check constraint "ledger_entries_trn_type_check"' }
        : null,
    );
    const r = await importarExtrato(db.admin, {
      organizationId: ORG,
      buffer: fixture("bradesco-like.ofx"),
      nomeDoArquivo: "extrato.ofx",
    });
    expect(r.importados).toBe(1);
    expect(r.duplicados).toBe(0);
    expect(r.descartados).toContainEqual(
      expect.objectContaining({ motivo: "erro_ao_gravar", contexto: expect.stringContaining("check constraint") }),
    );
    expect(db.entries).toHaveLength(1);
  });

  it("saldo que o banco recusa vira descartado, e os lançamentos ficam", async () => {
    const db = criarAdmin();
    db.falharUpsert({ code: "23505", message: "ledger_balances_conta_tipo_dia_key" });
    const r = await importarExtrato(db.admin, {
      organizationId: ORG,
      buffer: fixture("bradesco-like.ofx"),
      nomeDoArquivo: "extrato.ofx",
    });
    expect(r.importados).toBe(2);
    expect(r.saldos_gravados).toBe(0);
    expect(r.descartados).toContainEqual(expect.objectContaining({ motivo: "saldo_nao_gravado" }));
  });

  it("para no teto de lançamentos do parser e leva a instrução ao resumo", async () => {
    const db = criarAdmin();
    const { OFX_MAX_LANCAMENTOS } = await import("./ofx/tipos");
    const transacoes = Array.from(
      { length: OFX_MAX_LANCAMENTOS + 1 },
      (_, i) =>
        `<STMTTRN>\r\n<TRNTYPE>DEBIT\r\n<DTPOSTED>20260901\r\n<TRNAMT>-1,00\r\n<FITID>F${i}\r\n<MEMO>LINHA ${i}\r\n</STMTTRN>`,
    ).join("\r\n");
    const gigante = Buffer.from(
      [
        "OFXHEADER:100",
        "DATA:OFXSGML",
        "VERSION:102",
        "SECURITY:NONE",
        "ENCODING:USASCII",
        "CHARSET:1252",
        "COMPRESSION:NONE",
        "OLDFILEUID:NONE",
        "NEWFILEUID:NONE",
        "",
        "<OFX>",
        "<BANKMSGSRSV1>",
        "<STMTTRNRS>",
        "<STMTRS>",
        "<CURDEF>BRL",
        "<BANKACCTFROM>",
        "<BANKID>001",
        "<ACCTID>99999-9",
        "<ACCTTYPE>CHECKING",
        "</BANKACCTFROM>",
        "<BANKTRANLIST>",
        transacoes,
        "</BANKTRANLIST>",
        "</STMTRS>",
        "</STMTTRNRS>",
        "</BANKMSGSRSV1>",
        "</OFX>",
        "",
      ].join("\r\n"),
      "latin1",
    );

    const r = await importarExtrato(db.admin, {
      organizationId: ORG,
      buffer: gigante,
      nomeDoArquivo: "ano-inteiro.ofx",
    });

    // O teto é do parser (um lugar só). O importador não repete a regra: leva o
    // motivo ao resumo, para que a tela diga ao Dono o que fazer em vez de
    // engolir 5001 linhas em silêncio.
    expect(r.importados).toBe(OFX_MAX_LANCAMENTOS);
    expect(db.entries).toHaveLength(OFX_MAX_LANCAMENTOS);
    expect(r.descartados).toContainEqual(
      expect.objectContaining({
        motivo: "limite_de_lancamentos",
        contexto: expect.stringContaining("importe um período menor"),
      }),
    );
  });

  it("audita a importação com as contagens, e sem a descrição do banco", async () => {
    const db = criarAdmin();
    await importarExtrato(db.admin, {
      organizationId: ORG,
      buffer: fixture("caixa-decimal-quebrado.ofx"),
      nomeDoArquivo: "caixa.ofx",
      requestId: "req-1",
      actorUserId: "user-1",
    });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "financeiro.extrato_importado",
        organizationId: ORG,
        actorUserId: "user-1",
        requestId: "req-1",
        resourceType: "ledger_entries",
        metadata: expect.objectContaining({
          arquivo: "caixa.ofx",
          importados: 2,
          duplicados: 0,
          por_conteudo: 2,
          saldos_gravados: 0,
          descartados: 2,
        }),
      }),
    );
    // A trilha de auditoria não é lugar de extrato: só contagem, e a conta sem
    // o número dela.
    const metadata = vi.mocked(audit).mock.calls[0]?.[0].metadata as Record<string, unknown>;
    expect(JSON.stringify(metadata)).not.toContain("SALDO DIA");
    expect(JSON.stringify(metadata)).not.toContain("0001300099");
  });
});
