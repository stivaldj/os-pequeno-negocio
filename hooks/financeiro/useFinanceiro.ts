"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError, type ApiErrorBody } from "@/lib/api/types";
import { randomId } from "@/lib/random-id";

/**
 * A tela do Financeiro fala com `/api/v1/financeiro/*` só por aqui.
 *
 * As formas abaixo são o WIRE das rotas — lidas do código delas, snake_case
 * como toda a `/api/v1/`, dinheiro em `_cents`. Toda mutação invalida
 * `["financeiro"]` inteiro, e não só o ramo que mudou: dar uma conta por paga
 * muda a lista de contas E os vencimentos que vêm dentro do `/caixa`; importar
 * um extrato muda o caixa E os últimos lançamentos. Invalidar por ramo
 * deixaria metade da tela mostrando o número velho ao lado do novo, que é a
 * pior forma de errar numa tela de dinheiro.
 *
 * ⚠️ `null` NÃO É ZERO em nenhum campo daqui. `saldo_cents: null` é "esta conta
 * nunca teve saldo lido do banco" e `total_cents: null` é "falta saldo em
 * alguma conta, então não há total". Zero seria uma afirmação — "o Dono não tem
 * dinheiro" —, e é justamente a mentira que a Fase 6 existe para não contar.
 * Quem renderiza tem de dizer isso em palavras.
 */

// ─── `GET /api/v1/financeiro/caixa` ────────────────────────────────────────

export interface ContaDeCaixa {
  bank_id: string;
  account_id: string;
  account_kind: "bank" | "credit_card";
  /** `null` = conta nunca teve saldo importado. Nunca zero. */
  saldo_cents: number | null;
  /** O `as_of` do saldo que valeu, `YYYY-MM-DD`. A tela mostra ao lado do número. */
  saldo_em: string | null;
  lancamentos_depois: number;
  soma_depois_cents: number;
  /** `saldo_cents + soma_depois_cents`, ou `null` sem saldo em que ancorar. */
  saldo_estimado_cents: number | null;
  incompleto: boolean;
}

export interface Caixa {
  /** `null` se QUALQUER conta estiver incompleta. */
  total_cents: number | null;
  incompleto: boolean;
  contas: ContaDeCaixa[];
}

export type DirecaoDaObrigacao = "payable" | "receivable";

export interface ItemDeVencimento {
  id: string;
  direction: DirecaoDaObrigacao;
  description: string;
  amount_cents: number;
  due_on: string;
  status: "open" | "paid" | "cancelled";
}

export interface GrupoDeVencimento {
  itens: ItemDeVencimento[];
  total_cents: Record<DirecaoDaObrigacao, number>;
}

export interface Vencimentos {
  hoje: string;
  vencem_hoje: GrupoDeVencimento;
  vencidas: GrupoDeVencimento;
  proximos_7_dias: GrupoDeVencimento;
}

export interface PainelDeCaixa {
  /** O dia no fuso da ORGANIZAÇÃO, resolvido pela rota. A tela não recalcula. */
  hoje: string;
  fuso: string;
  caixa: Caixa;
  vencimentos: Vencimentos;
}

// ─── `GET/POST /api/v1/financeiro/obrigacoes` ──────────────────────────────

export interface Obrigacao {
  id: string;
  direction: DirecaoDaObrigacao;
  description: string;
  amount_cents: number;
  currency: string;
  due_on: string;
  status: "open" | "paid" | "cancelled";
  paid_on: string | null;
  paid_cents: number | null;
  category_id: string | null;
  reminder_sent_on: string | null;
  created_at: string;
  updated_at: string;
}

export interface DadosDaObrigacao {
  direction: DirecaoDaObrigacao;
  description: string;
  /** Positivo sempre: quem diz pagar ou receber é a direção, não o sinal. */
  amount_cents: number;
  due_on: string;
}

export interface Baixa {
  id: string;
  status: "paid" | "cancelled";
  /** Obrigatório quando `status` é `paid` — o Zod da rota recusa sem ele. */
  paid_on?: string;
}

// ─── `GET /api/v1/financeiro/lancamentos` ──────────────────────────────────

