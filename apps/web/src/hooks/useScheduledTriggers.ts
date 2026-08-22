import { useQuery } from "@tanstack/react-query";
import type { UpcomingTriggerResponse } from "@luma/shared";
import { api } from "../lib/apiClient";

const POLL_INTERVAL_MS = 60_000;

/** Powers the "next scheduled message" banner on a conversation's detail panel — see customers.routes.ts's /:id/upcoming-trigger. */
export function useUpcomingTrigger(personId: string | null) {
  return useQuery({
    queryKey: ["customers", "upcoming-trigger", personId],
    queryFn: () => api.get<UpcomingTriggerResponse>(`/api/app/customers/${personId}/upcoming-trigger`),
    enabled: personId !== null,
    refetchInterval: POLL_INTERVAL_MS,
  });
}
