/**
 * PROVA DE REALIDADE DA FASE 6 (issue #24, Spec 0003 "O dinheiro"): do arquivo
 * OFX que o banco exporta ao aviso que chega ao Dono — contra Postgres de
 * verdade, sem dublê de banco e sem WhatsApp.
 *
 * Roda por `pnpm tsx scripts/prova-financeiro.ts` (que chama o vitest com
 * `vitest.prova.config.ts`) contra a pilha local com o baseline aplicado.
 * `PROVA_MANTER=1` não apaga a Conta de prova no fim.
 *
 * ─── O que ela prova, e por que cada passo está aqui ────────────────────────
 *
 * 1. O extrato entra: `importarExtratoHandler` (o handler EXTRAÍDO da rota —
 *    `requireRole` chama `cookies()` de `next/headers`, que não existe em
 *    vitest) transforma o `.ofx` em linhas de `ledger_entries` e saldos em
 *    `ledger_balances`.
 * 2. **Importar o MESMO arquivo de novo não muda nada** — `importados: 0`. É a
 *    asserção que a issue #24 nomeia, e aqui ela passa pelo índice
 *    `unique (organization_id, external_id)` do Postgres real, não por um mock
 *    que responde o que a gente mandou responder.
 * 3. O caixa é o saldo do BANCO, não a soma da janela importada: o arquivo
 *    move R$ 316,24 e o `LEDGERBAL` declara R$ 1.316,24. Se a prova visse
 *    316,24, o Dono estaria olhando para movimento e chamando de caixa.
 * 4. O Dono é avisado do que vence hoje e do que já venceu, pela caixa de
 *    saída do `fake_channel`.
 * 5. **A segunda rodada do lembrete não reenvia** — `reminder_sent_on = hoje`
 *    segura. Sem isso o cron das 07:20 viraria spam a cada retentativa.
 *
 * Nada aqui edita `lib/**` nem `app/**`: a prova só chama o que a fase
 * construiu.
 */
import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { describe, it } from "vitest";

import { anunciarDestino, credenciaisSupabaseDeTeste, type CredenciaisSupabase } from "../../scripts/lib/env-de-teste";
import { afirmar, passo } from "../../scripts/lib/prova";

const PRE_REQUISITO =
  "prova-financeiro: a pilha local não está no lugar. Suba o Supabase de desenvolvimento " +
  "(`supabase start`), aplique `supabase/baseline.sql` e exporte as variáveis de " +
  "`supabase status -o env`: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, " +
  "NEXT_PUBLIC_SUPABASE_ANON_KEY e SUPABASE_DB_URL.";

function credenciaisOuPreRequisito(): CredenciaisSupabase {
  let c: CredenciaisSupabase;
  try {
    c = credenciaisSupabaseDeTeste();
  } catch (err) {
    throw new Error(`${PRE_REQUISITO}\n(origem: ${(err as Error).message})`);
  }
  if (!c.url || !c.serviceRole) throw new Error(PRE_REQUISITO);
  return c;
}

const credenciais = credenciaisOuPreRequisito();
anunciarDestino("prova-financeiro", credenciais);
for (const [k, v] of Object.entries({
  NEXT_PUBLIC_SUPABASE_URL: credenciais.url,
  SUPABASE_SERVICE_ROLE_KEY: credenciais.serviceRole,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: credenciais.anonKey,
  NEXT_PUBLIC_APP_URL: credenciais.appUrl,
  SUPABASE_DB_URL: credenciais.dbUrl,
})) {
  if (typeof v === "string" && v !== "") process.env[k] ??= v;
}

const MANTER = process.env.PROVA_MANTER === "1";
const SLUG_ORG = "financeiro-prova";
const WHATSAPP_DO_DONO = "+5565999990303";
const FIXTURE = new URL("../fixtures/ofx/bradesco-like.ofx", import.meta.url);
const NOME_DO_ARQUIVO = "bradesco-like.ofx";

