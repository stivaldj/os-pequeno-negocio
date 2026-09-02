/**
 * Consumir o Código de Clique (ADR-0016): a primeira mensagem do Contato
 * traz o código que a Página de Captura embutiu, e aqui ele vira atribuição.
 *
 * Duas regras de PRIMEIRO TOQUE, uma por lado:
 *
 *   - o CLIQUE vale uma vez. Código já consumido não muda de dono: se dois
 *     números mandarem o mesmo código (encaminharam a frase), o segundo é
 *     `reusado` e não toca em nada;
 *   - o CONTATO é atribuído uma vez. Quem já veio de um anúncio (da Meta, ou
 *     de um clique anterior) não é reatribuído — `fn_estampar_atribuicao_de_anuncio`
 *     já guarda isso no banco, mas ela casa zero linhas em silêncio; ler antes
 *     evita gastar o clique num contato que a RPC ia ignorar.
 *
 * Nada aqui lança: a chamada mora nos efeitos pós-entrada, depois da mensagem
 * gravada, e um código inválido não pode custar a conversa. `desconhecido` é
 * o desfecho de qualquer coisa que não seja um clique válido — inclusive erro
 * de leitura, que vai para o log.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { estamparAtribuicaoDoContato } from "@/lib/leads/atribuicao-de-anuncio";
import { logger } from "@/lib/logger";
import { TAMANHO_DO_CODIGO } from "./codigo";

export type DesfechoDoClique = { status: "atribuido" | "desconhecido" | "reusado" | "ja_atribuido" };

interface CliqueGravado {
  id: string;
  code: string;
  link_id: string | null;
  campaign_id: string;
  campaign_name: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  consumed_at: string | null;
}

const CODIGO_BEM_FORMADO = new RegExp(`^[A-Z2-9]{${TAMANHO_DO_CODIGO}}$`);

export async function consumirCodigoDeClique(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string; codigo: string },
): Promise<DesfechoDoClique> {
  const { organizationId, contactId, codigo } = input;
  if (!CODIGO_BEM_FORMADO.test(codigo)) return { status: "desconhecido" };

  const { data: clique, error: erroClique } = await admin
    .from("ad_clicks")
    .select("id, code, link_id, campaign_id, campaign_name, gclid, gbraid, wbraid, consumed_at")
    .eq("organization_id", organizationId)
    .eq("code", codigo)
    .maybeSingle();
  if (erroClique) {
    logger.error("[ads.atribuicao] não deu para ler o clique; a mensagem entra sem atribuição", {
      organization_id: organizationId,
      contact_id: contactId,
      detalhe: erroClique.message.slice(0, 200),
    });
    return { status: "desconhecido" };
  }
  const c = clique as CliqueGravado | null;
  if (!c) return { status: "desconhecido" };
  if (c.consumed_at) return { status: "reusado" };

  const { data: contato } = await admin
    .from("contacts")
    .select("source_metadata")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  const meta = (contato as { source_metadata?: Record<string, unknown> | null } | null)?.source_metadata;
  if (meta && meta.ad_platform != null) return { status: "ja_atribuido" };

  await estamparAtribuicaoDoContato(admin, contactId, {
    plataforma: "google_ads",
    sourceId: c.campaign_id,
    titulo: c.campaign_name ?? null,
    corpo: null,
    sourceUrl: null,
    bruto: { click_code: c.code, gclid: c.gclid, gbraid: c.gbraid, wbraid: c.wbraid, link_id: c.link_id },
  });

  // `consumed_at is null` no filtro: se duas mensagens do mesmo código correrem,
  // só a primeira marca — a segunda casa zero linhas, sem sobrescrever.
  const { error: erroUpdate } = await admin
    .from("ad_clicks")
    .update({ consumed_at: new Date().toISOString(), contact_id: contactId })
    .eq("organization_id", organizationId)
    .eq("code", codigo)
    .is("consumed_at", null);
  if (erroUpdate) {
    logger.error("[ads.atribuicao] contato estampado, mas o clique não foi marcado como consumido", {
      organization_id: organizationId,
      contact_id: contactId,
      detalhe: erroUpdate.message.slice(0, 200),
    });
  }
  return { status: "atribuido" };
}
