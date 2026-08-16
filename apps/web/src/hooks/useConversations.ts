import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ConversationSummary, ConversationDetail, ConversationResponseStats, SendLucyTestMessageRequest, LucyTurnResponse } from "@luma/shared";
import { api } from "../lib/apiClient";

const LIST_POLL_INTERVAL_MS = 8_000;
const DETAIL_POLL_INTERVAL_MS = 4_000;

export function useConversationsList() {
  return useQuery({
    queryKey: ["conversations", "list"],
    queryFn: () => api.get<{ conversations: ConversationSummary[]; stats: ConversationResponseStats }>("/api/app/conversations"),
    refetchInterval: LIST_POLL_INTERVAL_MS,
  });
}

export function useConversationDetail(id: string | null) {
  return useQuery({
    queryKey: ["conversations", "detail", id],
    queryFn: () => api.get<ConversationDetail>(`/api/app/conversations/${id}`),
    enabled: id !== null,
    refetchInterval: DETAIL_POLL_INTERVAL_MS,
  });
}

/** Sends a simulated inbound message through the real dispatch pipeline (test/dev tool). */
export function useSendLucyTestMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SendLucyTestMessageRequest) => api.post<LucyTurnResponse>("/api/app/lucy-test/message", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

export function useClearNeedsAttention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) => api.post<{ ok: true }>(`/api/app/conversations/${conversationId}/clear-attention`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
