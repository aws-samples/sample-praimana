import {
  SESv2Client,
  SendEmailCommand,
} from "@aws-sdk/client-sesv2";
import type { EmailMessage, EmailResult, EmailTransport } from "./domain.js";

/**
 * SESv2-backed transport. Requires EMAIL_FROM to be a verified SES identity in the
 * account/region. In the SES sandbox, recipients must also be verified — that's an
 * account setting, not something this code can change. Throws on send failure so
 * the route can surface a 502 (a queued/eventual model would swallow it, but invite
 * delivery is interactive here, so fail loud).
 *
 * ── Same-account send (the normal path) ──
 * The sender domain is verified in the SAME account the notify Lambda runs in, so
 * SES_IDENTITY_ARN is UNSET and this is an ordinary send under the function's own
 * execution role. Locally, any credentials for that account work — no assume-role
 * and no credential_process helper.
 *
 * ── Delegate send (supported, not currently used) ──
 * If the identity ever lives in a DIFFERENT account, set SES_IDENTITY_ARN to its ARN:
 * SES then treats this as sending authorization and checks that identity's own
 * authorization policy. That is a PARAMETER (FromEmailAddressIdentityArn), not a
 * different API, which is why both modes share this one code path with no branch
 * beyond omitting the field — see buildSendEmailInput below.
 *
 * The SES SANDBOX applies either way and is NOT worked around here (see the service
 * README): every recipient must be a verified identity. Under delegate sending it
 * applies in BOTH accounts, so recipients must be verified twice — one of the reasons
 * the same-account path is preferred.
 */

/**
 * Parse EMAIL_REPLY_TO into the address list SES expects.
 *
 * Accepts one address or a comma-separated list, because SES's ReplyToAddresses is
 * plural and a shared alias plus a named owner is a normal thing to want. Blank
 * entries are dropped so a trailing comma is not turned into an empty address —
 * SES rejects the whole send on a malformed one, which would take down every
 * email over a stray character in a config string.
 */
export function parseReplyTo(raw: string | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((addr) => addr.trim())
    .filter(Boolean);
}

/**
 * Build the SESv2 SendEmail input. Extracted as a PURE function so the exact
 * request shape can be asserted in tests without an SES client or credentials —
 * the omit-when-absent behaviour below is the kind of thing that silently
 * regresses into sending `""` and failing at the API.
 */
export function buildSendEmailInput(
  message: EmailMessage,
  config: { from: string; identityArn?: string; replyTo?: string[] }
) {
  return {
    FromEmailAddress: config.from,
    // Omitted entirely (not sent as "") when absent, so a same-account send is
    // byte-for-byte the request it was before delegate support existed.
    ...(config.identityArn
      ? { FromEmailAddressIdentityArn: config.identityArn }
      : {}),
    // Where replies go. Without this a `no-reply@` sender means every reply is
    // silently discarded — the recipient gets no bounce and we never see it, so a
    // person answering an invitation just goes unanswered.
    //
    // Deliberately transport CONFIG, not a field on EmailMessage: if callers could
    // set it, an authorized-but-hostile sender could point replies from a branded,
    // SPF/DKIM-signed platform email at an address they control. The same reasoning
    // as callers passing semantic fields instead of raw HTML (see routes.ts).
    ...(config.replyTo?.length ? { ReplyToAddresses: config.replyTo } : {}),
    Destination: { ToAddresses: message.to },
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: message.html, Charset: "UTF-8" },
          Text: { Data: message.text, Charset: "UTF-8" },
        },
      },
    },
  };
}

export class SesEmailTransport implements EmailTransport {
  private readonly client: SESv2Client;
  private readonly from: string;
  /**
   * ARN of the verified identity in the OWNING account, when sending as a delegate
   * on its behalf. Empty for a same-account send — which is the current setup.
   */
  private readonly identityArn: string;
  /**
   * Reply-To addresses. Needs NO SES verification of its own — only the From
   * address must be a verified identity — so this can be a real human mailbox on
   * any domain while the sender stays `no-reply@` at the verified one.
   */
  private readonly replyTo: string[];

