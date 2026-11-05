/**
 * Notify domain: the ONE thing this service does is deliver an email. Everything
 * depends on the EmailTransport INTERFACE (DIP) — routes.ts never knows whether the
 * concrete transport is SES, a console logger, or an in-memory fake in a test. The
 * composition root (app.ts) picks the implementation.
 */

export interface EmailMessage {
  to: string[];
  subject: string;
  /** Rendered HTML body. */
  html: string;
  /** Plain-text fallback (for clients that don't render HTML). */
  text: string;
}

/** How a delivery attempt went, echoed back to the caller for logging/audit. */
export interface EmailResult {
  /** Provider message id when the transport returns one (SES does); else null. */
  messageId: string | null;
  /** Which transport actually handled it — "ses" or "console". */
  via: string;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<EmailResult>;
}
