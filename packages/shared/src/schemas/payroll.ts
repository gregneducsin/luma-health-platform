import { z } from "zod";

// ── Employees ──────────────────────────────────────────────────────────────────

export const employeeSchema = z.object({
  id: z.string().uuid(),
  employeeNumber: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().email(),
  phone: z.string().nullable(),
  hourlyRate: z.string(),
  hireDate: z.string().nullable(),
  status: z.enum(["active", "inactive"]),
  notes: z.string().nullable(),
});
export type Employee = z.infer<typeof employeeSchema>;

export const createEmployeeRequestSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1).optional(),
  hourlyRate: z.string().regex(/^\d+(\.\d{1,2})?$/),
  hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().optional(),
});
export type CreateEmployeeRequest = z.infer<typeof createEmployeeRequestSchema>;

export const updateEmployeeRequestSchema = createEmployeeRequestSchema.partial().extend({
  status: z.enum(["active", "inactive"]).optional(),
});
export type UpdateEmployeeRequest = z.infer<typeof updateEmployeeRequestSchema>;

// ── Payroll weeks ──────────────────────────────────────────────────────────────

export const payrollWeekSchema = z.object({
  id: z.string().uuid(),
  weekStart: z.string(),
  weekEnd: z.string(),
  status: z.enum(["draft", "approved", "paid"]),
  approvedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  paidAt: z.string().nullable(),
  paidBy: z.string().nullable(),
});
export type PayrollWeek = z.infer<typeof payrollWeekSchema>;

export const createPayrollWeekRequestSchema = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weekEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type CreatePayrollWeekRequest = z.infer<typeof createPayrollWeekRequestSchema>;

// ── Employee weekly hours ───────────────────────────────────────────────────────

export const upsertWeeklyHoursRequestSchema = z.object({
  employeeId: z.string().uuid(),
  hoursWorked: z.string().regex(/^\d+(\.\d{1,2})?$/),
  totalDeals: z.number().int().min(0).optional(),
  commissionAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  commissionNotes: z.string().optional(),
  notes: z.string().optional(),
});
export type UpsertWeeklyHoursRequest = z.infer<typeof upsertWeeklyHoursRequestSchema>;

// ── Employee bonuses ───────────────────────────────────────────────────────────

export const createBonusRequestSchema = z.object({
  employeeId: z.string().uuid(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  description: z.string().min(1),
});
export type CreateBonusRequest = z.infer<typeof createBonusRequestSchema>;

// ── Marketing spend weeks ───────────────────────────────────────────────────────

export const createMarketingSpendWeekRequestSchema = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weekEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  advertisingCost: z.string().regex(/^\d+(\.\d{1,2})?$/),
  notes: z.string().optional(),
});
export type CreateMarketingSpendWeekRequest = z.infer<typeof createMarketingSpendWeekRequestSchema>;

export const updateMarketingSpendWeekRequestSchema = z.object({
  advertisingCost: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  notes: z.string().optional(),
});
export type UpdateMarketingSpendWeekRequest = z.infer<typeof updateMarketingSpendWeekRequestSchema>;
