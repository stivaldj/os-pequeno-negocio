"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * A tela de Anúncios fala com `/api/v1/ads/*` só por aqui.
 *
 * As formas abaixo são o WIRE das rotas — lidas do código delas, snake_case
 * como toda a `/api/v1/`. Toda mutação invalida `["ads"]`, então os quatro
 * blocos da tela repintam juntos: aprovar uma proposta some da lista e a
 * Conta salva volta com o que o banco gravou.
 */

export interface ContaDeAnuncios {
  id: string;
  customer_id: string;
  conversion_customer_id: string | null;
  conversion_action: string | null;
  currency: string;
  /** ADR-0018. Só leitura nesta fase. */
  autonomy_level: number;
  status: "active" | "paused" | "error";
  last_sync_at: string | null;
  last_error: string | null;
}

export interface DadosDaConta {
  customer_id: string;
  conversion_customer_id: string | null;
  conversion_action: string | null;
}

export interface LinkDeCaptura {
  id: string;
  slug: string;
  campaign_id: string;
  campaign_name: string | null;
  whatsapp_e164: string;
  mensagem: string;
  active: boolean;
  /** A URL pública, pronta para colar no Google. */
  url: string;
  created_at: string;
}

export interface DadosDoLink {
  campaign_id: string;
  campaign_name: string;
  whatsapp_e164: string;
  mensagem: string;
}

export interface Campanha {
  campaign_id: string;
  campaign_name: string | null;
  gasto_cents: number;
  /** `null` quando o Google não reportou cliques em nenhum dia do período. */
  cliques: number | null;
  contatos: number;
  /** Vendas com margem + sem margem. */
  agendamentos: number;
  vendas: number;
  vendas_sem_margem: number;
  receita_cents: number;
  sobra_cents: number;
  /** `null` sem gasto — a tela mostra travessão, nunca zero. */
  sobra_por_real: number | null;
  dias_sem_gasto: string[];
  incompleto: boolean;
}

export interface RelatorioDeCampanhas {
  periodo: { de: string; ate: string };
  campanhas: Campanha[];
  total: {
    gasto_cents: number;
    receita_cents: number;
    sobra_cents: number;
    sobra_por_real: number | null;
    incompleto: boolean;
  };
}

export type Dias = 7 | 30;

export interface Proposta {
  id: string;
  campaign_id: string | null;
  kind: "orcamento" | "pausar" | "palavra_chave" | "anuncio" | "observacao";
  level: number;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  status: "pendente" | "aprovada" | "recusada" | "aplicada";
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export type Decisao = "aprovada" | "recusada";

export function useContaDeAnuncios() {
  return useQuery({
    queryKey: ["ads", "conta"],
    queryFn: async () => {
      try {
        const r = await apiClient.get<{ data: ContaDeAnuncios | null }>("/api/v1/ads/conta");
        return r.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}

export function useSalvarConta() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (dados: DadosDaConta) => apiClient.patch<{ data: ContaDeAnuncios }>("/api/v1/ads/conta", dados),
    onSuccess: () => {
      toast.success(t("Conta de anúncios salva."));
      void qc.invalidateQueries({ queryKey: ["ads"] });
    },
    onError: (err) => showApiError(err),
  });
}

export function useLinksDeCaptura() {
  return useQuery({
    queryKey: ["ads", "links"],
    queryFn: async () => {
      try {
        const r = await apiClient.get<{ data: LinkDeCaptura[] }>("/api/v1/ads/links");
        return r.data ?? [];
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}

export function useCriarLink() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (dados: DadosDoLink) => apiClient.post<{ data: LinkDeCaptura }>("/api/v1/ads/links", dados),
    onSuccess: () => {
      toast.success(t("Link de captura criado."));
      void qc.invalidateQueries({ queryKey: ["ads", "links"] });
    },
    onError: (err) => showApiError(err),
  });
}

export function useCampanhas(dias: Dias) {
  return useQuery({
    queryKey: ["ads", "campanhas", dias],
    queryFn: async () => {
      try {
        const r = await apiClient.get<{ data: RelatorioDeCampanhas }>(`/api/v1/ads/campanhas?dias=${dias}`);
        return r.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}

export function usePropostasPendentes() {
  return useQuery({
    queryKey: ["ads", "propostas", "pendente"],
    queryFn: async () => {
      try {
        const r = await apiClient.get<{ data: Proposta[] }>("/api/v1/ads/propostas?status=pendente");
        return r.data ?? [];
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}

export function useDecidirProposta() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (entrada: { id: string; status: Decisao }) =>
      apiClient.patch<{ data: { id: string; status: Decisao } }>("/api/v1/ads/propostas", entrada),
    onSuccess: (_r, entrada) => {
      toast.success(entrada.status === "aprovada" ? t("Proposta aprovada.") : t("Proposta recusada."));
      void qc.invalidateQueries({ queryKey: ["ads", "propostas"] });
    },
    onError: (err) => showApiError(err),
  });
}
