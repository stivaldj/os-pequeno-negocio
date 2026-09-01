"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { Conversation } from "@/lib/types/messaging";

interface CloseArgs {
  conversation_id: string;
}

export function useCloseConversation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: CloseArgs) =>
      apiClient.post<{ data: Conversation }>(
        `/api/v1/conversations/${args.conversation_id}/close`,
        {},
      ),
    onError: (err, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
      showApiError(err);
    },
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
    },
  });
}
