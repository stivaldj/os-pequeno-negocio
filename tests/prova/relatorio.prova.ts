/**
 * PROVA DE REALIDADE DA FASE 7 (issue #25, Spec 0003 "O Relatório das 8h"):
 * do dado espalhado em quatro módulos ao texto que chega ao WhatsApp do Dono
 * — contra Postgres de verdade, sem dublê de banco e sem WhatsApp.
 *
 * Roda por `pnpm tsx scripts/prova-relatorio.ts` (que chama o vitest com
 * `vitest.prova.config.ts`) contra a pilha local com o baseline aplicado.
 * `PROVA_MANTER=1` não apaga a Conta de prova no fim.
 *
 * ─── O que ela prova, e por que cada passo está aqui ────────────────────────
 *
 * 1. As 6 seções da issue aparecem: atendimentos e Passagens, agenda do dia,
 *    ads com Sobra por Real, propostas pendentes, caixa e vencimentos —
 *    lidas de `agent_cases`/`fn_atrito_metrics`, `calendar_appointments`,
 *    `ad_spend`+`contacts`+`ad_proposals`, e `ledger_balances`+
 *    `financial_obligations`. `lib/relatorio/` não recalcula nenhuma delas.
 * 2. **Uma seção fica incompleta de propósito**: o gasto de ONTEM não é
 *    seguido de nenhuma linha em `ad_spend` — a asserção nomeada da issue.
 *    `sobra.ts` marca a campanha (e o total) `incompleto: true`, e o texto
 *    diz isso em palavras, nunca zero.
 * 3. **A segunda rodada do dia NÃO reenvia** — `daily_reports.unique
 *    (organization_id, report_date)` segura, e a caixa de saída do canal fake
 *    continua com 1 mensagem só.
 *
 * Nada aqui edita `lib/**` nem `app/**`: a prova só chama o que a fase
 * construiu.
 */
import { createClient } from "@supabase/supabase-js";
import { describe, it } from "vitest";

import { anunciarDestino, credenciaisSupabaseDeTeste, type CredenciaisSupabase } from "../../scripts/lib/env-de-teste";
import { afirmar, passo } from "../../scripts/lib/prova";

const PRE_REQUISITO =
  "prova-relatorio: a pilha local não está no lugar. Suba o Supabase de desenvolvimento " +
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
anunciarDestino("prova-relatorio", credenciais);
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
const SLUG_ORG = "relatorio-prova";
const WHATSAPP_DO_DONO = "+5565999990404";
const FUSO = "America/Sao_Paulo";

const CAMPANHA_ID = "campanha-prova-111";
const TITULO_DA_PROPOSTA = "Suba o orçamento da Busca (prova)";
const DESCRICAO_ALUGUEL = "Aluguel da sala (prova relatório)";
const TITULO_DO_AGENDAMENTO = "Consulta de retorno (prova)";

