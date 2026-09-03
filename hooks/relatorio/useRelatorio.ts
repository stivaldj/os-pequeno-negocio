"use client";

import { useQuery } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

/**
 * A tela do Relatório fala com `/api/v1/relatorio/historico` só por aqui.
 *
 * O WIRE é o que a rota devolve: snake_case, `body` é o texto INTEIRO que
 * saiu no WhatsApp naquele dia (o mesmo que `enviarAoDono` mandou), e
 * `incomplete_sections` são os nomes das seções sem dado naquele dia — nunca
 * inferidos de zero.
 */
export interface RelatorioEnviado {
  id: string;
  report_date: string;
  sent_at: string;
  incomplete_sections: string[];
  body: string;
  status: "enviado" | "falhou";
  failure_reason: string | null;
}

export function useHistoricoDeRelatorios(limit = 30) {
  return useQuery({
    queryKey: ["relatorio", "historico", limit],
    queryFn: async () => {
      try {
        const r = await apiClient.get<{ data: RelatorioEnviado[] }>(`/api/v1/relatorio/historico?limit=${limit}`);
        return r.data ?? [];
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}
