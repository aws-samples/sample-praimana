import { Hono } from "hono";
import type { Context } from "hono";
import {
  edgeIdentityMiddleware,
  requireIdentity,
  type SendQuota,
} from "@praimana/service-shared";
import type { EmailMessage, EmailTransport } from "./domain.js";
import {
  renderPasswordReset,
  renderRegistrationInvite,
  renderReleaseUpdate,
  renderTeamInvite,
  renderWorkshopUpdate,
} from "./templates.js";

/**
 * Notify service routes. One responsibility: deliver templated emails. It depends
 * on the EmailTransport INTERFACE (injected in app.ts) — never on SES directly.
 *
 * Mounted under /v1/notify. Every route sits behind edgeIdentityMiddleware, so a
 * caller needs a valid Bearer JWT OR the internal-service token (a trusted
 * east-west hop). This is deliberately NOT an open email relay: callers pass
 * SEMANTIC fields (teamName, actionUrl, ...) and the template is rendered here, so
 * the API can't be used to send arbitrary HTML to arbitrary people.
 */
export interface NotifyDeps {
  email: EmailTransport;
  /**
   * Per-sender send accounting. OPTIONAL, and the optionality is the same shape as the console
   * transport's: absent means "not configured", which app.ts reports loudly at cold start rather
   * than hiding. Tests that are not about metering leave it out.
   *
   * ⚠ IT MUST BE A SHARED-STORE QUOTA, NOT AN IN-PROCESS ONE. See the header of
   * service-shared/src/send-quota.ts: what is being protected is SES quota and the platform's
   * sender reputation, both account-wide, and a per-Lambda-instance counter hands an attacker one
   * fresh allowance per concurrent request.
   */
  quota?: SendQuota;
}

/**
 * Who may make this service send mail. edgeIdentityMiddleware establishes only
 * that the caller IS someone; it says nothing about what they may do — so
 * without this every authenticated user, PARTICIPANT included, could send
 * arbitrary recipients a branded email from the verified domain. That is a
 * phishing relay with our SPF/DKIM on it, and it would also burn the SES
 * reputation the whole platform's email depends on.
 *
 * The set mirrors ROLE_GRANTS in packages/shared (a role that can grant no role
 * can send no invitation), kept as a local copy for the same reason the Team
 * service keeps one: these are bundled Lambdas that take no dependency on the
 * front-end package. PARTICIPANT is deliberately absent.
 */
/**
 * ⚠ JUDGE WAS IN THIS SET AND IS GONE, BECAUSE THE COMMENT ABOVE ALREADY SAID IT SHOULD NOT BE.
 *
 * The stated rule is "the set mirrors ROLE_GRANTS — a role that can grant no role can send no
 * invitation". `ROLE_GRANTS.JUDGE` is `[]` (`service-shared/src/roles.ts`, mirrored at
 * `team/src/routes.ts`), so `canInvite("JUDGE")` is false and a judge could grant nothing — yet
 * JUDGE sat in this set, which made the sentence above FALSE for exactly one of its four members.
 * EXECUTIVE belongs (`ROLE_GRANTS.EXECUTIVE = ["PARTICIPANT"]`); JUDGE never did.
 *
 * WHAT THAT ALLOWED, stated plainly, because "a judge is staff" is the intuition that will put it
 * back. A JUDGE is invitation-only, holds no team membership row, and may grant no role — and with
 * one valid token they could POST /v1/notify/registration-invite with any recipient list, any
 * `roleLabel`, an invented `temporaryPassword` and an `actionUrl` of their choosing. The recipient
 * received a correctly branded, SPF/DKIM-signed "your account is ready, sign in here" email from the
 * platform's verified domain. Nothing was injected — the templates escape properly — which is what
 * made it dangerous: a legitimate-looking credential-harvesting mail carrying this platform's sender
 * reputation, and a second-order hit to the SES reputation every other email depends on.
 */
