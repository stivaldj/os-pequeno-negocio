/**
 * O preparador que todo ingestor de entrada chama ANTES de gravar (ADR-0004).
 *
 * Em Conta de saúde, texto do Contato que revele sintoma, condição ou
 * medicação vira `MARCADOR_CLINICO` em `messages.body` e no preview da
 * conversa, e não segue para os efeitos pós-entrada (follow-ups guardariam a
 * resposta). O `event_log` e o RAG leem `body`, então herdam o marcador.
 *
 * O que se persiste da redação é SÓ a categoria (`redigido.motivo`). As
 * chaves do léxico que casaram nunca saem daqui: "losartana" é medicação.
 *
 * Fail-closed: se a configuração da Conta não puder ser lida, redige. Errar
 * para o lado seguro custa uma mensagem a mais para o humano; errar para o
 * outro grava dado sensível.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { extrairCodigoDeClique } from "@/lib/ads/codigo";
import { logger } from "@/lib/logger";
import { classificarConteudoClinico, type MotivoClinico } from "./classificar";
import { configuracaoClinica } from "./config";

export const MARCADOR_CLINICO = "[conteúdo clínico redigido]";
const PREVIEW_MAX = 120;

export interface EntradaPreparada {
  body: string | null;
  preview: string;
  textoParaEfeitos: string | null;
  redigido: { motivo: MotivoClinico | "configuracao_indisponivel" } | null;
  /**
   * Código de Clique (ADR-0016), lido do texto CRU antes de qualquer decisão
   * de redação. O código não é Conteúdo Clínico, e a primeira mensagem de um
   * Contato que veio do anúncio pode ser clínica — perder a atribuição aí
   * seria perder exatamente a conversa que o anúncio pagou.
   *
   * Opcional só no TIPO: `prepararEntradaDoContato` sempre preenche. O eco da
   * coexistência monta esta forma à mão para a SAÍDA da recepção, que nunca
   * carrega código — e aquele arquivo é herdado, não muda por módulo próprio.
   */
  codigoDeClique?: string | null;
}


async function lerRedacaoDaConta(
  admin: SupabaseClient,
  organizationId: string,
): Promise<{ ok: true; redacao: boolean } | { ok: false }> {
  const { data, error } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) {
    logger.error("[clinica.redacao] não deu para ler a configuração da Conta; redigindo por segurança", {
      organization_id: organizationId,
      detalhe: error.message,
    });
    return { ok: false };
  }
  return { ok: true, redacao: configuracaoClinica((data as { settings?: unknown } | null)?.settings).redacao };
}

function integra(texto: string | null, codigoDeClique: string | null): EntradaPreparada {
  return {
    body: texto,
    preview: (texto ?? "").slice(0, PREVIEW_MAX),
    textoParaEfeitos: texto,
    redigido: null,
    codigoDeClique,
  };
}

function redigida(motivo: NonNullable<EntradaPreparada["redigido"]>, codigoDeClique: string | null): EntradaPreparada {
  return { body: MARCADOR_CLINICO, preview: MARCADOR_CLINICO, textoParaEfeitos: null, redigido: motivo, codigoDeClique };
}

export async function prepararEntradaDoContato(
  admin: SupabaseClient,
  organizationId: string,
  texto: string | null | undefined,
): Promise<EntradaPreparada> {
  const t = texto ?? null;
  // Do texto cru, antes de qualquer decisão: todo ramo abaixo devolve o código.
  const codigoDeClique = extrairCodigoDeClique(t);
  if (t === null || !t.trim()) return integra(t, codigoDeClique);

  const conta = await lerRedacaoDaConta(admin, organizationId);
  if (!conta.ok) return redigida({ motivo: "configuracao_indisponivel" }, codigoDeClique);
  if (!conta.redacao) return integra(t, codigoDeClique);

  const c = classificarConteudoClinico(t);
  if (!c.clinico || !c.motivo) return integra(t, codigoDeClique);
  return redigida({ motivo: c.motivo }, codigoDeClique);
}
