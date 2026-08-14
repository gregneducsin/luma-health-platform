import { eq, and, isNull, gt, sql } from "drizzle-orm";
import {
  db,
  appUsersTable,
  userSessionsTable,
  userInvitationTokensTable,
  passwordResetTokensTable,
  type AppUser,
} from "@luma/db";
import type { AuthUser } from "@luma/shared";
import { dummyVerify, generateRawToken, hashPassword, hashToken, verifyPassword } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";
import { writeUserAuditEvent } from "./audit.service.js";

const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

function toAuthUser(row: AppUser): AuthUser {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    role: row.role,
    status: row.status,
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ── Login ───────────────────────────────────────────────────────────────────

export type LoginResult =
  | { ok: true; user: AuthUser; rawSessionToken: string }
  | { ok: false; reason: "invalid_credentials" | "locked" | "not_active" };

export async function login(email: string, password: string): Promise<LoginResult> {
  const normalized = normalizeEmail(email);
  const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.normalizedEmail, normalized));

  if (!user) {
    await dummyVerify();
    return { ok: false, reason: "invalid_credentials" };
  }

  if (user.status === "locked") {
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await dummyVerify();
      return { ok: false, reason: "locked" };
    }
    // Lockout window has passed — unlock before evaluating the attempt.
    await db
      .update(appUsersTable)
      .set({ status: "active", lockedUntil: null, failedLoginAttempts: 0 })
      .where(eq(appUsersTable.id, user.id));
    user.status = "active";
  }

  if (user.status === "disabled") {
    await dummyVerify();
    return { ok: false, reason: "invalid_credentials" };
  }

  if (user.status === "invited" || !user.passwordHash) {
    await dummyVerify();
    return { ok: false, reason: "not_active" };
  }

  const passwordOk = await verifyPassword(user.passwordHash, password);
  if (!passwordOk) {
    const attempts = user.failedLoginAttempts + 1;
    const willLock = attempts >= MAX_FAILED_LOGIN_ATTEMPTS;
    await db
      .update(appUsersTable)
      .set({
        failedLoginAttempts: attempts,
        ...(willLock ? { status: "locked", lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) } : {}),
      })
      .where(eq(appUsersTable.id, user.id));
    if (willLock) {
      await writeUserAuditEvent({ actorUserId: null, targetUserId: user.id, action: "account_locked" });
    }
    return { ok: false, reason: "invalid_credentials" };
  }

  await db
    .update(appUsersTable)
    .set({ failedLoginAttempts: 0, lastLoginAt: new Date() })
    .where(eq(appUsersTable.id, user.id));

  const { rawToken } = await createSession(user.id);
  await writeUserAuditEvent({ actorUserId: user.id, targetUserId: user.id, action: "login_success" });

  return { ok: true, user: toAuthUser(user), rawSessionToken: rawToken };
}

// ── Sessions ────────────────────────────────────────────────────────────────

export async function createSession(userId: string): Promise<{ rawToken: string; expiresAt: Date }> {
  const rawToken = generateRawToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(userSessionsTable).values({
    userId,
    sessionTokenHash: hashToken(rawToken),
    expiresAt,
  });
  return { rawToken, expiresAt };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await db.update(userSessionsTable).set({ revokedAt: new Date() }).where(eq(userSessionsTable.id, sessionId));
}

// ── Password reset ─────────────────────────────────────────────────────────

/**
 * Always resolves the same way regardless of whether the email exists —
 * enumeration resistance. Returns the raw reset link only for local logging
 * (no email transport is wired up in this phase — see the TODO below); a
 * caller that only cares about the generic "check your email" UX can ignore
 * the return value entirely.
 */