const SENDER_ROLES = new Set(["ADMIN", "FACILITATOR", "EXECUTIVE"]);

/**
 * Cap on how many recipients one call may name.
 *
 * ⚠ THERE WAS NO CAP, and `recipients()` accepts an array of any length. Every legitimate caller
 * sends to ONE address — `/team-invite` and `/registration-invite` are per-invitee (bulk-provision
 * emails invitees one at a time), and `/password-reset` is per-account. The two broadcast-shaped
 * routes (`/workshop-update`, `/release-update`) fan out to a roster the CALLER has already had to be
 * authorized for, so this bounds the request rather than the feature.
 *
 * 50 is above any real roster page and far below a useful spam run. Refused rather than truncated,
 * matching this platform's convention for a bound on a caller-supplied collection: silently dropping
 * recipients would mean somebody is told an email was sent that never was.
 */
const MAX_RECIPIENTS = 50;

/**
 * Origins this service is willing to put behind a button in an email.
 *
 * ⚠ THE THIRD COMPOUNDING FACTOR IN THE SENDER-ROLE FINDING, AND THE ONE THAT MADE IT PHISHING
 * RATHER THAN SPAM. Every route takes `actionUrl` from the request body and renders it into the
 * template's link slot. `safeUrl` only ever asked "is this a URL shape we will link at all" — so any
 * caller who passed the role gate could point the platform's own branded, SPF/DKIM-signed
 * "your account is ready, sign in here" button at a host they controlled.
 *
 * Every legitimate value is the platform's own web app: `bulk-provision` builds
 * `${APP_URL}/join/<token>` and `identity` builds `${PORTAL_URL}/admin?tab=feedback`. So an origin
 * allowlist costs nothing real and closes the redirect.
 *
 * ⚠ IT NOW FAILS CLOSED WHEN UNCONFIGURED, AND THE OPT-OUT IS THE PART TO READ.
 *
 * This used to fail OPEN, deliberately: `APP_URL`/`PORTAL_URL` are set on the CALLING functions and
 * whether they are also set on THIS one is decided by the `infrastructure` repo, which cannot be read
 * from here — so an empty allowlist enforced strictly would refuse every email, PASSWORD RESETS
 * INCLUDED, the first time this deployed with the variable absent. That reasoning was sound about the
 * OUTAGE and wrong about the DEFAULT: it left the phishing vector open in exactly the deployment
 * nobody had checked, and a fail-open control is indistinguishable from an absent one.
 *
 * So the default is now REFUSE, and the outage risk is answered by an explicit escape hatch rather
 * than by weakening the default: set `NOTIFY_ALLOW_UNRESTRICTED_LINKS=true` and the absent case sends
 * again. ⚠ THE POINT OF THE HATCH IS THAT SOMEBODY HAD TO TYPE IT. An operator who hits refused
 * password resets can restore delivery with one variable and no deploy of this code, and the
 * unrestricted state is then a recorded decision instead of a silent default nobody chose.
 *
 * The `https:`-only floor from `safeUrl` applies either way. Set `NOTIFY_ALLOWED_LINK_ORIGINS`
 * (comma-separated) — or `APP_URL`/`PORTAL_URL` on this function — to close it properly, which is
 * what the hatch is a temporary alternative to.
 */
function allowedLinkOrigins(): string[] {
  const raw = [
    process.env.NOTIFY_ALLOWED_LINK_ORIGINS,
    process.env.APP_URL,
    process.env.PORTAL_URL,
  ]
    .filter((v): v is string => !!v && v.trim() !== "")
    .flatMap((v) => v.split(","));

  const origins: string[] = [];
  for (const candidate of raw) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      // Compared as ORIGIN (scheme + host + port), so a configured value carrying a path — which
      // `APP_URL` legitimately might — still matches links built beneath it.
      origins.push(new URL(trimmed).origin);
    } catch {
      console.warn("[notify] ignoring an unparseable allowed-link origin", { value: trimmed });
    }
  }
  return [...new Set(origins)];
}

