import { randomUUID } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { createGmailClient, encodeMessage } from "../services/gmail.service.js";

/**
 * Outbound email provider abstraction — same shape as sms-provider.ts's
 * SmsProvider, so plugging in a different provider later (Resend, Postmark,
 * SES) is a one-file change here, not a rewrite of the callers.
 */

export interface EmailSendResult {
  /** RFC 5322 Message-ID header of the sent message — used for reply threading (inReplyTo/references) and as the send record's idempotency handle, same role providerMessageId plays for SMS. */
  readonly messageId: string;
}

export interface EmailSendOptions {
  /** Display name for the From header, e.g. "Lucy at Luma Health". Falls back to the provider's configured default identity when omitted. */
  readonly fromName?: string;
  readonly replyTo?: string;
  /** RFC 5322 Message-ID of the message being replied to — sets the In-Reply-To header so mail clients thread the conversation. */
  readonly inReplyTo?: string;
  /** RFC 5322 References header (the full thread chain) — set alongside inReplyTo for correct threading in every mail client, not just ones that thread off In-Reply-To alone. */
  readonly references?: string;
}

export interface EmailProvider {
  sendEmail(to: string, subject: string, html: string, opts?: EmailSendOptions): Promise<EmailSendResult>;
}

export class EmailProviderNotConfiguredError extends Error {
  constructor() {
    super("No email provider is configured (EMAIL_PROVIDER is unset).");
    this.name = "EmailProviderNotConfiguredError";
  }
}

/**
 * Google Workspace SMTP relay (smtp-relay.gmail.com:587, STARTTLS). Requires
 * "SMTP Authentication" to be enabled for this workspace (Admin console →
 * Apps → Google Workspace → Gmail → Routing → SMTP relay service) and a
 * mailbox app password for `user` — see .env.example for the exact vars.
 *
 * The relay validates the authenticated `user` as the sender unless the
 * workspace has "Allow users to send mail from a different address"
 * enabled; `fromEmail` therefore defaults to `user` and should only be set
 * to something else once that's configured (or a Gmail "Send mail as"
 * alias exists for `user`).
 */
class GoogleWorkspaceEmailProvider implements EmailProvider {
  private readonly transporter: Transporter;

