/**
 * Atendimentos e Passagens — lê `fn_atrito_metrics` (migrations 0133+0134),
 * o mesmo RPC de `/api/v1/metrics/atrito`. Não recalcula nada: `escopo.demandas`
 * é a contagem de demandas encerradas na janela, `cliente.pedidos_de_humano`
 * é quantas pediram Passagem para humano na mesma janela.
 *
 * `fn_atrito_metrics` é `language sql stable` sem `security definer`, mas
 * filtra `organization_id = p_org` explicitamente em cada CTE — não depende
 * só de RLS, então é seguro chamar com o admin client (que bypassa RLS) desde
 * que `p_org` venha de fonte confiável, como aqui (a Conta que o cron itera).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

import type { JanelaDoRelatorio } from "./janela";
import type { SecaoAtendimentos } from "./tipos";

interface AtritoBrutoParcial {
  escopo?: { demandas?: number };
  cliente?: { pedidos_de_humano?: number };
}

const INCOMPLETO: SecaoAtendimentos = { atendidos: 0, passadosParaHumano: 0, incompleto: true };

export async function atendimentosDaNoite(
  admin: SupabaseClient,
  janela: JanelaDoRelatorio,
): Promise<SecaoAtendimentos> {
  const { data, error } = await admin.rpc("fn_atrito_metrics", {
    p_org: janela.organizationId,
    p_from: janela.ontemInicioISO,
    p_to: janela.hojeInicioISO,
  });
  if (error) {
    logger.warn("[relatorio] fn_atrito_metrics falhou — seção de atendimentos incompleta", {
      organization_id: janela.organizationId,
      error: error.message.slice(0, 200),
    });
    return INCOMPLETO;
  }

  const bruto = data as AtritoBrutoParcial | null;
  const atendidos = bruto?.escopo?.demandas;
  const passadosParaHumano = bruto?.cliente?.pedidos_de_humano;
  if (typeof atendidos !== "number" || typeof passadosParaHumano !== "number") {
    return INCOMPLETO;
  }
  return { atendidos, passadosParaHumano, incompleto: false };
}
