import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { RelatorioClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * `/app/relatorio` — o histórico do que já foi mandado ao Dono às 8h (Fase 7).
 *
 * Manager+, como Financeiro e Anúncios, e pelo mesmo motivo: o texto do
 * relatório traz caixa e vencimentos. Mesmo par de gates de sempre —
 * `requireAuth` resolve quem é, `resolveActiveOrg` resolve a organização.
 */
export default async function RelatorioPage() {
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
        <h1 className="text-2xl font-semibold tracking-tight">{t("Relatório")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("O que chegou no WhatsApp do Dono às 8h, dia a dia.")}
        </p>
      </header>
      <RelatorioClient />
    </div>
  );
}
