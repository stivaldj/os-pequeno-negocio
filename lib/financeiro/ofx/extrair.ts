/**
 * Da árvore tokenizada aos lançamentos e saldos — e à chave de idempotência.
 *
 * Percorre os dois ramos que interessam (`BANKMSGSRSV1` para conta corrente e
 * `CREDITCARDMSGSRSV1` para fatura de cartão), sempre por `asArray`, porque em
 * SGML sem fechamento um filho vira objeto e dois viram array.
 *
 * O que este arquivo NÃO faz: banco, Supabase, `organization_id`. A `chaveBruta`
 * sai sem org de propósito — quem persiste hasheia org + chave.
 */
import {
  OFX_MAX_LANCAMENTOS,
  type ContaDoExtrato,
  type Descartado,
  type LancamentoOfx,
  type SaldoOfx,
} from "./tipos";
import { descricaoDe, diaDoDtposted, paraCentavos, tipoDeTransacao } from "./normalizar";
import { filho, filhos, texto, type No } from "./tokenizer";

export interface ExtracaoOfx {
  lancamentos: LancamentoOfx[];
  saldos: SaldoOfx[];
  descartados: Descartado[];
}

/** Um `STMTTRN` já lido, antes de a chave ser decidida (que é por CONTA). */
interface Candidato {
  tipo: LancamentoOfx["tipo"];
  dia: string;
  dtpostedBruto: string;
  valorCents: number;
  fitid: string | null;
  checknum: string | null;
  descricao: string;
}

function contaDeBanco(acct: No): ContaDoExtrato {
  return {
    bankId: texto(acct, "BANKID") ?? "",
    acctId: texto(acct, "ACCTID") ?? "",
    kind: "bank",
    acctType: texto(acct, "ACCTTYPE"),
  };
}

function contaDeCartao(acct: No): ContaDoExtrato {
  return {
    // Cartão não tem `BANKID`. `""` e não `null` porque o `unique` do banco
    // precisa dedupar, e no PG17 `NULL` é distinto de `NULL` por padrão.
    bankId: "",
    acctId: texto(acct, "ACCTID") ?? "",
    kind: "credit_card",
    acctType: null,
  };
}

function rotulo(conta: ContaDoExtrato): string {
  return conta.bankId === "" ? conta.acctId : `${conta.bankId}/${conta.acctId}`;
}

/**
 * O `FITID` só serve como identificador se o banco o honrar: presente em TODA
 * transação da conta, diferente de `"0"` (a Caixa manda `0` em linha sintética)
 * e sem repetição dentro do arquivo (o Santander repete). Basta uma transação
 * quebrar para a conta INTEIRA cair para a chave por conteúdo — chave meio
 * `fitid` meio `conteudo` na mesma conta reimportaria como lançamento novo.
 *
 * A conferência olha TODAS as transações da conta, inclusive as que serão
 * descartadas por valor ou data ilegível: honrar o `FITID` é propriedade do
 * arquivo do banco, não do subconjunto que sobreviveu ao parse.
 */
function fitidServe(fitids: Array<string | null>): boolean {
  const vistos = new Set<string>();
  for (const f of fitids) {
    if (f === null || f === "" || f === "0") return false;
    if (vistos.has(f)) return false;
    vistos.add(f);
  }
  return fitids.length > 0;
}

