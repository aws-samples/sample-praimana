import {
  createDocClient,
  createSendQuota,
  withHealth,
} from "@praimana/service-shared";
import { createNotifyRoutes } from "./routes.js";
import {
  ConsoleEmailTransport,
  SesEmailTransport,
  parseReplyTo,
} from "./transport.js";
import type { EmailTransport } from "./domain.js";

/**
 * The env var that must be set, to exactly "true", for the console transport to be
 * selectable. Named DEV in full and checked against a literal rather than truthiness,
 * so no accidental "0"/"false"/"no" enables it.
 */
export const DEV_CONSOLE_TRANSPORT_FLAG = "NOTIFY_DEV_CONSOLE_TRANSPORT";

/**
 * Composition root — the ONE place that decides which concrete transport to use.
 * SES when EMAIL_FROM is configured; the console transport ONLY when explicitly asked
 * for. Routes never change either way (DIP).
 *
 * ── ⚠ THIS SELECTION FAILS CLOSED, AND THAT IS THE WHOLE POINT ───────────────────────────
 *
 * The console transport "sends" by writing to stdout, which under Lambda is CloudWatch Logs.
 * The bodies on the two invite paths carry the platform's most sensitive strings: a LIVE
 * Cognito temporary password (templates.ts passwordLines) and the raw single-use registration
 * token inside actionUrl (bulk-provision/src/apply.ts). So the choice between the two
 * transports is really a choice about whether credentials get written to a log, and it must
 * never be made by ACCIDENT.
 *
 * It used to be made by accident in two ways, and both were SILENT:
 *   - EMAIL_FROM absent      → console transport, one console.log at cold start.
 *   - SES constructor threw  → console transport, one console.warn, request path unchanged.
 * Nothing distinguished a deployed function from a laptop — there is no NODE_ENV or STAGE
 * anywhere in this service — so a missing or mistyped EMAIL_FROM on a deployed function
 * turned the mail path into a credential log. Every caller still saw `{sent, via:"console"}`,
 * i.e. a SUCCESS, so nothing upstream could notice either. That defeated the control
 * deliver() believes it has, whose comment states "temporaryPassword was never logged and
 * still is not" (routes.ts) — true of deliver's own audit line, and false of the transport it
 * hands the message to.
 *
 * The rule now: a function that cannot send real mail FAILS TO START. A cold-start crash is a
 * loud, attributable, immediately-visible misconfiguration; succeeding at logging secrets is
 * none of those things. The insecure transport is reachable only by naming it explicitly, and
 * even then it redacts the credential (see ConsoleEmailTransport).
 *
 * ⚠ NEVER SET NOTIFY_DEV_CONSOLE_TRANSPORT ON A DEPLOYED FUNCTION. It exists so a laptop with
 * no AWS credentials can run the stack; it is not a fallback and must not be used as one.
 */
export function selectTransport(
  env: NodeJS.ProcessEnv = process.env
): EmailTransport {
  const devConsole = env[DEV_CONSOLE_TRANSPORT_FLAG] === "true";

  if (env.EMAIL_FROM) {
    // Read here rather than left to the constructor's default, so an injected `env`
    // is honoured in full and a test cannot get a transport half-configured from the
    // real process environment.
    const replyTo = parseReplyTo(env.EMAIL_REPLY_TO);
    // ⚠ NO try/catch AROUND THE CONSTRUCTOR. It threw exactly once — on an empty
    // EMAIL_FROM (transport.ts) — which is the same misconfiguration as the branch below,
    // and catching it here is what silently downgraded a broken mail path into a logging
    // one. Let it propagate: the module fails to load, the function fails to start.
    const transport = new SesEmailTransport(
      env.EMAIL_FROM,
      env.SES_IDENTITY_ARN || "",
      replyTo
    );
    // Logged once at cold start because a MISSING Reply-To is invisible in the
    // sent mail: with a no-reply@ sender the replies just vanish, and nothing
    // downstream reports it. Cheap to state; expensive to discover later.
    console.log(
      replyTo.length
        ? `[notify] SES transport — replies go to ${replyTo.join(", ")}`
        : "[notify] SES transport — EMAIL_REPLY_TO unset, replies to this mail will be DISCARDED"
    );
    return transport;
  }

  if (devConsole) {
    // WARN, not log: this is a real operational fact for whoever reads the log, and if it
    // ever appears in a deployed environment's logs it is an INCIDENT, not a startup notice.
    console.warn(
      `[notify] ${DEV_CONSOLE_TRANSPORT_FLAG}=true — NO MAIL WILL BE SENT. ` +
        "Messages are written to this log with the temporary password redacted. " +
        "This must never be set on a deployed function."
    );
    return new ConsoleEmailTransport();
  }

  // The message names both ways forward, because the operator hitting this has either
  // forgotten a deployment variable or is trying to run the stack locally, and the two
  // need different answers.
  throw new Error(
    "[notify] EMAIL_FROM is not set, so no email can be sent. Set EMAIL_FROM to a " +
      `verified SES identity, or — for LOCAL DEVELOPMENT ONLY — set ${DEV_CONSOLE_TRANSPORT_FLAG}=true ` +
      "to write messages to the log instead of sending them."
  );
}

/**
 * ── ⚠ THE SEND QUOTA, AND WHY ITS ABSENCE IS A WARNING RATHER THAN A THROW ──────────────────
 *
 * Constructed here so `createNotifyRoutes` stays injectable. An unset SEND_QUOTA_TABLE means the
 * relay runs UNMETERED, which is the state a security review flagged, so it is warned about in
 * the same shape and for the same reason as the console transport: loud enough that finding it in
 * a deployed function's log is unambiguous.
 *
 * NOT a throw, unlike EMAIL_FROM. A missing quota degrades to today's behaviour; a missing sender
 * cannot send at all. Refusing to start over a quota table would turn a metering
 * misconfiguration into an email outage — invitations and password resets included — which is a
 * worse failure than the one being prevented.
 */
function selectQuota() {
  const table = process.env.SEND_QUOTA_TABLE;
  if (!table) {
    console.warn(
      "[notify] SEND_QUOTA_TABLE is not set — SENDS ARE NOT METERED. Every permitted role can " +
        "send without limit, bounded only by SES account quota. Set SEND_QUOTA_TABLE to the " +
        "send-quota table to enforce a per-sender budget."
    );
    return undefined;
  }
  // Deliberately generous: this is an abuse ceiling, not a throttle on ordinary use. A
  // facilitator announcing to a cohort in 50-address batches has room for 2,000 recipients an
  // hour before it bites, and nothing in the product sends at that rate.
  const perHour = Number(process.env.NOTIFY_MAX_SENDS_PER_HOUR || "40");
  if (!Number.isFinite(perHour) || perHour < 1) {
    throw new Error(
      `[notify] NOTIFY_MAX_SENDS_PER_HOUR must be a positive number, got "${process.env.NOTIFY_MAX_SENDS_PER_HOUR}"`
    );
  }
  console.log(`[notify] send quota — ${perHour} sends/hour per sender, table ${table}`);
  return createSendQuota({
    client: createDocClient(),
    tableName: table,
    maxPerWindow: perHour,
    // Namespaced so notify's per-sender budget and identity's per-reporter budget cannot consume
    // one another in the shared table.
    scope: "notify-send",
  });
}

const app = createNotifyRoutes({ email: selectTransport(), quota: selectQuota() });

export default withHealth(app, "notify");