  constructor(
    private readonly user: string,
    appPassword: string,
    private readonly fromEmail: string,
    port: number,
  ) {
    // Port 465 is implicit TLS from the first byte (secure: true); every
    // other port (587, 25) uses plaintext-then-STARTTLS (secure: false,
    // requireTLS: true so a relay that can't upgrade fails instead of
    // silently sending in the clear). Configurable because some hosts block
    // 587 outbound (the classic anti-spam port block) while allowing 465.
    const secure = port === 465;
    this.transporter = nodemailer.createTransport({
      host: "smtp-relay.gmail.com",
      port,
      secure,
      requireTLS: secure ? undefined : true,
      auth: { user, pass: appPassword },
      // Without these, a blocked/unreachable network path hangs the whole
      // send (nodemailer's own default connection timeout is 2 minutes) —
      // since callers await this inline from a synchronous webhook handler,
      // that turns a network problem into a hung HTTP request instead of a
      // fast, logged failure. 10s is generous for reaching Google's relay.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
  }

  async sendEmail(to: string, subject: string, html: string, opts: EmailSendOptions = {}): Promise<EmailSendResult> {
    const info = await this.transporter.sendMail({
      from: opts.fromName ? { name: opts.fromName, address: this.fromEmail } : this.fromEmail,
      to,
      subject,
      html,
      replyTo: opts.replyTo,
      inReplyTo: opts.inReplyTo,
      references: opts.references,
    });

    if (!info.messageId) {
      throw new Error("Google Workspace SMTP send response missing messageId.");
    }
    return { messageId: info.messageId };
  }
}

/**
 * Google Workspace via the Gmail API over HTTPS (port 443), authenticated
 * as the mailbox connected through the /auth/google OAuth flow
 * (gmail-oauth.routes.ts) — sends as whichever account granted that
 * consent, same as the SMTP relay authenticates as `user`. Built to work
 * around Railway blocking outbound SMTP entirely (confirmed: both 587 and
 * 465 time out) — HTTPS to Google's API isn't blocked the way raw SMTP is.
 *
 * Builds and sends a raw RFC 5322 message ourselves rather than using a
 * higher-level Gmail "send email" helper, since the API's users.messages.send
 * only accepts a base64url-encoded raw MIME message — this mirrors what
 * nodemailer did internally for the SMTP path, just constructed by hand.
 */
class GmailApiEmailProvider implements EmailProvider {
  constructor(private readonly fromEmail: string) {}

  async sendEmail(to: string, subject: string, html: string, opts: EmailSendOptions = {}): Promise<EmailSendResult> {
    // Gmail API's send response gives Gmail's own internal message id, not
    // an RFC 5322 Message-ID header value — generating our own up front
    // means every caller (reply threading, the send-record idempotency
    // handle) gets the same kind of value the SMTP path's nodemailer
    // transport handed back, with no extra round-trip to look it up.
    const domain = this.fromEmail.split("@")[1] ?? "mylumahealth.com";
    const messageId = `<${randomUUID()}@${domain}>`;
    const wrapMessageId = (id: string) => (id.startsWith("<") ? id : `<${id}>`);
    const from = opts.fromName ? `"${opts.fromName}" <${this.fromEmail}>` : this.fromEmail;

    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Message-ID: ${messageId}`,
      opts.replyTo ? `Reply-To: ${opts.replyTo}` : null,
      opts.inReplyTo ? `In-Reply-To: ${wrapMessageId(opts.inReplyTo)}` : null,
      opts.references ? `References: ${wrapMessageId(opts.references)}` : null,
      "MIME-Version: 1.0",
      'Content-Type: text/html; charset="UTF-8"',
    ].filter((header): header is string => header !== null);

    const raw = [...headers, "", html].join("\r\n");

    await createGmailClient().users.messages.send({
      userId: "me",
      requestBody: { raw: encodeMessage(raw) },
    });

    return { messageId };
  }
}

/**
 * Which persona is sending — lets Lucy and Sarah show different display
 * names (and, if the workspace has separate "send mail as" aliases
 * configured, different addresses via the per-persona *_FROM_EMAIL vars)
 * while sharing one authenticated mailbox by default. See .env.example.
 */
export type EmailPersona = "lucy" | "sarah";

const PERSONA_DEFAULT_NAME: Record<EmailPersona, string> = {
  lucy: "Lucy at Luma Health",
  sarah: "Sarah at Luma Health",
};

function personaFromName(persona: EmailPersona): string {
  const personaEnvKey = persona === "lucy" ? "GOOGLE_WORKSPACE_LUCY_FROM_NAME" : "GOOGLE_WORKSPACE_SARAH_FROM_NAME";
  return process.env[personaEnvKey] ?? PERSONA_DEFAULT_NAME[persona];
}

export function getEmailProvider(persona: EmailPersona): { provider: EmailProvider; fromName: string } {
  const providerName = process.env.EMAIL_PROVIDER;
  if (!providerName) {
    throw new EmailProviderNotConfiguredError();
  }

  if (providerName === "gmail_api") {
    // The mailbox connected via /auth/google (gmail-oauth.routes.ts) —
    // reuses GOOGLE_WORKSPACE_SMTP_USER as the known address rather than
    // requiring a separate var, since it's the same mailbox either way.
    const fromEmail = process.env.GOOGLE_GMAIL_FROM_EMAIL ?? process.env.GOOGLE_WORKSPACE_SMTP_USER;
    const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "GOOGLE_REFRESH_TOKEN"].filter((key) => !process.env[key]);
    if (!fromEmail || missing.length > 0) {
      const missingList = [...(fromEmail ? [] : ["GOOGLE_GMAIL_FROM_EMAIL or GOOGLE_WORKSPACE_SMTP_USER"]), ...missing];
      throw new Error(`EMAIL_PROVIDER is 'gmail_api' but ${missingList.join(", ")} is not set.`);
    }
    return { provider: new GmailApiEmailProvider(fromEmail), fromName: personaFromName(persona) };
  }

  if (providerName === "google_workspace") {
    const user = process.env.GOOGLE_WORKSPACE_SMTP_USER;
    const appPassword = process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD;
    if (!user || !appPassword) {
      throw new Error("EMAIL_PROVIDER is 'google_workspace' but GOOGLE_WORKSPACE_SMTP_USER/GOOGLE_WORKSPACE_SMTP_APP_PASSWORD is not set.");
    }
    const fromEmail = process.env.GOOGLE_WORKSPACE_FROM_EMAIL ?? user;
    const port = process.env.GOOGLE_WORKSPACE_SMTP_PORT ? Number(process.env.GOOGLE_WORKSPACE_SMTP_PORT) : 587;
    return { provider: new GoogleWorkspaceEmailProvider(user, appPassword, fromEmail, port), fromName: personaFromName(persona) };
  }

  throw new EmailProviderNotConfiguredError();
}