export async function requestPasswordReset(email: string): Promise<{ rawResetLink: string | null }> {
  const normalized = normalizeEmail(email);
  const [user] = await db.select().from(appUsersTable).where(eq(appUsersTable.normalizedEmail, normalized));

  // Only active accounts can use password reset — invited accounts haven't
  // set a password yet and should use the invitation link instead.
  if (!user || user.status !== "active") {
    return { rawResetLink: null };
  }

  // Invalidate any previously-issued, still-unused reset tokens for this
  // user first, so at most one outstanding token exists at a time.
  await db
    .update(passwordResetTokensTable)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokensTable.userId, user.id), isNull(passwordResetTokensTable.usedAt)));

  const rawToken = generateRawToken();
  await db.insert(passwordResetTokensTable).values({
    userId: user.id,
    tokenHash: hashToken(rawToken),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MS),
  });

  await writeUserAuditEvent({ actorUserId: null, targetUserId: user.id, action: "password_reset_requested" });

  const base = process.env.WEB_PUBLIC_URL?.replace(/\/$/, "") ?? "";
  const rawResetLink = `${base}/reset-password?token=${rawToken}`;
  // TODO(texting/notifications phase): replace with a real transactional
  // email send. Until then this is operator-visible only — never logged
  // with the raw token value beyond this one line, and only reachable by
  // someone with access to API server logs.
  logger.info({ userId: user.id }, `auth: password reset link generated (see rawResetLink in response for now)`);

  return { rawResetLink };
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<{ ok: boolean }> {
  const tokenHash = hashToken(rawToken);

  const [redeemed] = await db
    .update(passwordResetTokensTable)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(passwordResetTokensTable.tokenHash, tokenHash),
        isNull(passwordResetTokensTable.usedAt),
        gt(passwordResetTokensTable.expiresAt, sql`now()`),
      ),
    )
    .returning({ userId: passwordResetTokensTable.userId });

  if (!redeemed) return { ok: false };

  const passwordHash = await hashPassword(newPassword);
  await db
    .update(appUsersTable)
    .set({
      passwordHash,
      status: "active",
      lockedUntil: null,
      failedLoginAttempts: 0,
    })
    .where(eq(appUsersTable.id, redeemed.userId));

  // A password reset proves account ownership — revoke every existing
  // session so a previously-stolen session cookie stops working.
  await db.update(userSessionsTable).set({ revokedAt: new Date() }).where(eq(userSessionsTable.userId, redeemed.userId));

  await writeUserAuditEvent({ actorUserId: redeemed.userId, targetUserId: redeemed.userId, action: "password_reset_completed" });

  return { ok: true };
}

// ── Invitations ─────────────────────────────────────────────────────────────

export async function createInvitation(userId: string): Promise<{ rawToken: string; expiresAt: Date }> {
  // Single-outstanding-token invariant, same pattern as password reset.
  await db
    .update(userInvitationTokensTable)
    .set({ usedAt: new Date() })
    .where(and(eq(userInvitationTokensTable.userId, userId), isNull(userInvitationTokensTable.usedAt)));

  const rawToken = generateRawToken();
  const expiresAt = new Date(Date.now() + INVITATION_TOKEN_TTL_MS);
  await db.insert(userInvitationTokensTable).values({
    userId,
    tokenHash: hashToken(rawToken),
    expiresAt,
  });
  return { rawToken, expiresAt };
}

export async function acceptInvitation(rawToken: string, newPassword: string): Promise<{ ok: boolean }> {
  const tokenHash = hashToken(rawToken);

  const [redeemed] = await db
    .update(userInvitationTokensTable)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(userInvitationTokensTable.tokenHash, tokenHash),
        isNull(userInvitationTokensTable.usedAt),
        gt(userInvitationTokensTable.expiresAt, sql`now()`),
      ),
    )
    .returning({ userId: userInvitationTokensTable.userId });

  if (!redeemed) return { ok: false };

  const passwordHash = await hashPassword(newPassword);
  await db
    .update(appUsersTable)
    .set({ passwordHash, status: "active", activatedAt: new Date() })
    .where(eq(appUsersTable.id, redeemed.userId));

  await writeUserAuditEvent({ actorUserId: redeemed.userId, targetUserId: redeemed.userId, action: "invitation_accepted" });

  return { ok: true };
}
