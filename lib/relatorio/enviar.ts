/**
 * A rodada diária: para toda Conta ATIVA com `settings.dono.whatsapp`
 * configurado, monta o relatório, manda por `enviarAoDono` e grava
 * `daily_reports`. Molde de `lib/financeiro/lembretes.ts`
 * (`enviarLembretesDeVencimento`): uma Conta que falha não derruba as outras,
 * e falha de ENVIO nunca marca — a rodada de amanhã tenta de novo.
 *
 * A idempotência é `daily_reports.unique(organization_id, report_date)`:
 * antes de montar (que já custa 4 leituras), a rodada confere se já existe
 * linha para `hoje`; se existir, pula sem tocar `enviarAoDono` de novo. Isso
 * cobre o cron rodando duas vezes no mesmo dia — retry manual, redeploy.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { whatsappDoDono } from "@/lib/dono/config";
import { enviarAoDono } from "@/lib/dono/destinatario";
import { logger } from "@/lib/logger";

import { janelaDoRelatorio } from "./janela";
import { montarRelatorio } from "./montar";

export interface ContaComRelatorio {
  organizationId: string;
  hoje: string;
  status: "enviado" | "ja_enviado_hoje" | "pulado" | "falhou";
  motivo?: string;
}

export interface ResumoDoEnvio {
  contas: number;
  enviados: number;
  jaEnviadosHoje: number;
  pulados: number;
  falhas: number;
  resultados: ContaComRelatorio[];
}

interface LinhaDeOrganizacao {
  id: string;
  settings: unknown;
}

async function organizacoesComDono(admin: SupabaseClient): Promise<LinhaDeOrganizacao[]> {
  const { data, error } = await admin.from("organizations").select("id, settings").eq("status", "active");
  if (error) throw new Error(`organizations: ${error.message}`);
  return ((data ?? []) as LinhaDeOrganizacao[]).filter((o) => whatsappDoDono(o.settings) !== null);
}

async function jaEnviadoHoje(admin: SupabaseClient, organizationId: string, hoje: string): Promise<boolean> {
  const { data, error } = await admin
    .from("daily_reports")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("report_date", hoje)
    .maybeSingle();
  if (error) throw new Error(`daily_reports: ${error.message}`);
  return data !== null;
}

async function registrarEnvio(
  admin: SupabaseClient,
  organizationId: string,
  hoje: string,
  campos: { body: string; incompleteSections: string[]; status: "enviado" | "falhou"; failureReason?: string },
): Promise<void> {
  const { error } = await admin.from("daily_reports").insert({
    organization_id: organizationId,
    report_date: hoje,
    body: campos.body,
    incomplete_sections: campos.incompleteSections,
    status: campos.status,
    failure_reason: campos.failureReason ?? null,
  });
  if (error) {
    // Corrida rara com outra chamada da mesma rodada, ou `unique` acionada por
    // uma segunda tentativa concorrente: loga e segue — o envio JÁ SAIU (ou já
    // falhou por conta própria), e não marcar de novo não reabre a janela.
    logger.warn("[relatorio] daily_reports não gravado", {
      organization_id: organizationId,
      report_date: hoje,
      error: error.message.slice(0, 200),
    });
  }
}

async function processarConta(
  admin: SupabaseClient,
  organizationId: string,
  agora: Date,
): Promise<ContaComRelatorio> {
  // `hoje` primeiro, barato (só a leitura de fuso) — decide se vale montar o
  // resto, que são 4 leituras.
  const janela = await janelaDoRelatorio(admin, organizationId, agora);
  if (await jaEnviadoHoje(admin, organizationId, janela.hoje)) {
    return { organizationId, hoje: janela.hoje, status: "ja_enviado_hoje" };
  }

  const relatorio = await montarRelatorio(admin, organizationId, agora);

  const envio = await enviarAoDono(admin, organizationId, relatorio.texto);
  if (!envio.ok) {
    // Não grava `daily_reports`: a rodada de amanhã tenta de novo, como
    // `enviarLembretesDeVencimento` já faz para o mesmo caso.
    return { organizationId, hoje: janela.hoje, status: "pulado", motivo: envio.motivo };
  }

  await registrarEnvio(admin, organizationId, janela.hoje, {
    body: relatorio.texto,
    incompleteSections: relatorio.secoesIncompletas,
    status: "enviado",
  });

  await audit({
    action: "relatorio.enviado",
    organizationId,
    resourceType: "organization",
    resourceId: organizationId,
    bypassedRls: true,
    metadata: {
      hoje: janela.hoje,
      secoes_incompletas: relatorio.secoesIncompletas,
      atendidos: relatorio.atendimentos.atendidos,
      passados_para_humano: relatorio.atendimentos.passadosParaHumano,
    },
  });

  return { organizationId, hoje: janela.hoje, status: "enviado" };
}

export async function enviarRelatorioParaTodasAsContas(admin: SupabaseClient, agora: Date): Promise<ResumoDoEnvio> {
  const contas = await organizacoesComDono(admin);
  const resultados: ContaComRelatorio[] = [];

  for (const conta of contas) {
    try {
      resultados.push(await processarConta(admin, conta.id, agora));
    } catch (err) {
      const motivo = err instanceof Error ? err.message.slice(0, 200) : "erro";
      logger.error("[relatorio] rodada falhou para a Conta", { organization_id: conta.id, error: motivo });
      resultados.push({ organizationId: conta.id, hoje: "", status: "falhou", motivo });
    }
  }

  return {
    contas: contas.length,
    enviados: resultados.filter((r) => r.status === "enviado").length,
    jaEnviadosHoje: resultados.filter((r) => r.status === "ja_enviado_hoje").length,
    pulados: resultados.filter((r) => r.status === "pulado").length,
    falhas: resultados.filter((r) => r.status === "falhou").length,
    resultados,
  };
}
