import { z } from "zod";

// Minimum password length matches the prototype's proven convention.
export const PASSWORD_MIN_LENGTH = 12;

export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const forgotPasswordRequestSchema = z.object({
  email: z.string().email(),
});
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

export const resetPasswordRequestSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const acceptInvitationRequestSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});
export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

// Safe user shape returned to the client — never includes passwordHash.
export const authUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  role: z.enum(["admin", "manager", "customer_service"]),
  status: z.enum(["invited", "active", "locked", "disabled"]),
});
export type AuthUser = z.infer<typeof authUserSchema>;

export const inviteUserRequestSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(["admin", "manager", "customer_service"]),
});
export type InviteUserRequest = z.infer<typeof inviteUserRequestSchema>;
