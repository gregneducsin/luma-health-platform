import { z } from "zod";

export const customerSchema = z.object({
  id: z.string().uuid(),
  personNumber: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().email(),
  phone: z.string().nullable(),
  leadReceivedDate: z.string(),
  leadType: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Customer = z.infer<typeof customerSchema>;

export const createCustomerRequestSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1).optional(),
  leadReceivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD"),
  leadType: z.string().min(1).optional(),
});
export type CreateCustomerRequest = z.infer<typeof createCustomerRequestSchema>;

export const updateCustomerRequestSchema = createCustomerRequestSchema.partial();
export type UpdateCustomerRequest = z.infer<typeof updateCustomerRequestSchema>;

export const listCustomersQuerySchema = z.object({
  search: z.string().trim().min(1).optional(),
  sortBy: z.enum(["createdAt", "leadReceivedDate", "lastName"]).default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;

// Aggregated stats computed at query time, not stored columns.
export const customerWithStatsSchema = customerSchema.extend({
  purchaseCount: z.number().int(),
  totalPaid: z.string(),
  firstPurchaseDate: z.string().nullable(),
  mostRecentPurchaseDate: z.string().nullable(),
});
export type CustomerWithStats = z.infer<typeof customerWithStatsSchema>;