export interface Lancamento {
  id: string;
  bank_id: string;
  account_id: string;
  account_kind: "bank" | "credit_card";
  posted_on: string;
  /** Assinado: o sinal vem do `TRNAMT` do OFX. Débito é negativo. */
  amount_cents: number;
  currency: string;
  trn_type: string;
  description: string;
  /** `'conteudo'` = o banco não mandou FITID confiável; a linha é frágil. */
  key_source: "fitid" | "conteudo";
  source: "ofx" | "manual";
  category_id: string | null;
  created_at: string;
}

// ─── `POST /api/v1/financeiro/extratos` (multipart) ────────────────────────

export interface Descartado {
  motivo: string;
  contexto: string;
}

export interface ContaImportada {
  bank_id: string;
  account_id: string;
  account_kind: string;
  lancamentos: number;
}

export interface ResumoDaImportacao {
  total_lancamentos: number;
  importados: number;
  duplicados: number;
  /** Contagem do ARQUIVO em modo frágil — não do que entrou. Ver a rota. */
  por_conteudo: number;
  saldos_gravados: number;
  descartados: Descartado[];
  contas: ContaImportada[];
}

// ─── Leituras ──────────────────────────────────────────────────────────────

export function useCaixa() {
  return useQuery({
    queryKey: ["financeiro", "caixa"],
    queryFn: async () => {
      try {
        const r = await apiClient.get<{ data: PainelDeCaixa }>("/api/v1/financeiro/caixa");
        return r.data;
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}

export function useObrigacoes() {
  return useQuery({
    queryKey: ["financeiro", "obrigacoes"],
    queryFn: async () => {
      try {
        const r = await apiClient.get<{ data: Obrigacao[] }>("/api/v1/financeiro/obrigacoes?status=open");
        return r.data ?? [];
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}

export function useLancamentos(limit = 50) {
  return useQuery({
    queryKey: ["financeiro", "lancamentos", limit],
    queryFn: async () => {
      try {
        const r = await apiClient.get<{ data: Lancamento[] }>(`/api/v1/financeiro/lancamentos?limit=${limit}`);
        return r.data ?? [];
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
  });
}

// ─── Mutações ──────────────────────────────────────────────────────────────

export function useCriarObrigacao() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async (dados: DadosDaObrigacao) =>
      apiClient.post<{ data: Obrigacao }>("/api/v1/financeiro/obrigacoes", dados),
    onSuccess: () => {
      toast.success(t("Conta cadastrada."));
      void qc.invalidateQueries({ queryKey: ["financeiro"] });
    },
    onError: (err) => showApiError(err),
  });
}

export function useBaixarObrigacao() {
  const qc = useQueryClient();
  const t = useT();
  return useMutation({
    mutationFn: async ({ id, ...corpo }: Baixa) =>
      apiClient.patch<{ data: Obrigacao }>(`/api/v1/financeiro/obrigacoes/${id}`, corpo),
    onSuccess: (_r, entrada) => {
      toast.success(entrada.status === "paid" ? t("Conta dada por paga.") : t("Conta cancelada."));
      void qc.invalidateQueries({ queryKey: ["financeiro"] });
    },
    onError: (err) => showApiError(err),
  });
}

/**
 * O upload do extrato — `fetch` cru, não o `apiClient`.
 *
 * Mesma razão do `useImportContacts`: o client serializa o corpo como JSON e
 * não fala `FormData`. O erro sai como `ApiError` para o diálogo mostrar a
 * `message` que a rota escreveu (ela ensina a exportar OFX do banco, e é a
 * parte que o Dono veio ler).
 */
async function enviarExtrato(file: File): Promise<ResumoDaImportacao> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/v1/financeiro/extratos", {
    method: "POST",
    headers: { "Idempotency-Key": randomId() },
    body: form,
    credentials: "same-origin",
  });
  const texto = await res.text();
  const parsed = texto ? JSON.parse(texto) : null;
  if (!res.ok) {
    const e = (parsed as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, e?.code ?? "unknown_error", e?.details, e?.request_id ?? randomId(), e?.message);
  }
  return (parsed as { data: ResumoDaImportacao }).data;
}

export function useImportarExtrato() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: enviarExtrato,
    // Sem toast aqui: o resumo (importados, duplicados, descartados) é mostrado
    // NO diálogo, que não fecha sozinho — é lá que o Dono confere o extrato.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["financeiro"] });
    },
  });
}