describe("prova-relatorio — quatro módulos viram um texto só, e uma seção fica incompleta de propósito", () => {
  it("monta, manda uma vez, e a segunda rodada do dia não reenvia", async () => {
    // Módulos do produto só depois do ambiente estar no lugar: `lib/env` valida ao importar.
    const { enviarRelatorioParaTodasAsContas } = await import("@/lib/relatorio/enviar");
    const { janelaDoRelatorio } = await import("@/lib/relatorio/janela");
    const { garantirSessaoFake } = await import("@/lib/channels/fake/sessao");
    const { lerEnviados, limparCaixaFake } = await import("@/lib/channels/fake/caixa");
    const { formatCentsBRL } = await import("@/lib/money");

    const admin = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
    let orgId = "";

    try {
      // ── 0. A pilha responde e tem as tabelas que a Fase 7 lê e escreve ───
      await passo("a pilha local tem as tabelas que a Fase 7 lê e escreve", async () => {
        for (const tabela of ["daily_reports", "ad_proposals", "ad_spend", "ledger_balances", "financial_obligations"]) {
          const { error } = await admin.from(tabela).select("id").limit(1);
          afirmar(!error, `${PRE_REQUISITO}\n(tabela \`${tabela}\` inacessível: ${error?.message ?? "sem detalhe"})`);
        }
      });

      // ── 1. Conta com WhatsApp do Dono, fuso e canal fake ─────────────────
      orgId = await passo(`Conta de prova (fuso ${FUSO}) com settings.dono.whatsapp = ${WHATSAPP_DO_DONO}`, async () => {
        const { data: existente } = await admin.from("organizations").select("id").eq("slug", SLUG_ORG).maybeSingle();
        if (existente) await admin.from("organizations").delete().eq("id", (existente as { id: string }).id);
        const { data, error } = await admin
          .from("organizations")
          .insert({
            slug: SLUG_ORG,
            legal_name: "Relatório Prova",
            display_name: "Relatório Prova",
            timezone: FUSO,
            settings: { dono: { whatsapp: WHATSAPP_DO_DONO } },
          } as never)
          .select("id")
          .single();
        afirmar(!error && data, `criar a Conta de prova falhou: ${error?.message ?? "sem id"}`);
        return (data as { id: string }).id;
      });

      await passo("sessão de canal fake em WORKING (é por onde o relatório sai)", async () => {
        const sessao = await garantirSessaoFake(admin as never, orgId);
        afirmar(sessao.sessionId, "garantirSessaoFake não devolveu sessão");
      });

      // A mesma janela que o cron vai calcular — zero drift entre o que a
      // prova semeia e o que `lib/relatorio/` vai ler.
      const janela = await janelaDoRelatorio(admin as never, orgId, new Date());
      console.log(`→ janela da prova: hoje=${janela.hoje} ontem=${janela.ontem}`);

      // ── 2. AGENDA: um compromisso de hoje, pago ──────────────────────────
      await passo(`agendamento de hoje (${janela.hoje}), pago`, async () => {
        const { error } = await admin.from("calendar_appointments").insert({
          organization_id: orgId,
          title: TITULO_DO_AGENDAMENTO,
          starts_at: `${janela.hoje}T14:00:00Z`,
          ends_at: `${janela.hoje}T14:30:00Z`,
          status: "confirmed",
          paid_cents: 15_000,
        } as never);
        afirmar(!error, `inserir calendar_appointments (hoje) falhou: ${error?.message}`);
      });

      // ── 3. ADS: contato atribuído, venda de ONTEM, e o gasto AUSENTE ─────
      // de propósito — é o que faz `sobra.ts` marcar a campanha (e o total)
      // como `incompleto: true`, a asserção nomeada da issue #25.
      const contatoId = await passo("contato atribuído ao Google Ads", async () => {
        const { data, error } = await admin
          .from("contacts")
          .insert({
            organization_id: orgId,
            name: "Paciente da prova",
            source: "google_ads",
            source_metadata: { ad_source_id: CAMPANHA_ID },
          } as never)
          .select("id")
          .single();
        afirmar(!error && data, `inserir contacts falhou: ${error?.message ?? "sem id"}`);
        return (data as { id: string }).id;
      });

      await passo(`venda de ontem (${janela.ontem}) atribuída à campanha — SEM ad_spend correspondente`, async () => {
        const { error } = await admin.from("calendar_appointments").insert({
          organization_id: orgId,
          title: "Consulta atribuída (prova)",
          starts_at: `${janela.ontem}T13:00:00Z`,
          ends_at: `${janela.ontem}T13:30:00Z`,
          status: "completed",
          contact_id: contatoId,
          paid_cents: 20_000,
        } as never);
        afirmar(!error, `inserir calendar_appointments (venda de ontem) falhou: ${error?.message}`);
      });

      await passo("proposta pendente do Agente de Anúncios", async () => {
        const { error } = await admin.from("ad_proposals").insert({
          organization_id: orgId,
          campaign_id: CAMPANHA_ID,
          kind: "orcamento",
          level: 1,
          title: TITULO_DA_PROPOSTA,
          body: "Sobra por Real alta nos últimos 7 dias; sugiro subir o orçamento diário.",
        } as never);
        afirmar(!error, `inserir ad_proposals falhou: ${error?.message}`);
      });

      // ── 4. FINANCEIRO: saldo do banco e uma conta vencendo hoje ──────────
      await passo(`saldo do banco (LEDGERBAL) e uma obrigação vencendo hoje (${janela.hoje})`, async () => {
        const { error: erroSaldo } = await admin.from("ledger_balances").insert({
          organization_id: orgId,
          bank_id: "0403",
          account_id: "prova-relatorio",
          account_kind: "bank",
          kind: "ledger",
          as_of: janela.ontem,
          balance_cents: 500_000,
        } as never);
        afirmar(!erroSaldo, `inserir ledger_balances falhou: ${erroSaldo?.message}`);
        const { error: erroObrigacao } = await admin.from("financial_obligations").insert({
          organization_id: orgId,
          direction: "payable",
          description: DESCRICAO_ALUGUEL,
          amount_cents: 350_000,
          due_on: janela.hoje,
        } as never);
        afirmar(!erroObrigacao, `inserir financial_obligations falhou: ${erroObrigacao?.message}`);
      });

      // ── 5. A rodada: monta, manda, grava ──────────────────────────────────
      limparCaixaFake();
      const primeira = await passo("enviarRelatorioParaTodasAsContas — 1ª rodada", async () =>
        enviarRelatorioParaTodasAsContas(admin as never, new Date()),
      );
      const resultado = primeira.resultados.find((r) => r.organizationId === orgId);
      afirmar(
        resultado?.status === "enviado",
        `a Conta de prova não foi enviada: ${JSON.stringify(resultado)} (contas=${primeira.contas})`,
      );

      const enviados = lerEnviados(orgId);
      const textos = enviados.filter((e) => e.kind === "message").map((e) => e.envelope?.body ?? "");
      console.log(`\n─── o que chegou ao WhatsApp do Dono (caixa de saída do fake_channel) ───\n${textos.join("\n---\n")}\n`);
      afirmar(textos.length === 1, `esperava 1 mensagem na caixa de saída, vieram ${textos.length}`);
      const texto = textos[0]!;

      // ── 6. As 6 seções da issue, cada uma com o dado que semeamos ────────
      await passo("as 6 seções aparecem no texto — atendimentos, agenda, ads, sobra, propostas, caixa, vencimentos", async () => {
        for (const esperado of [
          "Atendimentos:",
          TITULO_DO_AGENDAMENTO,
          formatCentsBRL(15_000),
          CAMPANHA_ID,
          "dado incompleto", // a campanha SEM ad_spend de ontem
          TITULO_DA_PROPOSTA,
          "Caixa:",
          formatCentsBRL(500_000),
          DESCRICAO_ALUGUEL,
        ]) {
          afirmar(texto.includes(esperado), `o relatório não cita "${esperado}". Texto recebido:\n${texto}`);
        }
      });

      // ── 7. daily_reports gravado com a seção incompleta marcada ──────────
      await passo("daily_reports tem 1 linha, com incomplete_sections contendo 'ads'", async () => {
        const { data, error } = await admin
          .from("daily_reports")
          .select("report_date, status, incomplete_sections")
          .eq("organization_id", orgId);
        afirmar(!error, `ler daily_reports falhou: ${error?.message}`);
        const linhas = (data ?? []) as { report_date: string; status: string; incomplete_sections: string[] }[];
        afirmar(linhas.length === 1, `esperava 1 linha em daily_reports, achei ${linhas.length}`);
        const linha = linhas[0]!;
        afirmar(linha.report_date === janela.hoje, `report_date deveria ser ${janela.hoje}, veio ${linha.report_date}`);
        afirmar(linha.status === "enviado", `status deveria ser enviado, veio ${linha.status}`);
        afirmar(linha.incomplete_sections.includes("ads"), `incomplete_sections deveria conter "ads", veio ${JSON.stringify(linha.incomplete_sections)}`);
      });

      // ── 8. A segunda rodada do dia NÃO reenvia ───────────────────────────
      const segunda = await passo("enviarRelatorioParaTodasAsContas — 2ª rodada no mesmo dia", async () =>
        enviarRelatorioParaTodasAsContas(admin as never, new Date()),
      );
      const resultadoSegunda = segunda.resultados.find((r) => r.organizationId === orgId);
      afirmar(
        resultadoSegunda?.status === "ja_enviado_hoje",
        `2ª rodada: esperava status=ja_enviado_hoje, veio ${JSON.stringify(resultadoSegunda)}`,
      );
      const depois = lerEnviados(orgId).filter((e) => e.kind === "message").length;
      afirmar(depois === 1, `2ª rodada: a caixa de saída foi de 1 para ${depois} mensagens — o Dono foi avisado duas vezes do mesmo dia`);

      await passo("daily_reports continua com 1 linha só", async () => {
        const { count, error } = await admin
          .from("daily_reports")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId);
        afirmar(!error, `contar daily_reports falhou: ${error?.message}`);
        afirmar(count === 1, `esperava 1 linha em daily_reports depois da 2ª rodada, achei ${count}`);
      });
    } finally {
      if (orgId && !MANTER) {
        // `organizations` cascateia: agendamentos, contato, propostas, saldo,
        // obrigação, relatório, sessão e conversa do Dono vão junto.
        const { error } = await admin.from("organizations").delete().eq("id", orgId);
        if (error) console.warn(`⚠️  a Conta de prova (slug ${SLUG_ORG}, id ${orgId}) NÃO foi apagada: ${error.message}`);
        else console.log(`→ limpeza da Conta de prova (slug ${SLUG_ORG}) … ok`);
      } else if (orgId) {
        console.log(`○ Conta de prova mantida (PROVA_MANTER=1): slug ${SLUG_ORG}, id ${orgId}`);
      }
    }

    console.log("\nprova-relatorio: VERDE");
  });
});
