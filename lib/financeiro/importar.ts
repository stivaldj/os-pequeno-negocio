/**
 * Do arquivo OFX às linhas do livro-caixa, sem duplicar.
 *
 * A regra que a issue #24 nomeia: importar o mesmo arquivo duas vezes não cria
 * um lançamento a mais. O caminho é `unique (organization_id, external_id)` no
 * banco mais a captura do `23505` aqui — e **não** um `select` prévio de
 * "isso já existe?", que tem corrida entre a consulta e o insert e deixaria
 * dois cliques no botão duplicarem o extrato.
 *
 * Insert linha a linha, pelo mesmo motivo declarado em
 * `app/api/v1/contacts/import/route.ts`: com índice único, um insert em lote
 * vira tudo-ou-nada — o `23505` de UMA linha repetida descartaria as outras
 * centenas. Aqui isso seria pior que lá, porque reimportar um mês com um dia
 * de sobreposição é o caso normal, não a exceção.
 *
 * Escreve por service role (o admin client bypassa RLS), então filtra
 * `organization_id` à mão em toda linha, resolvido pelo chamador a partir do
 * gate de autenticação e nunca do corpo da requisição.
 *
 * O saldo NÃO sai da soma dos lançamentos: o Dono importa uma janela, e somar
 * a janela não é caixa. `ledger_balances` recebe o `<LEDGERBAL>` que o banco
 * declarou, por `upsert` na chave (org, banco, conta, tipo de conta, tipo de
 * saldo, dia) — reimportar o mesmo arquivo reescreve a linha, não empilha
 * saldo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { categoriaDe, type Categoria } from "./categorizar";
import { externalIdDe } from "./chave";
import { lerOfx } from "./ofx";
import type { ContaDoExtrato, Descartado } from "./ofx/tipos";

export interface OpcoesDaImportacao {
  /** Resolvido do gate de autenticação pelo chamador. NUNCA do body. */
  organizationId: string;
  buffer: Buffer;
  /** Só para a trilha de auditoria — o conteúdo é que manda. */
  nomeDoArquivo: string;
  /** Correlação com a requisição, quando há uma. */
  requestId?: string | null;
  /** Quem subiu o arquivo, quando a origem é a tela. */
  actorUserId?: string | null;
}

export interface ContaImportada {
  bank_id: string;
  account_id: string;
  account_kind: string;
  lancamentos: number;
}

export interface ResumoDaImportacao {
  total_lancamentos: number;
  importados: number;
  duplicados: number;
  /**
   * Quantos lançamentos do arquivo estão em modo frágil (`key_source`
   * `'conteudo'`): sem FITID confiável, a chave é dia + valor + ordinal, e dois
   * lançamentos do mesmo dia e valor só se distinguem pela ordem no arquivo. É
   * contagem do ARQUIVO, não do que entrou — na reimportação nada entra, e o
   * Dono continua precisando de saber que aquela conta está frágil.
   */
  por_conteudo: number;
  saldos_gravados: number;
  descartados: Descartado[];
  contas: ContaImportada[];
}

/** Chave de agrupamento por conta — a mesma tripla que o schema usa. */
function chaveDaConta(c: ContaDoExtrato): string {
  return `${c.bankId}|${c.acctId}|${c.kind}`;
}

/** `char(3)`: o CURDEF do OFX é ISO de três letras; o resto é ruído de banco. */
function moedaDe(raw: string): string {
  const m = raw.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(m) ? m : "BRL";
}

