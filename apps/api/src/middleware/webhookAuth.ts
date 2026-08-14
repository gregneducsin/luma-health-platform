import type { NextFunction, Request, Response } from "express";
import { timingSafeEqualString } from "../lib/crypto.js";

export const WEBHOOK_SECRET_HEADER = "x-webhook-secret";

/**
 * Shared-secret header auth for inbound webhooks, constant-time compared.
 * This is NOT a cryptographic signature over the payload (no HMAC) — it's a
 * shared static secret, same tier of guarantee as the old app's webhook
 * auth. Kept deliberately separate from CSRF (never mounted on /api/app/*)
 * and from session auth — webhook callers aren't browsers and carry
 * neither a session cookie nor a CSRF token.
 */
export function createWebhookAuth(secretEnvVar: string) {
  return function webhookAuth(req: Request, res: Response, next: NextFunction): void {
    const expected = process.env[secretEnvVar];
    if (!expected) {
      res.status(500).json({ error: `Webhook secret ${secretEnvVar} is not configured.` });
      return;
    }
    const incoming = req.header(WEBHOOK_SECRET_HEADER);
    if (!incoming || !timingSafeEqualString(incoming, expected)) {
      res.status(401).json({ error: "Invalid or missing X-Webhook-Secret." });
      return;
    }
    next();
  };
}
