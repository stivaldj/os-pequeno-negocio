/**
 * A rodada diária do Agente de Anúncios (ADR-0018, nível 1): lê o contexto,
 * pensa com o modelo pelo seam único do harness (`runModelCall`, ponto de IA
 * `ads_agent`), grava propostas por ferramenta, e avisa o Dono pelo WhatsApp,
 * a Central de avisos e o audit. Bounded: `maxSteps: 6`, uma Conta por vez.
 */
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LlmBudgetExceededError, runModelCall, type LlmEdgeConfig } from "@/lib/agent-engine/edge/llm/run-model-call";
import { audit } from "@/lib/audit";
import { enviarAoDono } from "@/lib/dono/destinatario";
import { logger } from "@/lib/logger";
import { contextoEmTexto, montarContexto } from "./contexto";
import { ferramentasDoAgente, type ContaDeAnuncios, type EstadoDaRodada } from "./ferramentas";
import { nivelValido } from "./niveis";

export const PROMPT_DO_AGENTE_DE_ANUNCIOS = [
  "Você é o Agente de Anúncios de uma clínica pequena. Analisa o Google Ads dela e PROPÕE ao Dono.",
  "O que importa é Sobra por Real: quanto sobra para o Dono a cada real de anúncio, já descontada a margem do serviço. Não é ROAS.",
  "Você pode: ler as campanhas, ler a Sobra por Real e registrar propostas com `propor`.",
  "Você NÃO pode, neste nível: mudar orçamento, pausar, criar ou editar anúncios (as ferramentas recusam). Nunca sugira público feito de pacientes: saúde é categoria sensível no Google.",
  "Nunca prometa resultado. Trate dia INCOMPLETO como dado faltante, não como zero, e diga quando a base é curta.",
  "Não repita propostas pendentes. Se não houver o que propor, registre UMA proposta do tipo `observacao` dizendo isso em uma frase.",
  "Cada proposta: título curto, corpo com o número que justifica (gasto, conversas, consultas pagas, Sobra por Real) e o que muda se aceita.",
  "No máximo 5 propostas por rodada. Ao terminar, responda com um resumo de até 3 linhas para o Dono, em português, sem jargão.",
].join("\n");

export interface ResultadoDaRodada {
  organizationId: string;
  status: "ok" | "pulado" | "falhou";
  motivo?: string;
  propostas: number;
  recusas: number;
  resumo?: string;
}

export async function rodarAgenteDeAnuncios(
  admin: SupabaseClient,
  pool: pg.Pool,
  cfg: LlmEdgeConfig,
  conta: ContaDeAnuncios,
  opts: { agora: Date; requestId: string },
): Promise<ResultadoDaRodada> {
  const orgId = conta.organization_id;
  const ctx = await montarContexto(admin, orgId, { agora: opts.agora });
  const estado: EstadoDaRodada = { propostas: [], recusas: [] };
  const tools = ferramentasDoAgente(admin, conta, ctx, estado, opts.requestId);

  let resumo = "";
  try {
    const call = await runModelCall(pool, cfg, {
      tenantId: orgId,
      purpose: 'ads_agent',
      system: PROMPT_DO_AGENTE_DE_ANUNCIOS,
      messages: [{ role: "user", content: `Contexto de hoje:\n${contextoEmTexto(ctx)}\n\nAnalise e registre suas propostas com \`propor\`. Depois, o resumo para o Dono.` }],
      tools,
      maxSteps: 6,
    });
    resumo = (call.result.text ?? "").trim();
  } catch (err) {
    if (err instanceof LlmBudgetExceededError) {
      void audit({ action: "ads.agent_pulado", organizationId: orgId, resourceType: "ad_account", resourceId: conta.id, requestId: opts.requestId, bypassedRls: true, metadata: { motivo: "orcamento_de_ia" } });
      return { organizationId: orgId, status: "pulado", motivo: "orcamento_de_ia", propostas: 0, recusas: 0 };
    }
    logger.error("[ads.agente] rodada falhou", { organization_id: orgId, detail: err instanceof Error ? err.message.slice(0, 200) : "erro" });
    return { organizationId: orgId, status: "falhou", motivo: err instanceof Error ? err.message.slice(0, 120) : "erro", propostas: estado.propostas.length, recusas: estado.recusas.length };
  }

  const nivel = nivelValido(conta.autonomy_level);
  const linhas = estado.propostas.slice(0, 5).map((p) => `• ${p.title}`);
  const texto = [
    `Anúncios — ${estado.propostas.length} proposta(s) hoje${estado.propostas.length ? ":" : "."}`,
    ...linhas,
    resumo ? resumo : "",
    estado.propostas.length ? "Responda na tela Anúncios para aprovar ou recusar." : "",
  ]
    .filter(Boolean)
    .join("\n");

  const envio = await enviarAoDono(admin, orgId, texto);
  if (!envio.ok) logger.info("[ads.agente] resumo não foi ao Dono", { organization_id: orgId, motivo: envio.motivo });

  if (estado.propostas.length > 0) {
    await admin.from("agent_inbox_items").insert({
      organization_id: orgId,
      kind: "other",
      severity: "info",
      title: `Agente de Anúncios: ${estado.propostas.length} proposta(s) para decidir`,
      body: linhas.join("\n"),
      ref_kind: "ad_account",
      ref_id: conta.id,
    });
  }
  void audit({
    action: "ads.agent_rodou",
    organizationId: orgId,
    resourceType: "ad_account",
    resourceId: conta.id,
    requestId: opts.requestId,
    bypassedRls: true,
    metadata: { propostas: estado.propostas.length, recusas: estado.recusas.length, autonomy_level: nivel, dono_avisado: envio.ok },
  });
  return { organizationId: orgId, status: "ok", propostas: estado.propostas.length, recusas: estado.recusas.length, resumo };
}

export async function rodarParaTodasAsContas(
  admin: SupabaseClient,
  pool: pg.Pool,
  cfg: LlmEdgeConfig,
  opts: { agora: Date; requestId: string },
): Promise<ResultadoDaRodada[]> {
  const { data, error } = await admin
    .from("ad_accounts")
    .select("id, organization_id, customer_id, autonomy_level, budget_floor_cents, budget_ceiling_cents, max_cost_per_conversation_cents")
    .eq("status", "active");
  if (error) throw new Error(`ad_accounts: ${error.message}`);
  const saida: ResultadoDaRodada[] = [];
  for (const conta of (data ?? []) as ContaDeAnuncios[]) {
    saida.push(await rodarAgenteDeAnuncios(admin, pool, cfg, conta, opts));
  }
  return saida;
}