/**
 * Decide whether a caller-supplied link may be sent. Returns a refusal reason, or null to allow.
 *
 * Read per request rather than once at module load: these Lambdas are long-lived across invocations,
 * and a config change should not need a cold start to take effect.
 */
function rejectActionUrl(actionUrl: unknown): string | null {
  if (typeof actionUrl !== "string" || actionUrl.trim() === "") {
    return "A link is required.";
  }

  let parsed: URL;
  try {
    parsed = new URL(actionUrl.trim());
  } catch {
    return "The link must be an absolute https:// URL.";
  }

  // The floor, enforced here as well as in `safeUrl` so the caller gets a 400 naming the problem
  // rather than an email that silently renders an empty button.
  if (parsed.protocol !== "https:") {
    return "The link must use https://.";
  }

  const allowed = allowedLinkOrigins();
  if (allowed.length === 0) {
    // See the note on `allowedLinkOrigins`. The unconfigured case REFUSES unless an operator has
    // deliberately opted out — the opt-out exists so a link-hardening change cannot become an
    // outage of account recovery that only a code deploy can end.
    if (process.env.NOTIFY_ALLOW_UNRESTRICTED_LINKS === "true") {
      console.warn(
        "[notify] no allowed-link origins configured and NOTIFY_ALLOW_UNRESTRICTED_LINKS is set — " +
          "sending an UNRESTRICTED link. Set NOTIFY_ALLOWED_LINK_ORIGINS and remove the opt-out.",
        { origin: parsed.origin }
      );
      return null;
    }
    // `error`, not `warn`: this refuses real email, so it is an operator action item rather than
    // something to notice in passing.
    console.error(
      "[notify] no allowed-link origins configured — REFUSING the link. Set " +
        "NOTIFY_ALLOWED_LINK_ORIGINS (or APP_URL/PORTAL_URL on this function), or set " +
        "NOTIFY_ALLOW_UNRESTRICTED_LINKS=true to deliberately accept unrestricted links.",
      { origin: parsed.origin }
    );
    return "Links are not configured on this platform.";
  }

  if (!allowed.includes(parsed.origin)) {
    // The rejected origin IS logged: it is the caller's own input, not recipient data, and an operator
    // diagnosing a refused invitation needs to see which host was asked for.
    console.warn("[notify] refused a link outside the allowed origins", {
      origin: parsed.origin,
      allowed,
    });
    return "That link is not on this platform.";
  }

  return null;
}

function canSendEmail(role: string | null | undefined): boolean {
  return !!role && SENDER_ROLES.has(role);
}

/** Normalize the `to` field (accept one address or an array). */
function recipients(body: { to?: unknown }): string[] {
  if (Array.isArray(body?.to)) return body.to.filter((x: unknown) => typeof x === "string");
  if (typeof body?.to === "string" && body.to) return [body.to];
  return [];
}