  constructor(
    from = process.env.EMAIL_FROM || "",
    identityArn = process.env.SES_IDENTITY_ARN || "",
    replyTo = parseReplyTo(process.env.EMAIL_REPLY_TO)
  ) {
    if (!from) {
      throw new Error("EMAIL_FROM is required for the SES transport");
    }
    this.from = from;
    this.identityArn = identityArn;
    this.replyTo = replyTo;
    this.client = new SESv2Client({
      // Must be the region the identity was VERIFIED in — a delegate send has to
      // hit the identity owner's regional endpoint, not merely "some" region.
      region: process.env.AWS_REGION || "us-east-1",
    });
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    const res = await this.client.send(
      new SendEmailCommand(
        buildSendEmailInput(message, {
          from: this.from,
          identityArn: this.identityArn,
          replyTo: this.replyTo,
        })
      )
    );
    return { messageId: res.MessageId ?? null, via: "ses" };
  }
}

/**
 * The credential line the invite templates render, matched so it can be redacted before
 * the console transport logs a body.
 *
 * Anchored to the start of a line and tied to the exact label `passwordLines` emits
 * (templates.ts), because a loose match over a whole body would redact the word wherever
 * it appeared in prose and make the preview unreadable. `i` because the label is prose and
 * may be recased; the value runs to end-of-line since the template deliberately keeps the
 * password on ONE line (a wrapped password is a mis-transcribed password — see passwordLines).
 */
const TEMPORARY_PASSWORD_LINE = /^([ \t]*Temporary password:)[ \t]*\S.*$/gim;

/** What replaces the credential. Says which control fired, so the preview is not confusing. */
const PASSWORD_REDACTION = "$1 [REDACTED — see the /provision response]";

/**
 * Strip the live credential out of a message body destined for a log.
 *
 * Exported for the test: this is the kind of regex that keeps working on the happy path
 * long after it has stopped matching the template it was written against, so the assertion
 * pins them together.
 */
export function redactForLog(text: string): string {
  return text.replace(TEMPORARY_PASSWORD_LINE, PASSWORD_REDACTION);
}

/** The domain of each recipient, deduped — never the addresses themselves. */
function recipientDomains(to: string[]): string[] {
  return [...new Set(to.map((addr) => addr.slice(addr.lastIndexOf("@") + 1)))];
}

/**
 * Console transport — the LOCAL-DEV-ONLY transport. It "sends" by logging the message so
 * you can follow the invite link from apps/services/.logs/notify.log without configuring
 * SES. Liskov-substitutable for the real transport so nothing upstream changes.
 *
 * ── ⚠ REACHABLE ONLY BY EXPLICIT OPT-IN, AND IT REDACTS THE CREDENTIAL ANYWAY ─────────────
 *
 * Selecting this transport is now an explicit act (NOTIFY_DEV_CONSOLE_TRANSPORT=true — see
 * app.ts for why it stopped being a fallback). This class hardens the same finding from the
 * other side, so that a mistake in the composition root cannot on its own put a credential
 * in CloudWatch:
 *
 *   - The TEMPORARY PASSWORD is REDACTED. It is a live Cognito credential, and no local
 *     workflow needs it from this log: /provision returns it to its caller (user-access
 *     routes.ts). Costs the developer nothing, removes the worst string in the body.
 *   - RECIPIENT ADDRESSES become DOMAINS, the rule this repo already applies in deliver()
 *     ("count and domains, never the addresses") and in workshop-directory.http.ts.
 *   - The BODY, including actionUrl, IS still logged — deliberately, because following the
 *     invite link IS the reason this transport exists, and the link is unusable to anyone
 *     who cannot also read a developer's laptop. ⚠ That link embeds a raw single-use
 *     registration token, which is precisely why app.ts refuses to select this transport
 *     unless it was asked for by name.
 */
export class ConsoleEmailTransport implements EmailTransport {
  async send(message: EmailMessage): Promise<EmailResult> {
    console.log(
      `[notify] (console transport — NOT SENT) → ${recipientDomains(message.to).join(", ")}` +
        ` (${message.to.length} recipient${message.to.length === 1 ? "" : "s"})\n` +
        `  subject: ${message.subject}\n` +
        `  text:\n${redactForLog(message.text)
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")}`
    );
    return { messageId: null, via: "console" };
  }
}
