/**
 * As ferramentas do Agente de Anúncios, no formato do seam de LLM do harness.
 * Leitura livre; `propor` grava em `ad_proposals`; as de escrita no Google
 * passam por `podeEscrever` e, abaixo do nível, RECUSAM e auditam com o nível
 * em vigor (ADR-0018). Nesta fase nenhuma escrita chega ao Google: as duas
 * ferramentas de escrita só recusam ou registram "seria aplicado".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { tool, type ToolSet } from "@/lib/agent-engine/edge/llm/run-model-call";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { contextoEmTexto, type ContextoDeAnuncios } from "./contexto";
import { MOTIVO_NIVEL_INSUFICIENTE, nivelValido, podeEscrever, type AcaoDeEscrita } from "./niveis";

export interface ContaDeAnuncios {
  id: string;
  organization_id: string;
  customer_id: string;
  autonomy_level: unknown;
  budget_floor_cents: number | null;
  budget_ceiling_cents: number | null;
  max_cost_per_conversation_cents: number | null;
}

export interface PropostaCriada {
  id: string;
  kind: string;
  title: string;
  campaign_id: string | null;
}

export interface EstadoDaRodada {
  propostas: PropostaCriada[];
  recusas: { acao: AcaoDeEscrita; campaign_id: string }[];
}

const kindSchema = z.enum(["orcamento", "pausar", "palavra_chave", "anuncio", "observacao"]);

export function ferramentasDoAgente(
  admin: SupabaseClient,
  conta: ContaDeAnuncios,
  ctx: ContextoDeAnuncios,
  estado: EstadoDaRodada,
  requestId: string,
): ToolSet {
  const nivel = nivelValido(conta.autonomy_level);

  async function recusar(acao: AcaoDeEscrita, campaignId: string) {
    estado.recusas.push({ acao, campaign_id: campaignId });
    void audit({
      action: "ads.escrita_recusada",
      organizationId: conta.organization_id,
      resourceType: "ad_account",
      resourceId: conta.id,
      requestId,
      bypassedRls: true,
      metadata: { acao, campaign_id: campaignId, autonomy_level: nivel },
    });
    return { recusado: true, motivo: MOTIVO_NIVEL_INSUFICIENTE, nivel, dica: "Use `propor` — no nível atual só proposta chega ao Dono." };
  }

  return {
    ler_campanhas: tool({
      description: "Relê o resumo das campanhas (7 e 30 dias): gasto, cliques, conversas, consultas pagas e Sobra por Real.",
      inputSchema: z.object({}),
      execute: async () => ({ resumo: contextoEmTexto(ctx) }),
    }),
    ler_sobra_por_real: tool({
      description: "Sobra por Real por campanha numa das janelas, com os dias incompletos.",
      inputSchema: z.object({ dias: z.union([z.literal(7), z.literal(30)]) }),
      execute: async ({ dias }) => {
        const j = ctx.janelas.find((x) => x.dias === dias);
        return j ? j.sobra : { erro: "janela_desconhecida" };
      },
    }),
    propor: tool({
      description:
        "Registra uma proposta para o Dono decidir. Não muda nada no Google. Uma proposta por assunto; não repita as pendentes.",
      inputSchema: z.object({
        campaign_id: z.string().max(40).nullable(),
        kind: kindSchema,
        title: z.string().min(3).max(200),
        body: z.string().min(10).max(4000),
        payload: z.record(z.string(), z.unknown()).optional(),
      }),
      execute: async (p) => {
        const { data, error } = await admin
          .from("ad_proposals")
          .insert({
            organization_id: conta.organization_id,
            campaign_id: p.campaign_id,
            kind: p.kind,
            level: nivel,
            title: p.title,
            body: p.body,
            payload: p.payload ?? {},
          })
          .select("id")
          .single();
        if (error || !data) {
          logger.error("[ads.agente] não deu para gravar a proposta", { organization_id: conta.organization_id, detail: error?.message });
          return { gravada: false };
        }
        const criada = { id: (data as { id: string }).id, kind: p.kind, title: p.title, campaign_id: p.campaign_id };
        estado.propostas.push(criada);
        void audit({
          action: "ads.proposta_criada",
          organizationId: conta.organization_id,
          resourceType: "ad_proposal",
          resourceId: criada.id,
          requestId,
          bypassedRls: true,
          metadata: { kind: p.kind, campaign_id: p.campaign_id, autonomy_level: nivel },
        });
        return { gravada: true, id: criada.id };
      },
    }),
    ajustar_orcamento: tool({
      description: "Muda o orçamento diário de uma campanha (só nos níveis 2 e 3; abaixo disso, recusa).",
      inputSchema: z.object({ campaign_id: z.string().max(40), novo_orcamento_cents: z.number().int().min(0) }),
      execute: async ({ campaign_id }) => {
        if (!podeEscrever(conta, "orcamento")) return recusar("orcamento", campaign_id);
        return { aplicado: false, motivo: "escrita_chega_na_fase_8" };
      },
    }),
    pausar_campanha: tool({
      description: "Pausa uma campanha (só nos níveis 2 e 3; abaixo disso, recusa).",
      inputSchema: z.object({ campaign_id: z.string().max(40), motivo: z.string().max(300) }),
      execute: async ({ campaign_id }) => {
        if (!podeEscrever(conta, "pausar")) return recusar("pausar", campaign_id);
        return { aplicado: false, motivo: "escrita_chega_na_fase_8" };
      },
    }),
  };
}
