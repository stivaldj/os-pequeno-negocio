/**
 * Página de Captura (ADR-0016): o anúncio do Google aponta para `/ir/<slug>`;
 * aqui o clique vira uma linha em `ad_clicks` com um Código de Clique novo e
 * o Contato é mandado ao WhatsApp com a frase pré-preenchida carregando o
 * código. O ingest lê o código na primeira mensagem e consome o clique.
 *
 * Público por desenho: sem cookie, sem auth. O `slug` é global (é o caminho)
 * e a única coisa que se lê; o admin client bypassa RLS e o filtro é o slug.
 * Slug desconhecido ou inativo devolve `destino: null` — a rota responde 404
 * sem dizer por quê.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { frasePreenchida, gerarCodigoDeClique } from "./codigo";

export interface CliqueRecebido {
  slug: string;
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
  userAgent?: string | null;
}

export interface CliqueRegistrado {
  destino: string | null;
  codigo: string | null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{2,60}$/;
const MAX_ID = 200;

function limpar(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  return t.length > 0 && t.length <= MAX_ID && /^[A-Za-z0-9_.-]+$/.test(t) ? t : null;
}

export function destinoDoWhatsApp(whatsappE164: string, mensagem: string, codigo: string): string {
  const numero = whatsappE164.replace(/\D/g, "");
  return `https://wa.me/${numero}?text=${encodeURIComponent(frasePreenchida(mensagem, codigo))}`;
}

export async function registrarClique(admin: SupabaseClient, clique: CliqueRecebido): Promise<CliqueRegistrado> {
  if (!SLUG.test(clique.slug)) return { destino: null, codigo: null };

  const { data: link, error } = await admin
    .from("ad_capture_links")
    .select("id, organization_id, campaign_id, whatsapp_e164, mensagem, active")
    .eq("slug", clique.slug)
    .eq("active", true)
    .maybeSingle();
  if (error) {
    logger.error("[ads.captura] não deu para ler o link", { slug: clique.slug, detail: error.message });
    return { destino: null, codigo: null };
  }
  if (!link) return { destino: null, codigo: null };

  const l = link as { id: string; organization_id: string; campaign_id: string; whatsapp_e164: string; mensagem: string };
  // Colisão de código é improvável (32^6); duas tentativas cobrem o azar.
  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    const codigo = gerarCodigoDeClique();
    const { error: erroInsert } = await admin.from("ad_clicks").insert({
      organization_id: l.organization_id,
      code: codigo,
      link_id: l.id,
      campaign_id: l.campaign_id,
      gclid: limpar(clique.gclid),
      gbraid: limpar(clique.gbraid),
      wbraid: limpar(clique.wbraid),
      user_agent: clique.userAgent ? clique.userAgent.slice(0, 300) : null,
    });
    if (!erroInsert) return { destino: destinoDoWhatsApp(l.whatsapp_e164, l.mensagem, codigo), codigo };
    if (erroInsert.code !== "23505") {
      logger.error("[ads.captura] não deu para gravar o clique", { slug: clique.slug, detail: erroInsert.message });
      // O paciente não pode ficar sem WhatsApp por causa do nosso banco: manda sem código.
      return { destino: destinoDoWhatsApp(l.whatsapp_e164, l.mensagem, codigo), codigo: null };
    }
  }
  return { destino: null, codigo: null };
}
