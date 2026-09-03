/**
 * A janela de tempo do relatório — hoje e ontem, no fuso da CONTA.
 *
 * O cron dispara em horário UTC fixo (como `financeiro-lembretes` e
 * `ads-agent`: nenhum cron do repo despacha por `organizations.timezone`
 * hoje). A MATEMÁTICA de data, porém, usa o fuso de verdade — mesmo padrão de
 * `app/api/v1/financeiro/caixa/route.ts`: `diaLocalISO` e `instanteDe`
 * (`lib/agenda/fuso.ts`), com `FUSO_PADRAO` quando a coluna traz algo que o
 * `Intl` recusa. `new Date()` nunca aparece fora deste arquivo — os leitores
 * recebem a janela já resolvida, no molde de `lib/financeiro/lembretes.ts`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { diaLocalISO, instanteDe } from "@/lib/agenda/fuso";
import { somarDias } from "@/lib/financeiro/vencimentos";
import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";

export interface JanelaDoRelatorio {
  organizationId: string;
  fuso: string;
  /** `YYYY-MM-DD` — o dia que o relatório descreve. */
  hoje: string;
  ontem: string;
  /** [início de hoje, início de amanhã) no fuso da Conta, em ISO — para `de`/`ate` de instante. */
  hojeInicioISO: string;
  hojeFimISO: string;
  /** [início de ontem, início de hoje) — a janela "da noite" e a janela de ads. */
  ontemInicioISO: string;
}

function partesDoDia(dia: string): { ano: number; mes: number; dia: number } {
  const partes = dia.split("-");
  return { ano: Number(partes[0]), mes: Number(partes[1]), dia: Number(partes[2]) };
}

function inicioDoDiaISO(dia: string, fuso: string): string {
  return instanteDe({ ...partesDoDia(dia), hora: 0, minuto: 0, segundo: 0 }, fuso).toISOString();
}

/** Mesma degradação da rota de caixa: valor que o `Intl` recusa vira o padrão do produto. */
export async function fusoDaConta(admin: SupabaseClient, organizationId: string): Promise<string> {
  const { data } = await admin.from("organizations").select("timezone").eq("id", organizationId).maybeSingle();
  const bruto = ((data as { timezone: string | null } | null)?.timezone ?? "").trim();
  return bruto !== "" && fusoValido(bruto) ? bruto : FUSO_PADRAO;
}

export async function janelaDoRelatorio(
  admin: SupabaseClient,
  organizationId: string,
  agora: Date,
): Promise<JanelaDoRelatorio> {
  const fuso = await fusoDaConta(admin, organizationId);
  const hoje = diaLocalISO(agora, fuso);
  const ontem = somarDias(hoje, -1);
  const amanha = somarDias(hoje, 1);
  return {
    organizationId,
    fuso,
    hoje,
    ontem,
    hojeInicioISO: inicioDoDiaISO(hoje, fuso),
    hojeFimISO: inicioDoDiaISO(amanha, fuso),
    ontemInicioISO: inicioDoDiaISO(ontem, fuso),
  };
}
