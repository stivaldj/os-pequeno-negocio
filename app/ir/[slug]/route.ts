/**
 * `/ir/<slug>` — a Página de Captura (ADR-0016). Pública, sem HTML: registra
 * o clique do anúncio e redireciona ao WhatsApp com o Código de Clique na
 * frase. Liberada de auth em `lib/auth/public-paths.ts`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { registrarClique } from "@/lib/ads/captura";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ slug: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const { slug } = await ctx.params;
  const q = req.nextUrl.searchParams;
  const r = await registrarClique(createAdminClient(), {
    slug,
    gclid: q.get("gclid"),
    gbraid: q.get("gbraid"),
    wbraid: q.get("wbraid"),
    userAgent: req.headers.get("user-agent"),
  });
  const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
  if (!r.destino) return new NextResponse("not found", { status: 404, headers });
  return NextResponse.redirect(r.destino, { status: 302, headers });
}