export function createNotifyRoutes(deps: NotifyDeps) {
  const notify = new Hono().basePath("/v1/notify");

  notify.use("*", edgeIdentityMiddleware());

  // Authorization, as its own middleware rather than a check inside each handler:
  // it runs BEFORE any body parsing or rendering, and a route added later is
  // covered automatically instead of being covered only if someone remembers.
  notify.use("*", async (c, next) => {
    const { id, role } = requireIdentity(c);
    if (!canSendEmail(role)) {
      // Logged because a participant hitting this endpoint at all is worth
      // noticing — the UI never calls it for them.
      console.warn("[notify] refused send for role without permission", {
        userId: id,
        role,
      });
      return c.json({ error: "Forbidden: your role cannot send email" }, 403);
    }

    /**
     * ── ⚠ SEND ACCOUNTING, WHICH THIS SERVICE HAD NONE OF ─────────────────────────────────────
     *
     * SECURITY FINDING (Medium — "Unmetered branded-email relay: /v1/notify/* is
     * gated only by a three-role set… There is no per-user rate limit or send quota anywhere in
     * the service"). The role check above answers WHO may send; nothing answered HOW MUCH. With
     * caller-supplied recipients bounded only by MAX_RECIPIENTS = 50 per call, and
     * caller-authored body text, an EXECUTIVE — the read-only observer — could send unlimited
     * branded, SPF/DKIM-aligned platform mail to arbitrary external addresses.
     *
     * ⚠ THE ROLE SET IS UNCHANGED HERE ON PURPOSE. Whether EXECUTIVE should hold send rights at
     * all is a product decision about what that role means, and it was kept separate rather
     * than folded into a security fix. This bounds the volume for every sender instead, which is
     * the half that needed no product decision.
     *
     * ⚠ IN THE SAME MIDDLEWARE AS THE ROLE CHECK, so it runs BEFORE any body parsing or
     * rendering — the property the portal's limiter header calls "the single most valuable thing
     * it does" — and so a route added later is metered without anyone remembering to meter it.
     *
     * ⚠ AND IT COUNTS CALLS, NOT RECIPIENTS, which is the weaker of the two and stated rather
     * than glossed: one call may name 50 addresses, so a caller's real reach is
     * maxPerWindow × 50. Counting recipients means moving the check after body parsing, which
     * gives up the ordering above, and the bound that matters for reputation is how many SES
     * calls we make. If recipient-weighted accounting is wanted later, `consume` takes a subject
     * and the cost would become a second argument.
     */
    if (deps.quota) {
      const verdict = await deps.quota.consume(id);
      if (!verdict.allowed) {
        console.warn("[notify] send quota exhausted", {
          userId: id,
          role,
          limit: verdict.limit,
        });
        c.header("Retry-After", String(verdict.retryAfterSeconds));
        return c.json(
          {
            error: "Send quota exhausted. Try again later.",
            code: "SEND_QUOTA_EXHAUSTED",
            limit: verdict.limit,
            retryAfterSeconds: verdict.retryAfterSeconds,
          },
          429
        );
      }
    }

    return next();
  });

  /**
   * Shared send path: given the recipients and a rendered {subject, html, text},
   * deliver via the injected transport and shape the response/audit line the same
   * way for every email type.
   */
  async function deliver(
    c: Context,
    kind: string,
    to: string[],
    rendered: Omit<EmailMessage, "to">
  ) {
    const sender = requireIdentity(c);

    /**
     * ⚠ THE RECIPIENT CAP IS ENFORCED HERE, IN THE ONE PLACE EVERY ROUTE PASSES THROUGH, and
     * BEFORE the transport is touched — so an over-sized call sends nothing at all rather than
     * partially. Putting it in `recipients()` was the alternative and is worse: that helper returns a
     * list, so it could only silently truncate, and a caller told "sent" about addresses that were
     * dropped is the failure this platform refuses elsewhere.
     */
    if (to.length > MAX_RECIPIENTS) {
      console.warn("[notify] refused an over-sized recipient list", {
        kind,
        requested: to.length,
        cap: MAX_RECIPIENTS,
        senderId: sender.id,
      });
      return c.json(
        {
          error: `A single email may name at most ${MAX_RECIPIENTS} recipients.`,
          code: "TOO_MANY_RECIPIENTS",
        },
        400
      );
    }

    try {
      const result = await deps.email.send({ to, ...rendered });
      /**
       * ⚠ COUNT AND DOMAINS, NEVER THE ADDRESSES. This logged `to.join(", ")`, writing every
       * recipient address into CloudWatch on every send — the same mistake
       * `workshop-directory.http.ts` documents avoiding ("Counts only, never the rows"). The domain
       * is kept because it is what an operator actually triages on (one tenant's mail failing), and
       * it is not personal data on its own. `temporaryPassword` was never logged and still is not.
       */
      const domains = [...new Set(to.map((a) => a.slice(a.lastIndexOf("@") + 1)))];
      console.log("[notify] sent", {
        kind,
        recipients: to.length,
        domains,
        via: result.via,
        senderId: sender.id,
      });
      return c.json({ sent: to.length, via: result.via, messageId: result.messageId });
    } catch (err) {
      // Structured logging: keep the message a constant and pass dynamic values
      // as discrete fields, so caller-influenced strings can never act as format
      // specifiers in the log line.
      console.error("[notify] email send failed", {
        kind,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to send email" }, 502);
    }
  }

  // Registration invitation (platform-level invite; not tied to a specific team).
  //   { to, actionUrl, roleLabel?, inviterName?, expiryText?, temporaryPassword? }
  //
  // `temporaryPassword` is a LIVE CREDENTIAL for an admin-created account. It is read
  // straight into the template and never logged — deliver() logs the recipients and the
  // kind only, and the ONE audit line in this service is written from those.
  notify.post("/registration-invite", async (c) => {
    const body = await c.req.json();
    const to = recipients(body);
    if (to.length === 0 || !body.actionUrl) {
      return c.json({ error: "to and actionUrl are required" }, 400);
    }
    // ⚠ THE LINK IS CHECKED BEFORE ANYTHING IS RENDERED OR SENT. See `rejectActionUrl`: https-only,
    // and confined to the platform's own origins when they are configured.
    const badLink = rejectActionUrl(body.actionUrl);
    if (badLink) {
      return c.json({ error: badLink, code: "ACTION_URL_NOT_ALLOWED" }, 400);
    }

    const rendered = renderRegistrationInvite({
      actionUrl: body.actionUrl,
      roleLabel: body.roleLabel,
      inviterName: body.inviterName,
      expiryText: body.expiryText,
      // Type-checked rather than passed through: a non-string here (a number, an
      // object) would render as "[object Object]" into the one field the recipient
      // must copy verbatim.
      temporaryPassword:
        typeof body.temporaryPassword === "string" ? body.temporaryPassword : undefined,
    });
    return deliver(c, "registration-invite", to, rendered);
  });

  // Team invitation.
  //   { to, teamName, roleLabel?, inviteUrl|actionUrl, inviterName? }
  notify.post("/team-invite", async (c) => {
    const body = await c.req.json();
    const to = recipients(body);
    // `inviteUrl` kept as an alias for backward-compat with existing callers.
    const actionUrl = body.actionUrl || body.inviteUrl;
    if (to.length === 0 || !body.teamName || !actionUrl) {
      return c.json({ error: "to, teamName, and actionUrl are required" }, 400);
    }
    // ⚠ THE LINK IS CHECKED BEFORE ANYTHING IS RENDERED OR SENT. See `rejectActionUrl`: https-only,
    // and confined to the platform's own origins when they are configured.
    const badLink = rejectActionUrl(actionUrl);
    if (badLink) {
      return c.json({ error: badLink, code: "ACTION_URL_NOT_ALLOWED" }, 400);
    }

    const rendered = renderTeamInvite({
      teamName: body.teamName,
      roleLabel: body.roleLabel || "team member",
      actionUrl,
      inviterName: body.inviterName,
      expiryText: body.expiryText,
      // A LIVE CREDENTIAL, never logged. Type-checked for the same reason as on the
      // registration route: the recipient must copy this verbatim.
      temporaryPassword:
        typeof body.temporaryPassword === "string" ? body.temporaryPassword : undefined,
    });
    return deliver(c, "team-invite", to, rendered);
  });

  // Password reset.
  //   { to, actionUrl, userName?, expiryText? }
  notify.post("/password-reset", async (c) => {
    const body = await c.req.json();
    const to = recipients(body);
    if (to.length === 0 || !body.actionUrl) {
      return c.json({ error: "to and actionUrl are required" }, 400);
    }
    // ⚠ THE LINK IS CHECKED BEFORE ANYTHING IS RENDERED OR SENT. See `rejectActionUrl`: https-only,
    // and confined to the platform's own origins when they are configured.
    const badLink = rejectActionUrl(body.actionUrl);
    if (badLink) {
      return c.json({ error: badLink, code: "ACTION_URL_NOT_ALLOWED" }, 400);
    }

    const rendered = renderPasswordReset({
      actionUrl: body.actionUrl,
      userName: body.userName,
      expiryText: body.expiryText,
    });
    return deliver(c, "password-reset", to, rendered);
  });

  // Release / product update.
  //   { to, headline, intro, version?, highlights?[{title,body?}], actionUrl?, actionLabel? }
  notify.post("/release-update", async (c) => {
    const body = await c.req.json();
    const to = recipients(body);
    if (to.length === 0 || !body.headline || !body.intro) {
      return c.json({ error: "to, headline, and intro are required" }, 400);
    }
    // ⚠ THE LINK IS CHECKED BEFORE ANYTHING IS RENDERED OR SENT — the same guard, and the same
    // position in the handler, as the three invite/reset routes above. This route and
    // `/workshop-update` were the two that never called it, so the allowlist was inert on exactly
    // the two routes whose `actionUrl` is optional, caller-chosen and fanned out to a roster.
    //
    // GUARDED ON PRESENCE, unlike the routes above: `actionUrl` is OPTIONAL on this shape (a release
    // note with no button is legitimate), so an absent link must stay absent rather than become a
    // 400. `rejectActionUrl` refuses an empty/absent value by contract, so the presence check has to
    // live here rather than inside it — the three routes above rely on that refusal.
    if (body.actionUrl !== undefined && body.actionUrl !== null) {
      const badLink = rejectActionUrl(body.actionUrl);
      if (badLink) {
        return c.json({ error: badLink, code: "ACTION_URL_NOT_ALLOWED" }, 400);
      }
    }

    const rendered = renderReleaseUpdate({
      headline: body.headline,
      intro: body.intro,
      version: body.version,
      highlights: Array.isArray(body.highlights) ? body.highlights : undefined,
      actionUrl: body.actionUrl,
      actionLabel: body.actionLabel,
    });
    return deliver(c, "release-update", to, rendered);
  });

  // Workshop update.
  //   { to, headline, body, workshopName?, recipientName?, details?[{label,value}], actionUrl?, actionLabel? }
  notify.post("/workshop-update", async (c) => {
    const body = await c.req.json();
    const to = recipients(body);
    if (to.length === 0 || !body.headline || !body.body) {
      return c.json({ error: "to, headline, and body are required" }, 400);
    }
    // ⚠ THE LINK IS CHECKED BEFORE ANYTHING IS RENDERED OR SENT. See the note on `/release-update`:
    // optional here, so guarded on presence. This is also the route `identity` reaches for feedback
    // notifications with a SYNTHESIZED ADMIN identity (identity/src/notifier.http.ts), which bypasses
    // the sender-role gate entirely — so this check is the only one standing on that path.
    if (body.actionUrl !== undefined && body.actionUrl !== null) {
      const badLink = rejectActionUrl(body.actionUrl);
      if (badLink) {
        return c.json({ error: badLink, code: "ACTION_URL_NOT_ALLOWED" }, 400);
      }
    }

    const rendered = renderWorkshopUpdate({
      headline: body.headline,
      body: body.body,
      workshopName: body.workshopName,
      recipientName: body.recipientName,
      details: Array.isArray(body.details) ? body.details : undefined,
      actionUrl: body.actionUrl,
      actionLabel: body.actionLabel,
    });
    return deliver(c, "workshop-update", to, rendered);
  });

  return notify;
}
