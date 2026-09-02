/**
 * LINKS DE CAPTURA (ADR-0016) — `GET` lista, `POST` cria.
 *
 * Um link por campanha (`unique (organization_id, campaign_id)`): é o que o
 * Dono cola como URL final do anúncio. A Página de Captura (`/ir/<slug>`)
 * grava o clique e manda para o WhatsApp com a mensagem pré-escrita, que é
 * como o contato chega atribuído à campanha.
 *
 * O slug é único no MUNDO (a URL pública não tem org), por isso sai do nome
 * mais quatro caracteres aleatórios — ver `lib/ads/captura.ts`.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { slugDeCaptura, urlDeCaptura } from "@/lib/ads/captura";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const COLUNAS = "id, slug, campaign_id, campaign_name, whatsapp_e164, mensagem, active, created_at";

interface LinhaDeLink {
  id: string;
  slug: string;
  campaign_id: string;
  campaign_name: string | null;
  whatsapp_e164: string;
  mensagem: string;
  active: boolean;
  created_at: string;
}

const criarSchema = z.object({
  campaign_id: z.string().trim().min(1).max(64),
  campaign_name: z.string().trim().min(1).max(200),
  whatsapp_e164: z.string().regex(/^\+[1-9][0-9]{7,14}$/, "WhatsApp em E.164, com o +: +5565999990000."),
  mensagem: z.string().trim().min(1).max(300),
});

const comUrl = (l: LinhaDeLink) => ({ ...l, url: urlDeCaptura(l.slug) });

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("manager", { requestId, resource: "ad_capture_links" });
  if (!authz.ok) return authz.response;

  const { data, error } = await createAdminClient()
    .from("ad_capture_links")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false });
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok(((data ?? []) as LinhaDeLink[]).map(comUrl), { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? undefined;
  const authz = await requireRole("manager", { requestId, resource: "ad_capture_links" });
  if (!authz.ok) return authz.response;

  const lido = criarSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", lido.error.issues[0]?.message ?? "corpo inválido", 422, { requestId });
  }

  const { data, error } = await createAdminClient()
    .from("ad_capture_links")
    .insert({
      organization_id: authz.org.orgId,
      slug: slugDeCaptura(lido.data.campaign_name),
      campaign_id: lido.data.campaign_id,
      campaign_name: lido.data.campaign_name,
      whatsapp_e164: lido.data.whatsapp_e164,
      mensagem: lido.data.mensagem,
    })
    .select(COLUNAS)
    .single();
  if (error) {
    // 23505: a campanha já tem link (ou, improvável, o slug colidiu). Recusa
    // esperada, não erro de sistema.
    if (error.code === "23505") {
      return fail("conflict", "Esta campanha já tem um link de captura.", 409, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  const link = data as LinhaDeLink;
  await audit({
    action: "ads.link_created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "ad_capture_links",
    resourceId: link.id,
    requestId,
    metadata: { slug: link.slug, campaign_id: link.campaign_id },
  });
  return ok(comUrl(link), { requestId, status: 201 });
}
