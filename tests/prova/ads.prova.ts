/**
 * Prova de realidade da Fase 5 — roda por `scripts/prova-ads.ts`. Exige as
 * variáveis `GOOGLE_ADS_*` da instalação; com `PROVA_ADS_SO_LER=1` e
 * `AD_CUSTOMER_ID`, só lê a API. Sem `--so-ler`, precisa da pilha local com
 * uma Conta em `ad_accounts` e grava em `ad_spend`.
 */
import { createClient } from "@supabase/supabase-js";
import { describe, it } from "vitest";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { afirmar, passo } from "../../scripts/lib/prova";

describe("prova-ads — a Verba real entra", () => {
  it("lê o gasto da API do Google e, se for o caso, grava em ad_spend", async () => {
    const { googleAdsDisponivel } = await import("@/lib/ads/google/config");
    const { env } = await import("@/lib/env");
    afirmar(googleAdsDisponivel(env), "faltam as variáveis GOOGLE_ADS_* na instalação (veja .env.example)");

    if (process.env.PROVA_ADS_SO_LER === "1") {
      const cid = process.env.AD_CUSTOMER_ID ?? "";
      afirmar(cid, "AD_CUSTOMER_ID ausente");
      const { lerGastoPorCampanhaEDia } = await import("@/lib/ads/google/gasto");
      const ontem = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const r = await passo(`ler gasto de ${cid} em ${ontem}`, async () => lerGastoPorCampanhaEDia(cid, ontem, ontem));
      afirmar(r.ok, `API recusou: ${!r.ok ? `${r.code} ${r.motivo}` : ""}`);
      console.table(r.valor.map((l) => ({ campanha: l.campaignName, dia: l.date, gasto: `R$ ${(l.costMicros / 1e6).toFixed(2)}`, cliques: l.clicks })));
      return;
    }

    const credenciais = credenciaisSupabaseDeTeste();
    afirmar(credenciais.url && credenciais.serviceRole, "faltam NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
    for (const [k, v] of Object.entries({ NEXT_PUBLIC_SUPABASE_URL: credenciais.url, SUPABASE_SERVICE_ROLE_KEY: credenciais.serviceRole })) process.env[k] ??= v;
    const admin = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
    const { sincronizarGasto } = await import("@/lib/ads/sync-gasto");
    const r = await passo("sincronizar gasto das Contas ativas", async () => sincronizarGasto(admin as never, { agora: new Date() }));
    afirmar(r.contas > 0, "nenhuma Conta ativa em ad_accounts — configure na tela Anúncios");
    afirmar(r.falhas === 0, `${r.falhas} Conta(s) com erro — veja ad_accounts.last_error`);
    const { data } = await admin.from("ad_spend").select("campaign_name, date, cost_micros, clicks").order("date", { ascending: false }).limit(20);
    console.table((data ?? []).map((l) => ({ campanha: l.campaign_name, dia: l.date, gasto: `R$ ${(Number(l.cost_micros) / 1e6).toFixed(2)}`, cliques: l.clicks })));
    console.log("\nprova-ads: VERDE");
  });
});
