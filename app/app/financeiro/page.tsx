import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { FinanceiroClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * `/app/financeiro` — caixa, extrato e contas a pagar e a receber (Fase 6).
 *
 * Manager+, como Anúncios e o Audit Log, e pelo mesmo motivo: é dinheiro. Quem
 * atende no WhatsApp não sobe extrato bancário da casa nem vê o saldo dela.
 *
 * O gate é o mesmo par de sempre — `requireAuth` resolve quem é, e
 * `resolveActiveOrg` resolve em qual organização; sem organização ativa não há
 * o que mostrar, e o destino é `/app`.
 */
export default async function FinanceiroPage() {
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
        <h1 className="text-2xl font-semibold tracking-tight">{t("Financeiro")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Importe o extrato do banco em OFX e veja quanto tem em caixa, o que vence hoje e o que já venceu.")}
        </p>
      </header>
      <FinanceiroClient />
    </div>
  );
}