export function extrair(raiz: No): ExtracaoOfx {
  const ofx = filho(raiz, "OFX") ?? raiz;
  const lancamentos: LancamentoOfx[] = [];
  const saldos: SaldoOfx[] = [];
  const descartados: Descartado[] = [];
  /** Estourou o teto: para de ler e diz. Uma vez só, não uma por linha. */
  let estourou = false;

  const extratos: Array<{ conta: ContaDoExtrato; stmt: No }> = [];

  for (const msgs of filhos(ofx, "BANKMSGSRSV1")) {
    for (const trnrs of filhos(msgs, "STMTTRNRS")) {
      for (const stmt of filhos(trnrs, "STMTRS")) {
        const acct = filho(stmt, "BANKACCTFROM");
        if (acct === undefined) continue;
        extratos.push({ conta: contaDeBanco(acct), stmt });
      }
    }
  }
  for (const msgs of filhos(ofx, "CREDITCARDMSGSRSV1")) {
    for (const trnrs of filhos(msgs, "CCSTMTTRNRS")) {
      for (const stmt of filhos(trnrs, "CCSTMTRS")) {
        const acct = filho(stmt, "CCACCTFROM");
        if (acct === undefined) continue;
        extratos.push({ conta: contaDeCartao(acct), stmt });
      }
    }
  }

  for (const { conta, stmt } of extratos) {
    const moeda = texto(stmt, "CURDEF") ?? "BRL";
    const onde = rotulo(conta);

    // ── Transações ────────────────────────────────────────────────────────
    const brutas: No[] = [];
    for (const lista of filhos(stmt, "BANKTRANLIST")) {
      for (const t of filhos(lista, "STMTTRN")) brutas.push(t);
    }

    const candidatos: Candidato[] = [];
    const fitidsDaConta: Array<string | null> = [];

    for (const t of brutas) {
      const fitid = texto(t, "FITID");
      fitidsDaConta.push(fitid);

      const dtpostedBruto = texto(t, "DTPOSTED") ?? "";
      const trnamt = texto(t, "TRNAMT") ?? "";
      const descricao = descricaoDe(t);
      const contexto = `${onde} · ${dtpostedBruto || "sem data"} · ${descricao || "sem descrição"}`;

      // Correção de lançamento existe na spec e não é aplicável sem o histórico
      // completo. Registrar é honesto; aplicar pela metade seria corromper o caixa.
      if (texto(t, "CORRECTFITID") !== null || texto(t, "CORRECTACTION") !== null) {
        descartados.push({ motivo: "correcao_nao_suportada", contexto });
        continue;
      }

      const dia = diaDoDtposted(dtpostedBruto);
      if (dia === null) {
        descartados.push({ motivo: "data_ilegivel", contexto });
        continue;
      }
      const valorCents = paraCentavos(trnamt);
      if (valorCents === null) {
        // Aqui o `null` NÃO vira 0: zero entraria no livro-caixa como
        // lançamento válido e o saldo do Dono ficaria errado em silêncio.
        descartados.push({ motivo: "valor_ilegivel", contexto: `${contexto} · TRNAMT="${trnamt}"` });
        continue;
      }

      candidatos.push({
        tipo: tipoDeTransacao(texto(t, "TRNTYPE") ?? ""),
        dia,
        dtpostedBruto,
        valorCents,
        fitid,
        checknum: texto(t, "CHECKNUM"),
        descricao,
      });
    }

    const porFitid = fitidServe(fitidsDaConta);
    const ordinais = new Map<string, number>();

    for (const c of candidatos) {
      if (lancamentos.length >= OFX_MAX_LANCAMENTOS) {
        if (!estourou) {
          estourou = true;
          descartados.push({
            motivo: "limite_de_lancamentos",
            contexto: `arquivo passa de ${OFX_MAX_LANCAMENTOS} lançamentos: importe um período menor`,
          });
        }
        continue;
      }

      let chaveBruta: string;
      if (porFitid) {
        chaveBruta = `fitid|${conta.bankId}|${conta.acctId}|${conta.kind}|${c.fitid}`;
      } else {
        // A chave de fallback NÃO usa a descrição. Bancos brasileiros
        // reescrevem o `MEMO` entre um extrato e o seguinte; uma chave que
        // dependesse dele geraria `external_id` novo na reimportação, sem
        // `23505`, criando lançamento duplicado que o caixa somaria — saldo
        // errado ao Dono, sem nada ficar vermelho.
        //
        // O preço é que dois lançamentos do mesmo dia e mesmo valor ficam
        // indistinguíveis: por isso o ordinal, contado POR GRUPO (dia, valor)
        // e não por índice global, para que reimportar um período sobreposto
        // reencontre o mesmo ordinal.
        const grupo = `${c.dia}|${c.valorCents}`;
        const ordinal = ordinais.get(grupo) ?? 0;
        ordinais.set(grupo, ordinal + 1);
        chaveBruta = `conteudo|${conta.bankId}|${conta.acctId}|${conta.kind}|${c.dia}|${c.valorCents}|${ordinal}`;
      }

      lancamentos.push({
        conta,
        tipo: c.tipo,
        dia: c.dia,
        dtpostedBruto: c.dtpostedBruto,
        valorCents: c.valorCents,
        moeda,
        fitid: c.fitid,
        checknum: c.checknum,
        descricao: c.descricao,
        chaveBruta,
        chaveOrigem: porFitid ? "fitid" : "conteudo",
      });
    }

    // ── Saldos ────────────────────────────────────────────────────────────
    for (const [tag, tipo] of [
      ["LEDGERBAL", "ledger"],
      ["AVAILBAL", "available"],
    ] as const) {
      for (const bal of filhos(stmt, tag)) {
        const balamt = texto(bal, "BALAMT") ?? "";
        const dtasofBruto = texto(bal, "DTASOF") ?? "";
        const valorCents = paraCentavos(balamt);
        const dia = diaDoDtposted(dtasofBruto);
        if (valorCents === null || dia === null) {
          // A conta fica SEM saldo, nunca com saldo zero: o caixa vem daqui
          // (o Dono importa uma janela), e um zero fabricado seria pior que a
          // ausência — a tela sabe dizer "saldo não lido", não sabe desmentir
          // um número.
          descartados.push({
            motivo: "saldo_ilegivel",
            contexto: `${onde} · ${tag} · BALAMT="${balamt}" · DTASOF="${dtasofBruto}"`,
          });
          continue;
        }
        saldos.push({ conta, tipo, dia, dtasofBruto, valorCents });
      }
    }
  }

  return { lancamentos, saldos, descartados };
}
