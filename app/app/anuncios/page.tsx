import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { AnunciosClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * `/app/anuncios` — Google Ads da organização (Fase 5). Manager+, como o
 * Audit Log: é dinheiro e é decisão sobre o que o agente propõe.
 */
export default async function AnunciosPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }
  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Anúncios")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Google Ads: quanto cada campanha devolve por real gasto, links de captura e propostas do agente.")}
        </p>
      </header>
      <AnunciosClient />
    </div>
  );
}
