import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Customer,
  CustomerWithStats,
  CreateCustomerRequest,
  UpdateCustomerRequest,
  ListCustomersQuery,
  CustomersSummary,
  CustomersSummaryQuery,
  Purchase,
  PurchaseWithCustomer,
  ListPurchasesQuery,
  PurchasesSummary,
  PurchasesSummaryQuery,
  CreatePurchaseRequest,
  UpdatePurchaseRequest,
} from "@luma/shared";
import { api } from "../lib/apiClient";

export function useCustomersList(query: Partial<ListCustomersQuery>) {
  return useQuery({
    queryKey: ["customers", "list", query],
    queryFn: () =>
      api.get<{ customers: CustomerWithStats[]; total: number }>(
        "/api/app/customers",
        query as Record<string, string | number | undefined>,
      ),
  });
}

export function useCustomersSummary(query: Partial<CustomersSummaryQuery>) {
  return useQuery({
    queryKey: ["customers", "summary", query],
    queryFn: () => api.get<CustomersSummary>("/api/app/customers/summary", query as Record<string, string | number | undefined>),
  });
}

export function useLeadTypes() {
  return useQuery({
    queryKey: ["customers", "lead-types"],
    queryFn: () => api.get<{ leadTypes: string[] }>("/api/app/customers/lead-types"),
  });
}

export function useQuestionnaireIds() {
  return useQuery({
    queryKey: ["customers", "questionnaire-ids"],
    queryFn: () => api.get<{ questionnaireIds: string[] }>("/api/app/customers/questionnaire-ids"),
  });
}

export function usePurchasesList(query: Partial<ListPurchasesQuery>) {
  return useQuery({
    queryKey: ["purchases", "list", query],
    queryFn: () =>
      api.get<{ purchases: PurchaseWithCustomer[]; total: number }>(
        "/api/app/purchases",
        query as Record<string, string | number | undefined>,
      ),
  });
}

export function usePurchasesSummary(query: Partial<PurchasesSummaryQuery>) {
  return useQuery({
    queryKey: ["purchases", "summary", query],
    queryFn: () => api.get<PurchasesSummary>("/api/app/purchases/summary", query as Record<string, string | number | undefined>),
  });
}

export function useCustomer(id: string | undefined) {
  return useQuery({
    queryKey: ["customers", "detail", id],
    queryFn: () => api.get<{ customer: Customer; purchases: Purchase[] }>(`/api/app/customers/${id}`),
    enabled: !!id,
  });
}

export function useCreateCustomer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCustomerRequest) => api.post<{ customer: Customer }>("/api/app/customers", input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["customers", "list"] }),
  });
}

export function useUpdateCustomer(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCustomerRequest) => api.patch<{ customer: Customer }>(`/api/app/customers/${id}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers", "list"] });
      queryClient.invalidateQueries({ queryKey: ["customers", "detail", id] });
    },
  });
}

export function useCreatePurchase(customerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePurchaseRequest) => api.post<{ purchase: Purchase }>(`/api/app/customers/${customerId}/purchases`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers", "detail", customerId] });
      queryClient.invalidateQueries({ queryKey: ["customers", "list"] });
    },
  });
}

export function useUpdatePurchase(customerId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: UpdatePurchaseRequest }) =>
      api.patch<{ purchase: Purchase }>(`/api/app/purchases/${id}`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers", "detail", customerId] });
    },
  });
}