/** O que o `bradesco-like.ofx` declara — a prova compara contra estes números. */
const DO_EXTRATO = {
  lancamentos: 2,
  /** `<LEDGERBAL><BALAMT>1316,24` com `<DTASOF>20260831`. */
  saldoCents: 131_624,
  saldoEm: "2026-08-31",
  /** -530,86 + 847,10 — o MOVIMENTO da janela, que não é o caixa. */
  somaDaJanelaCents: 31_624,
  bankId: "237",
  acctId: "00012345-6",
};

const ALUGUEL = "Aluguel da sala (prova)";
const CONVENIO = "Repasse do convenio (prova)";
const ENERGIA = "Energia da clinica (prova)";

interface RespostaDaImportacao {
  data?: {
    total_lancamentos: number;
    importados: number;
    duplicados: number;
    por_conteudo: number;
    saldos_gravados: number;
    contas: { bank_id: string; account_id: string; account_kind: string; lancamentos: number }[];
  };
  error?: { code?: string; message?: string };
}

async function lerResumo(res: Response, quando: string): Promise<NonNullable<RespostaDaImportacao["data"]>> {
  const corpo = (await res.json()) as RespostaDaImportacao;
  afirmar(
    res.status === 200 && corpo.data,
    `${quando}: esperava 200 com resumo, veio ${res.status} ${JSON.stringify(corpo.error ?? corpo)}`,
  );
  return corpo.data;
}

