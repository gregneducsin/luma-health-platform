import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupportConversationSummary, SupportConversationDetail, SendSarahTestMessageRequest, SarahTurnResponse } from "@luma/shared";
import { api } from "../lib/apiClient";

const LIST_POLL_INTERVAL_MS = 8_000;
const DETAIL_POLL_INTERVAL_MS = 4_000;

export function useSupportConversationsList() {
  return useQuery({
    queryKey: ["support-conversations", "list"],
    queryFn: () => api.get<{ conversations: SupportConversationSummary[] }>("/api/app/support-conversations"),
    refetchInterval: LIST_POLL_INTERVAL_MS,
  });
}

export function useSupportConversationDetail(id: string | null) {
  return useQuery({
    queryKey: ["support-conversations", "detail", id],
    queryFn: () => api.get<SupportConversationDetail>(`/api/app/support-conversations/${id}`),
    enabled: id !== null,
    refetchInterval: DETAIL_POLL_INTERVAL_MS,
  });
}

/** Sends a simulated inbound message through the real Sarah dispatch pipeline (test/dev tool). */
export function useSendSarahTestMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SendSarahTestMessageRequest) => api.post<SarahTurnResponse>("/api/app/sarah-test/message", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["support-conversations"] });
    },
  });
}

export function useClearSupportNeedsAttention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) => api.post<{ ok: true }>(`/api/app/support-conversations/${conversationId}/clear-attention`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["support-conversations"] });
    },
  });
}
