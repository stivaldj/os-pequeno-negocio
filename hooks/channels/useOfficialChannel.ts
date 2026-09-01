"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface OfficialChannelState {
  /**
   * Embedded Signup é opcional por instalação (ADR-0015): só `available` quando
   * o servidor tem app da Meta configurado. `appId`/`configId` são públicos —
   * vão para o SDK no navegador de qualquer jeito.
   */
  embeddedSignup: { available: boolean; appId: string | null; configId: string | null };
  connected: boolean;
  /** Existe token gravado? O token em si NUNCA volta — ver a rota. */
  hasToken: boolean;
  phoneNumberId: string | null;
  wabaId: string | null;
  displayName: string | null;
  phoneNumber: string | null;
  status: string | null;
  webhook: {
    callbackUrl: string;
    verifyToken: string | null;
    fields: string[];
  } | null;
}

export interface ConnectInput {
  phone_number_id: string;
  waba_id: string;
  token: string;
}

export function useOfficialChannel() {
  return useQuery({
    queryKey: ["official-channel"],
    queryFn: async () => apiClient.get<{ data: OfficialChannelState }>("/api/v1/channels/official"),
    staleTime: 15_000,
  });
}

export function useConnectOfficialChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConnectInput) =>
      apiClient.post<{ data: { connected: boolean; displayName: string; phoneNumber: string | null } }>(
        "/api/v1/channels/official",
        input,
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
    },
  });
}

export interface EmbeddedSignupInput {
  code: string;
  waba_id: string;
  phone_number_id: string;
}

export interface EmbeddedSignupResult {
  connected: boolean;
  coexistence: boolean;
  displayName: string;
  phoneNumber: string | null;
}

/** Troca o `code` do Embedded Signup pelo token, no servidor — o segredo nunca passa pela tela. */
export function useConnectOfficialChannelByEmbeddedSignup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: EmbeddedSignupInput) =>
      apiClient.post<{ data: EmbeddedSignupResult }>(
        "/api/v1/channels/official/embedded-signup",
        input,
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["official-channel"] });
    },
  });
}