export async function importarExtrato(
  admin: SupabaseClient,
  opts: OpcoesDaImportacao,
): Promise<ResumoDaImportacao> {
  const { organizationId, buffer, nomeDoArquivo } = opts;

  // O teto de `OFX_MAX_LANCAMENTOS` já é cobrado dentro do parser, que para no
  // limite e devolve um `descartado` com motivo `limite_de_lancamentos` e a
  // instrução de importar um período menor. Repetir o teto aqui seria a
  // duplicação sem fonte declarada que o CLAUDE.md proíbe — e, pior, seria a
  // segunda regra a divergir da primeira no dia em que o número mudasse.
  const extrato = lerOfx(buffer);

  // Categorias da organização, lidas uma vez: classificar linha a linha com uma
  // ida ao banco por linha transformaria um extrato de 400 lançamentos em 400
  // consultas idênticas.
  const { data: catData, error: catErr } = await admin
    .from("ledger_categories")
    .select("id, slug, match_terms")
    .eq("organization_id", organizationId);
  if (catErr) throw new Error(`ledger_categories: ${catErr.message}`);
  const categorias = (catData ?? []) as Categoria[];

  const descartados: Descartado[] = [...extrato.descartados];
  const contas = new Map<string, ContaImportada>();
  const moedaPorConta = new Map<string, string>();
  let importados = 0;
  let duplicados = 0;
  let porConteudo = 0;

  for (const l of extrato.lancamentos) {
    const chave = chaveDaConta(l.conta);
    const conta = contas.get(chave) ?? {
      bank_id: l.conta.bankId,
      account_id: l.conta.acctId,
      account_kind: l.conta.kind,
      lancamentos: 0,
    };
    conta.lancamentos += 1;
    contas.set(chave, conta);

    const moeda = moedaDe(l.moeda);
    moedaPorConta.set(chave, moeda);
    if (l.chaveOrigem === "conteudo") porConteudo += 1;

    const { error } = await admin.from("ledger_entries").insert({
      organization_id: organizationId,
      external_id: externalIdDe(organizationId, l.chaveBruta),
      // `bank_id` é `not null default ''` no schema e cartão de crédito não tem
      // BANKID: mandar `null` aqui derrubaria a fatura inteira do Dono.
      bank_id: l.conta.bankId,
      account_id: l.conta.acctId,
      account_kind: l.conta.kind,
      posted_on: l.dia,
      // Assinado: o sinal vem do TRNAMT, nunca do TRNTYPE (OFX 2.2 §3.2.9.2).
      amount_cents: l.valorCents,
      currency: moeda,
      trn_type: l.tipo,
      description: l.descricao,
      fitid: l.fitid,
      checknum: l.checknum,
      key_source: l.chaveOrigem,
      source: "ofx",
      category_id: categoriaDe(l.descricao, categorias),
    });

    if (error) {
      // Violação do único (org, external_id) = já importado. É o desfecho
      // esperado da segunda importação, não um erro.
      if (error.code === "23505") {
        duplicados += 1;
        continue;
      }
      // Uma linha que o banco recusou não derruba o arquivo inteiro — vira
      // motivo legível no resumo, como as linhas que o parser recusou.
      descartados.push({
        motivo: "erro_ao_gravar",
        contexto: `${l.conta.bankId}/${l.conta.acctId} · ${l.dia} · ${l.descricao} · ${error.message}`,
      });
      continue;
    }
    importados += 1;
  }

  // ─── Saldos ───────────────────────────────────────────────────────────────
  //
  // Deduplicados pela chave do `unique` ANTES de subir: dois saldos iguais no
  // mesmo `upsert` fazem o Postgres recusar o comando inteiro ("cannot affect
  // row a second time"), e aí o Dono perderia o caixa por causa de um arquivo
  // que repetiu o LEDGERBAL.
  const saldos = new Map<string, Record<string, unknown>>();
  for (const s of extrato.saldos) {
    const chave = chaveDaConta(s.conta);
    saldos.set(`${chave}|${s.tipo}|${s.dia}`, {
      organization_id: organizationId,
      bank_id: s.conta.bankId,
      account_id: s.conta.acctId,
      account_kind: s.conta.kind,
      kind: s.tipo,
      as_of: s.dia,
      balance_cents: s.valorCents,
      currency: moedaPorConta.get(chave) ?? "BRL",
    });
  }
  let saldosGravados = 0;
  if (saldos.size > 0) {
    const linhas = [...saldos.values()];
    const { error } = await admin.from("ledger_balances").upsert(linhas, {
      onConflict: "organization_id,bank_id,account_id,account_kind,kind,as_of",
    });
    if (error) {
      descartados.push({ motivo: "saldo_nao_gravado", contexto: error.message });
    } else {
      saldosGravados = linhas.length;
    }
  }

  const resumo: ResumoDaImportacao = {
    total_lancamentos: extrato.lancamentos.length,
    importados,
    duplicados,
    por_conteudo: porConteudo,
    saldos_gravados: saldosGravados,
    descartados,
    contas: [...contas.values()],
  };

  // Audit fica aqui dentro, e não na rota: a lib é o único ponto por onde um
  // extrato vira linha, e a trilha tem de valer também para a prova de
  // realidade, que não passa pela rota HTTP.
  await audit({
    action: "financeiro.extrato_importado",
    actorUserId: opts.actorUserId ?? null,
    organizationId,
    resourceType: "ledger_entries",
    resourceId: null,
    requestId: opts.requestId ?? null,
    metadata: {
      arquivo: nomeDoArquivo,
      versao_ofx: extrato.versao,
      total_lancamentos: resumo.total_lancamentos,
      importados,
      duplicados,
      por_conteudo: porConteudo,
      saldos_gravados: saldosGravados,
      // Só a contagem: o `contexto` de um descartado carrega a descrição que o
      // banco escreveu, e a trilha de auditoria não é lugar de extrato.
      descartados: descartados.length,
      contas: resumo.contas.map((c) => ({
        bank_id: c.bank_id,
        account_kind: c.account_kind,
        lancamentos: c.lancamentos,
      })),
    },
  });

  return resumo;
}
