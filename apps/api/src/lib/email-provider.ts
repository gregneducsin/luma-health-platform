import nodemailer, { type Transporter } from "nodemailer";

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

/**
 * Hard kill switch for all outbound email sending — every trigger email and
 * every AI-drafted reply goes through getEmailProvider, so flipping this to
 * true here (a code change + deploy, not a Railway env var) guarantees
 * nothing sends regardless of what EMAIL_PROVIDER/credentials are set to.
 * Deliberately not env-driven: this is meant to require a deploy to
 * change, not be toggleable by accident. Flip back to false to resume.
 * Inbound IMAP reading is unaffected — this only gates the send path.
 */
const OUTBOUND_EMAIL_SENDING_PAUSED = true;

export function getEmailProvider(persona: EmailPersona): { provider: EmailProvider; fromName: string } {
  if (OUTBOUND_EMAIL_SENDING_PAUSED) {
    throw new EmailProviderNotConfiguredError();
  }

  const providerName = process.env.EMAIL_PROVIDER;
  if (!providerName) {
    throw new EmailProviderNotConfiguredError();
  }
  if (providerName !== "google_workspace") {
    throw new EmailProviderNotConfiguredError();
  }

  const user = process.env.GOOGLE_WORKSPACE_SMTP_USER;
  const appPassword = process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD;
  if (!user || !appPassword) {
    throw new Error("EMAIL_PROVIDER is 'google_workspace' but GOOGLE_WORKSPACE_SMTP_USER/GOOGLE_WORKSPACE_SMTP_APP_PASSWORD is not set.");
  }
  const fromEmail = process.env.GOOGLE_WORKSPACE_FROM_EMAIL ?? user;
  const port = process.env.GOOGLE_WORKSPACE_SMTP_PORT ? Number(process.env.GOOGLE_WORKSPACE_SMTP_PORT) : 587;

  const personaEnvKey = persona === "lucy" ? "GOOGLE_WORKSPACE_LUCY_FROM_NAME" : "GOOGLE_WORKSPACE_SARAH_FROM_NAME";
  const fromName = process.env[personaEnvKey] ?? PERSONA_DEFAULT_NAME[persona];

  return { provider: new GoogleWorkspaceEmailProvider(user, appPassword, fromEmail, port), fromName };
}
