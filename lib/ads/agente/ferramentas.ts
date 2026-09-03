/**
 * As ferramentas do Agente de Anúncios, no formato do seam de LLM do harness.
 * Leitura livre; `propor` grava em `ad_proposals`; as de escrita passam por
 * `podeEscrever` e, abaixo do nível, RECUSAM e auditam com o nível em vigor
 * (ADR-0018).
 *
 * Nível 2 (Fase 8) escreve DE VERDADE em `ajustar_orcamento`/`pausar_campanha`
 * — chamadas REST reais via `mutarOrcamento`/`mutarStatusDaCampanha`
 * (`lib/ads/google/campanhas.ts`), já testadas com dublê de `fetch`. As duas
 * releem a campanha no Google NA HORA (`lerCampanhas`) para achar o resource
 * name e nunca mutam em cima de cache — o `ad_spend` local é gasto de ontem,
 * não o estado agora.
 *
 * `ajustar_orcamento` tem uma trava que o gate de nível sozinho não cobre:
 * sem `budget_floor_cents`/`budget_ceiling_cents` configurados na Conta, ou
 * com o valor pedido fora do intervalo, RECUSA — nunca escreve "sem limite".
 * `pausar_campanha` não tem essa trava: pausar é a direção segura, e não há
 * piso/teto para "menos gasto".
 *
 * Nível 3 (criar/editar anúncio e palavra-chave) continua só no gate: não há
 * ferramenta de escrita para essas duas ações ainda — mexe com as políticas
 * de saúde do Google e fica fora desta entrega.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { tool, type ToolSet } from "@/lib/agent-engine/edge/llm/run-model-call";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { lerCampanhas, mutarOrcamento, mutarStatusDaCampanha } from "../google/campanhas";
import type { CodigoDeFalha } from "../google/cliente";
import { centavosDeMicros, microsDeCentavos } from "../sobra";
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

  /** Passou do gate de nível, mas uma trava PRÓPRIA da ferramenta recusou — hoje só orçamento fora de piso/teto. */
  async function recusarPorLimite(acao: AcaoDeEscrita, campaignId: string, motivo: string, detalhes: Record<string, unknown>) {
    estado.recusas.push({ acao, campaign_id: campaignId });
    void audit({
      action: "ads.escrita_recusada",
      organizationId: conta.organization_id,
      resourceType: "ad_account",
      resourceId: conta.id,
      requestId,
      bypassedRls: true,
      metadata: { acao, campaign_id: campaignId, autonomy_level: nivel, motivo, ...detalhes },
    });
    return { recusado: true, motivo, nivel, ...detalhes };
  }

  /** Passou do gate e da trava própria, mas a chamada ao Google Ads falhou (config, token, rede, ou a API recusou). */
  async function falhaDeEscrita(acao: AcaoDeEscrita, campaignId: string, code: CodigoDeFalha | "campanha_nao_encontrada", motivoGoogle: string) {
    void audit({
      action: "ads.escrita_falhou",
      organizationId: conta.organization_id,
      resourceType: "ad_account",
      resourceId: conta.id,
      requestId,
      bypassedRls: true,
      metadata: { acao, campaign_id: campaignId, code, motivo: motivoGoogle.slice(0, 300), autonomy_level: nivel },
    });
    logger.error("[ads.agente] escrita no Google Ads falhou", { organization_id: conta.organization_id, acao, campaign_id: campaignId, code });
    return { aplicado: false, motivo: code };
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
      description:
        "Muda o orçamento diário de uma campanha, DE VERDADE no Google Ads — só nos níveis 2 e 3, e só dentro do piso e teto da Conta. Fora do intervalo ou sem os dois configurados, recusa.",
      inputSchema: z.object({ campaign_id: z.string().max(40), novo_orcamento_cents: z.number().int().min(0) }),
      execute: async ({ campaign_id, novo_orcamento_cents }) => {
        if (!podeEscrever(conta, "orcamento")) return recusar("orcamento", campaign_id);

        const { budget_floor_cents: piso, budget_ceiling_cents: teto } = conta;
        if (piso === null || teto === null) {
          return recusarPorLimite("orcamento", campaign_id, "limites_nao_configurados", {
            dica: "O Dono precisa configurar piso e teto de orçamento na tela Anúncios antes do agente poder ajustar sozinho.",
          });
        }
        if (novo_orcamento_cents < piso || novo_orcamento_cents > teto) {
          return recusarPorLimite("orcamento", campaign_id, "fora_dos_limites", { piso_cents: piso, teto_cents: teto, pedido_cents: novo_orcamento_cents });
        }

        const campanhas = await lerCampanhas(conta.customer_id, 7);
        if (!campanhas.ok) return falhaDeEscrita("orcamento", campaign_id, campanhas.code, campanhas.motivo);
        const alvo = campanhas.valor.find((c) => c.campaignId === campaign_id);
        if (!alvo || !alvo.budgetResourceName) {
          return falhaDeEscrita("orcamento", campaign_id, "campanha_nao_encontrada", `campanha ${campaign_id} não encontrada ou sem orçamento próprio (talvez compartilhado)`);
        }

        const r = await mutarOrcamento(conta.customer_id, alvo.budgetResourceName, microsDeCentavos(novo_orcamento_cents));
        if (!r.ok) return falhaDeEscrita("orcamento", campaign_id, r.code, r.motivo);

        const orcamentoAnteriorCents = alvo.budgetAmountMicros === null ? null : centavosDeMicros(alvo.budgetAmountMicros);
        void audit({
          action: "ads.orcamento_ajustado",
          organizationId: conta.organization_id,
          resourceType: "ad_account",
          resourceId: conta.id,
          requestId,
          bypassedRls: true,
          metadata: { campaign_id, orcamento_anterior_cents: orcamentoAnteriorCents, novo_orcamento_cents, autonomy_level: nivel },
        });
        return { aplicado: true, campaign_id, orcamento_anterior_cents: orcamentoAnteriorCents, novo_orcamento_cents };
      },
    }),
    pausar_campanha: tool({
      description: "Pausa uma campanha, DE VERDADE no Google Ads — só nos níveis 2 e 3; abaixo disso, recusa.",
      inputSchema: z.object({ campaign_id: z.string().max(40), motivo: z.string().max(300) }),
      execute: async ({ campaign_id, motivo }) => {
        if (!podeEscrever(conta, "pausar")) return recusar("pausar", campaign_id);

        const campanhas = await lerCampanhas(conta.customer_id, 7);
        if (!campanhas.ok) return falhaDeEscrita("pausar", campaign_id, campanhas.code, campanhas.motivo);
        const alvo = campanhas.valor.find((c) => c.campaignId === campaign_id);
        if (!alvo) return falhaDeEscrita("pausar", campaign_id, "campanha_nao_encontrada", `campanha ${campaign_id} não encontrada`);

        const r = await mutarStatusDaCampanha(conta.customer_id, alvo.campaignResourceName, "PAUSED");
        if (!r.ok) return falhaDeEscrita("pausar", campaign_id, r.code, r.motivo);

        const custoPorConversaCents = alvo.costPerConversionMicros === null ? null : centavosDeMicros(alvo.costPerConversionMicros);
        void audit({
          action: "ads.campanha_pausada",
          organizationId: conta.organization_id,
          resourceType: "ad_account",
          resourceId: conta.id,
          requestId,
          bypassedRls: true,
          metadata: { campaign_id, motivo, custo_por_conversa_cents: custoPorConversaCents, autonomy_level: nivel },
        });
        return { aplicado: true, campaign_id };
      },
    }),
  };
}