describe("prova-financeiro — o extrato vira caixa e o Dono é avisado", () => {
  it("importa, reimporta sem duplicar, calcula o caixa e manda um lembrete só", async () => {
    // Módulos do produto só depois do ambiente estar no lugar: `lib/env` valida ao importar.
    const { importarExtratoHandler } = await import("@/app/api/v1/financeiro/extratos/_handler");
    const { calcularCaixa } = await import("@/lib/financeiro/caixa");
    const { enviarLembretesDeVencimento, diaCorrenteUtc } = await import("@/lib/financeiro/lembretes");
    const { garantirSessaoFake } = await import("@/lib/channels/fake/sessao");
    const { lerEnviados, limparCaixaFake } = await import("@/lib/channels/fake/caixa");
    const { formatCentsBRL } = await import("@/lib/money");

    const admin = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
    const hoje = diaCorrenteUtc();
    let orgId = "";

    try {
      // ── 0. A pilha responde e tem as tabelas da Fase 6 ───────────────────
      await passo("a pilha local responde e tem as tabelas da Fase 6", async () => {
        for (const tabela of ["ledger_entries", "ledger_balances", "ledger_categories", "financial_obligations"]) {
          const { error } = await admin.from(tabela).select("id").limit(1);
          afirmar(
            !error,
            `${PRE_REQUISITO}\n(tabela \`${tabela}\` inacessível: ${error?.message ?? "sem detalhe"})`,
          );
        }
      });

      // ── 1. Conta com WhatsApp do Dono e canal fake ───────────────────────
      orgId = await passo(`Conta de prova com settings.dono.whatsapp = ${WHATSAPP_DO_DONO}`, async () => {
        const { data: existente } = await admin.from("organizations").select("id").eq("slug", SLUG_ORG).maybeSingle();
        if (existente) await admin.from("organizations").delete().eq("id", (existente as { id: string }).id);
        const { data, error } = await admin
          .from("organizations")
          .insert({
            slug: SLUG_ORG,
            legal_name: "Financeiro Prova",
            display_name: "Financeiro Prova",
            timezone: "America/Cuiaba",
            settings: { dono: { whatsapp: WHATSAPP_DO_DONO } },
          } as never)
          .select("id")
          .single();
        afirmar(!error && data, `criar a Conta de prova falhou: ${error?.message ?? "sem id"}`);
        return (data as { id: string }).id;
      });

      await passo("sessão de canal fake em WORKING (é por onde o aviso sai)", async () => {
        const sessao = await garantirSessaoFake(admin as never, orgId);
        afirmar(sessao.sessionId, "garantirSessaoFake não devolveu sessão");
      });

      // ── 2. O extrato entra ───────────────────────────────────────────────
      const bytes = readFileSync(FIXTURE);
      const arquivo = (): File => new File([bytes], NOME_DO_ARQUIVO, { type: "application/x-ofx" });

      const primeira = await passo(`importar ${NOME_DO_ARQUIVO} (${bytes.length} bytes)`, async () =>
        lerResumo(await importarExtratoHandler(admin, { organizationId: orgId, requestId: "prova-fin-1" }, arquivo()), "1ª importação"),
      );
      afirmar(
        primeira.importados === DO_EXTRATO.lancamentos,
        `1ª importação: esperava importados=${DO_EXTRATO.lancamentos}, veio ${primeira.importados} ` +
          `(total_lancamentos=${primeira.total_lancamentos}, duplicados=${primeira.duplicados})`,
      );
      afirmar(
        primeira.saldos_gravados > 0,
        `1ª importação: esperava saldos_gravados > 0 (o LEDGERBAL do banco), veio ${primeira.saldos_gravados}`,
      );

      await passo("as linhas estão no banco, com a conta do arquivo", async () => {
        const { data, error } = await admin
          .from("ledger_entries")
          .select("bank_id, account_id, account_kind, posted_on, amount_cents, key_source")
          .eq("organization_id", orgId);
        afirmar(!error, `ler ledger_entries falhou: ${error?.message}`);
        const linhas = (data ?? []) as { bank_id: string; account_id: string; amount_cents: number }[];
        afirmar(
          linhas.length === DO_EXTRATO.lancamentos,
          `esperava ${DO_EXTRATO.lancamentos} linhas em ledger_entries, achei ${linhas.length}`,
        );
        const soma = linhas.reduce((acc, l) => acc + Number(l.amount_cents), 0);
        afirmar(
          soma === DO_EXTRATO.somaDaJanelaCents,
          `a soma dos lançamentos deveria ser ${DO_EXTRATO.somaDaJanelaCents} cents, veio ${soma}`,
        );
        afirmar(
          linhas.every((l) => l.bank_id === DO_EXTRATO.bankId && l.account_id === DO_EXTRATO.acctId),
          `banco/conta diferentes do arquivo: ${JSON.stringify(linhas.map((l) => `${l.bank_id}/${l.account_id}`))}`,
        );
      });

      // ── 3. A asserção da issue: o mesmo arquivo de novo não muda nada ─────
      const segunda = await passo("importar O MESMO arquivo de novo", async () =>
        lerResumo(await importarExtratoHandler(admin, { organizationId: orgId, requestId: "prova-fin-2" }, arquivo()), "2ª importação"),
      );
      afirmar(
        segunda.importados === 0,
        `REIMPORTAÇÃO: esperava importados=0, veio ${segunda.importados} — o extrato duplicou no livro-caixa`,
      );
      afirmar(
        segunda.duplicados === DO_EXTRATO.lancamentos,
        `REIMPORTAÇÃO: esperava duplicados=${DO_EXTRATO.lancamentos}, veio ${segunda.duplicados}`,
      );
      await passo("o banco continua com o mesmo número de linhas", async () => {
        const { count, error } = await admin
          .from("ledger_entries")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId);
        afirmar(!error, `contar ledger_entries falhou: ${error?.message}`);
        afirmar(
          count === DO_EXTRATO.lancamentos,
          `depois de reimportar esperava ${DO_EXTRATO.lancamentos} linhas, achei ${count}`,
        );
      });

      // ── 4. O caixa vem do saldo do banco, não da soma da janela ──────────
      const caixa = await passo("calcularCaixa a partir do que está no Postgres", async () => {
        const { data: saldos, error: erroSaldos } = await admin
          .from("ledger_balances")
          .select("bank_id, account_id, account_kind, kind, as_of, balance_cents")
          .eq("organization_id", orgId);
        afirmar(!erroSaldos, `ler ledger_balances falhou: ${erroSaldos?.message}`);
        const { data: lancamentos, error: erroLanc } = await admin
          .from("ledger_entries")
          .select("bank_id, account_id, account_kind, posted_on, amount_cents")
          .eq("organization_id", orgId);
        afirmar(!erroLanc, `ler ledger_entries falhou: ${erroLanc?.message}`);

        type LinhaSaldo = { bank_id: string; account_id: string; account_kind: string; kind: string; as_of: string; balance_cents: number };
        type LinhaLanc = { bank_id: string; account_id: string; account_kind: string; posted_on: string; amount_cents: number };
        return calcularCaixa({
          saldos: ((saldos ?? []) as LinhaSaldo[]).map((s) => ({
            bankId: s.bank_id,
            acctId: s.account_id,
            kind: s.account_kind as "bank" | "credit_card",
            tipo: s.kind as "ledger" | "available",
            saldoEm: s.as_of,
            saldoCents: Number(s.balance_cents),
          })),
          lancamentos: ((lancamentos ?? []) as LinhaLanc[]).map((l) => ({
            bankId: l.bank_id,
            acctId: l.account_id,
            kind: l.account_kind as "bank" | "credit_card",
            dia: l.posted_on,
            valorCents: Number(l.amount_cents),
          })),
        });
      });

      console.table(
        caixa.contas.map((c) => ({
          banco: c.bankId,
          conta: c.acctId,
          tipo: c.kind,
          "saldo do banco": c.saldoCents === null ? "(nunca importado)" : formatCentsBRL(c.saldoCents),
          "saldo em": c.saldoEm ?? "—",
          "lançamentos depois": c.lancamentosDepois,
          incompleto: c.incompleto,
        })),
      );

      afirmar(caixa.contas.length === 1, `esperava 1 conta no caixa, veio ${caixa.contas.length}`);
      const conta = caixa.contas[0]!;
      afirmar(
        conta.saldoCents === DO_EXTRATO.saldoCents,
        `o caixa deveria ser o LEDGERBAL ${formatCentsBRL(DO_EXTRATO.saldoCents)}, veio ` +
          `${conta.saldoCents === null ? "null" : formatCentsBRL(conta.saldoCents)}`,
      );
      afirmar(
        conta.saldoEm === DO_EXTRATO.saldoEm,
        `a data do saldo deveria ser ${DO_EXTRATO.saldoEm} (o DTASOF do banco), veio ${conta.saldoEm}`,
      );
      afirmar(
        conta.lancamentosDepois === 0 && conta.saldoEstimadoCents === DO_EXTRATO.saldoCents,
        `lançamento do dia do DTASOF ou anterior não pode somar de novo: lancamentosDepois=` +
          `${conta.lancamentosDepois}, saldoEstimadoCents=${conta.saldoEstimadoCents}`,
      );
      afirmar(
        caixa.totalCents === DO_EXTRATO.saldoCents && !caixa.incompleto,
        `total do caixa deveria ser ${DO_EXTRATO.saldoCents} e completo, veio ${caixa.totalCents} ` +
          `(incompleto=${caixa.incompleto})`,
      );
      afirmar(
        caixa.totalCents !== DO_EXTRATO.somaDaJanelaCents,
        `o caixa veio igual à SOMA DA JANELA (${formatCentsBRL(DO_EXTRATO.somaDaJanelaCents)}) — ` +
          "isso é movimento, não saldo",
      );

      // ── 5. Duas contas vencendo hoje e uma já vencida ────────────────────
      await passo(`cadastrar obrigações (2 vencendo em ${hoje}, 1 vencida)`, async () => {
        const { error } = await admin.from("financial_obligations").insert([
          { organization_id: orgId, direction: "payable", description: ALUGUEL, amount_cents: 350_000, due_on: hoje },
          { organization_id: orgId, direction: "receivable", description: CONVENIO, amount_cents: 128_050, due_on: hoje },
          {
            organization_id: orgId,
            direction: "payable",
            description: ENERGIA,
            amount_cents: 47_390,
            due_on: new Date(Date.parse(`${hoje}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10),
          },
        ] as never);
        afirmar(!error, `inserir financial_obligations falhou: ${error?.message}`);
      });

      // ── 6. O Dono ouve o que vence hoje ──────────────────────────────────
      limparCaixaFake();
      const primeiraRodada = await passo("enviarLembretesDeVencimento — 1ª rodada", async () =>
        enviarLembretesDeVencimento(admin as never, { hoje }),
      );
      const candidato = primeiraRodada.candidatos.find((c) => c.organizationId === orgId);
      afirmar(
        candidato,
        `a Conta de prova não entrou na rodada (contas=${primeiraRodada.contas}, ` +
          `pulados=${JSON.stringify(primeiraRodada.pulados)})`,
      );
      afirmar(
        !primeiraRodada.pulados.some((p) => p.organizationId === orgId),
        `a Conta de prova foi pulada: ${JSON.stringify(primeiraRodada.pulados.filter((p) => p.organizationId === orgId))}`,
      );

      const enviados = lerEnviados(orgId);
      const textos = enviados
        .filter((e) => e.kind === "message")
        .map((e) => e.envelope?.body ?? "");
      console.log(`\n─── o que chegou ao WhatsApp do Dono (caixa de saída do fake_channel) ───\n${textos.join("\n---\n")}\n`);
      afirmar(
        textos.length === 1,
        `esperava 1 mensagem na caixa de saída da Conta, vieram ${textos.length} — o Dono não pode receber uma por boleto`,
      );
      const texto = textos[0]!;
      for (const esperado of [
        "2 contas vencem hoje",
        "1 conta já venceu",
        ALUGUEL,
        CONVENIO,
        ENERGIA,
        formatCentsBRL(350_000),
        formatCentsBRL(128_050),
        formatCentsBRL(47_390),
      ]) {
        afirmar(texto.includes(esperado), `o aviso ao Dono não cita "${esperado}". Texto recebido:\n${texto}`);
      }

      await passo(`reminder_sent_on marcado em ${hoje}`, async () => {
        const { data, error } = await admin
          .from("financial_obligations")
          .select("description, reminder_sent_on")
          .eq("organization_id", orgId);
        afirmar(!error, `ler financial_obligations falhou: ${error?.message}`);
        const linhas = (data ?? []) as { description: string; reminder_sent_on: string | null }[];
        console.table(linhas.map((l) => ({ obrigação: l.description, reminder_sent_on: l.reminder_sent_on ?? "(null)" })));
        const semMarca = linhas.filter((l) => l.reminder_sent_on !== hoje);
        afirmar(
          semMarca.length === 0,
          `esperava reminder_sent_on=${hoje} em todas as 3, ficaram sem: ` +
            JSON.stringify(semMarca.map((l) => `${l.description}=${l.reminder_sent_on}`)),
        );
      });

      // ── 7. A segunda rodada NÃO reenvia ──────────────────────────────────
      const segundaRodada = await passo("enviarLembretesDeVencimento — 2ª rodada no mesmo dia", async () =>
        enviarLembretesDeVencimento(admin as never, { hoje }),
      );
      afirmar(
        !segundaRodada.candidatos.some((c) => c.organizationId === orgId),
        `2ª rodada: a Conta de prova voltou a ser candidata — a marca do dia não segurou. ` +
          `Candidato: ${JSON.stringify(segundaRodada.candidatos.find((c) => c.organizationId === orgId))}`,
      );
      const depois = lerEnviados(orgId).filter((e) => e.kind === "message").length;
      afirmar(
        depois === 1,
        `2ª rodada: a caixa de saída foi de 1 para ${depois} mensagens — o Dono foi avisado duas vezes do mesmo`,
      );
    } finally {
      if (orgId && !MANTER) {
        // `organizations` cascateia: lançamentos, saldos, obrigações, sessão,
        // contato e conversa do Dono vão junto. Roda no `finally` para não
        // deixar lixo se uma asserção caiu no meio.
        const { error } = await admin.from("organizations").delete().eq("id", orgId);
        if (error) console.warn(`⚠️  a Conta de prova (slug ${SLUG_ORG}, id ${orgId}) NÃO foi apagada: ${error.message}`);
        else console.log(`→ limpeza da Conta de prova (slug ${SLUG_ORG}) … ok`);
      } else if (orgId) {
        console.log(`○ Conta de prova mantida (PROVA_MANTER=1): slug ${SLUG_ORG}, id ${orgId}`);
      }
    }

    console.log("\nprova-financeiro: VERDE");
  });
});
