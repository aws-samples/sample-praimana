import type { EmailMessage } from "./domain.js";
import {
  loadTemplate,
  markSafe,
  renderString,
  safeUrl,
  type TemplateContext,
} from "./render.js";

/**
 * Email templates. Each exported `render*` turns SEMANTIC fields (teamName,
 * actionUrl, ...) into a rendered {subject, html, text}. HTML comes from the
 * .html files in `apps/services/notify/templates/` — a shared `layout.html`
 * wraps a per-type content partial — so branding/markup lives as real templates,
 * not string literals. Callers never pass raw HTML: that keeps the API from
 * becoming an open relay and keeps auto-escaping the default (see render.ts).
 */

const PRODUCT_NAME = process.env.EMAIL_PRODUCT_NAME || "Praimana";
// A fixed year avoids Date.now() (and keeps output deterministic); bump as needed
// or wire to an env var if you want it dynamic.
const BRAND_YEAR = process.env.EMAIL_BRAND_YEAR || "2026";

type Rendered = Omit<EmailMessage, "to">;

interface LayoutFields {
  title: string;
  preheader: string;
  content: string; // already-rendered HTML for the content slot
  footerExtra?: string;
}

/** Wrap a rendered content partial in the shared branded layout. */
function wrapLayout(fields: LayoutFields): string {
  return renderString(loadTemplate("layout"), {
    productName: PRODUCT_NAME,
    year: BRAND_YEAR,
    title: fields.title,
    preheader: fields.preheader,
    // content/footerExtra land in the layout's raw {{{ }}} slots. Mark them safe
    // explicitly: both are server-produced HTML (a partial already rendered with
    // per-field escaping, and a trusted footer string). The render guard escapes
    // anything NOT marked safe, so this is the only sanctioned path to raw output.
    footerExtra: markSafe(fields.footerExtra ?? ""),
    content: markSafe(fields.content),
  });
}

/** Render a named content partial, then wrap it in the layout. */
function renderHtml(
  templateName: string,
  data: TemplateContext,
  layout: Omit<LayoutFields, "content">
): string {
  const content = renderString(loadTemplate(templateName), {
    productName: PRODUCT_NAME,
    ...data,
  });
  return wrapLayout({ ...layout, content });
}

function joinText(lines: string[]): string {
  return lines.join("\n");
}

// --- Registration invitation ------------------------------------------------

export interface RegistrationInviteData {
  /** First-sign-in link (the /join/<token> page, which locks the invited email in). */
  actionUrl: string;
  /** e.g. "Facilitator", "Judge". Optional. */
  roleLabel?: string;
  /** Who sent it. Optional. */
  inviterName?: string;
  /**
   * How long the link stays usable ("24 hours"). Same contract as TeamInviteData:
   * omitted means the email makes NO expiry claim, which is better than a wrong
   * one. The window is enforced on the invitation row regardless of what this
   * email says (team/src/invite-token.ts and the Cognito pre-signup trigger).
   */
  expiryText?: string;
  /**
   * ⚠ THE ACCOUNT'S TEMPORARY PASSWORD — A LIVE CREDENTIAL.
   *
   * Self-service sign-up is disabled on the pool, so the account is admin-created
   * BEFORE this email is sent and the recipient's first action is a SIGN-IN, not a
   * registration. This is the only delivery of that password: it is not stored
   * anywhere and cannot be recovered, so a failed send means the invitation must be
   * re-issued rather than resent.
   *
   * Optional so the field's absence degrades honestly: the copy then says nothing
   * about a password at all rather than rendering an empty one, which is the correct
   * behaviour for the (still-supported) case of an invitation to an account that
   * already has a password its owner chose.
   *
   * Never logged. The route below does not include it in any log line, and
   * ConsoleEmailTransport prints the rendered text body — which in local dev is
   * exactly where the operator needs to read it from, and in a deployed environment
   * is never reached because EMAIL_FROM selects the SES transport.
   */
  temporaryPassword?: string;
}

export function renderRegistrationInvite(data: RegistrationInviteData): Rendered {
  const subject = `You're invited to ${PRODUCT_NAME}`;
  // Normalized ONCE so the HTML button and the plain-text link can never disagree
  // about where they point (see safeUrl in render.ts).
  const actionUrl = safeUrl(data.actionUrl);
  const temporaryPassword = data.temporaryPassword || "";
  const html = renderHtml(
    "registration-invite",
    {
      actionUrl,
      roleLabel: data.roleLabel || "",
      inviterName: data.inviterName || "",
      expiryText: data.expiryText || "",
      // Rendered through the template's ESCAPED {{ }} slot like every other field —
      // the generated alphabet contains `&` and `<`-adjacent symbols, and an
      // unescaped one would corrupt the password the recipient copies.
      temporaryPassword,
    },
    {
      title: subject,
      // The preheader is the line shown in an inbox list, so it must NOT contain the
      // password: inbox previews are rendered by mail clients, sync to phones, and are
      // the least controlled place the credential could sit.
      preheader: `Your ${PRODUCT_NAME} account is ready — sign in to finish setting it up.`,
    }
  );
  const who = data.inviterName ? `${data.inviterName} has invited you` : "You've been invited";
  const asRole = data.roleLabel ? ` as a ${data.roleLabel}` : "";
  const text = joinText([
    `${who} to join ${PRODUCT_NAME}${asRole}.`,
    ``,
    // The intro is CONDITIONAL on the password actually being present. Announcing "the
    // temporary password below" and then not printing one is a promise the email breaks,
    // and it leaves the recipient hunting for a credential that was never sent.
    ...introLines(temporaryPassword),
    ``,
    data.expiryText
      ? `Sign in here (this link expires in ${data.expiryText}):`
      : `Sign in here:`,
    actionUrl,
    ...passwordLines(temporaryPassword),
    ``,
    `If you weren't expecting this, you can ignore this email.`,
  ]);
  return { subject, html, text };
}

/**
 * The plain-text intro, which differs by whether a temporary password is being
 * delivered. Shared by both invitation templates so the two cannot drift into saying
 * different things about the same account state.
 */
function introLines(temporaryPassword: string): string[] {
  return temporaryPassword
    ? [
        `An account has been created for you. Sign in with the temporary password below —`,
        `you'll choose your own password and set up two-factor authentication as you go.`,
      ]
    : [
        // No password to deliver: this is an invitation to an account whose owner already
        // has one. Point at the reset flow rather than at a credential we are not sending.
        `An account has been created for you. Sign in below — if you don't know your`,
        `password, use "Forgot password?" on the sign-in page.`,
      ];
}

/**
 * The credential block for the plain-text body, or nothing.
 *
 * Kept as ONE line ("Temporary password: <value>") deliberately: a wrapped password is a
 * mis-transcribed password, and a mis-transcribed password is reported to the user as
 * "incorrect email or password" — an unfalsifiable dead end for someone holding a
 * credential they believe is correct.
 */
function passwordLines(temporaryPassword: string): string[] {
  if (!temporaryPassword) return [];
  return [
    ``,
    `Temporary password: ${temporaryPassword}`,
    ``,
    `You'll be asked to replace it on first sign-in.`,
  ];
}

// --- Team invitation --------------------------------------------------------

export interface TeamInviteData {
  teamName: string;
  /** The role the recipient was invited as, for the copy (e.g. "Judge"). */
  roleLabel?: string;
  /** First-sign-in link (the /join/<token> page, which locks the invited email in). */
  actionUrl: string;
  /** Who sent it, for the "invited you" line. Optional. */
  inviterName?: string;
  /**
   * How long the link stays usable ("24 hours"), for the urgency line. Omitted
   * when the caller doesn't send one, in which case the email makes no expiry
   * claim at all — better silent than wrong.
   */
  expiryText?: string;
  /**
   * ⚠ THE ACCOUNT'S TEMPORARY PASSWORD — A LIVE CREDENTIAL. Same contract as
   * RegistrationInviteData.temporaryPassword; see the note there.
   *
   * Carried on BOTH templates because a PARTICIPANT is invited team-scoped and so
   * receives this one — omitting it here would have left the majority of invitees with
   * a link and no credential, which is the exact dead end the platform-scoped path
   * avoids.
   */
  temporaryPassword?: string;
}

export function renderTeamInvite(data: TeamInviteData): Rendered {
  const subject = `You're invited to join ${data.teamName} on ${PRODUCT_NAME}`;
  const actionUrl = safeUrl(data.actionUrl);
  const temporaryPassword = data.temporaryPassword || "";
  const html = renderHtml(
    "team-invite",
    {
      teamName: data.teamName,
      roleLabel: data.roleLabel || "",
      actionUrl,
      inviterName: data.inviterName || "",
      expiryText: data.expiryText || "",
      temporaryPassword,
    },
    {
      title: subject,
      // No password in the preheader — that line is rendered in inbox previews. See
      // renderRegistrationInvite.
      preheader: `Join "${data.teamName}"${data.roleLabel ? ` as a ${data.roleLabel}` : ""} on ${PRODUCT_NAME}.`,
    }
  );
  const who = data.inviterName ? `${data.inviterName} invited you` : "You've been invited";
  const asRole = data.roleLabel ? ` as a ${data.roleLabel}` : "";
  const text = joinText([
    `${who} to join the team "${data.teamName}"${asRole} on ${PRODUCT_NAME}.`,
    ``,
    ...introLines(temporaryPassword),
    ``,
    data.expiryText
      ? `Sign in here (this link expires in ${data.expiryText}):`
      : `Sign in here:`,
    actionUrl,
    ...passwordLines(temporaryPassword),
    ``,
    `If you weren't expecting this, you can ignore this email.`,
  ]);
  return { subject, html, text };
}

// --- Password reset ---------------------------------------------------------

export interface PasswordResetData {
  actionUrl: string;
  userName?: string;
  /** Human expiry text, e.g. "30 minutes", "1 hour". Defaults to "1 hour". */
  expiryText?: string;
}

export function renderPasswordReset(data: PasswordResetData): Rendered {
  const expiry = data.expiryText || "1 hour";
  const subject = `Reset your ${PRODUCT_NAME} password`;
  const actionUrl = safeUrl(data.actionUrl);
  const html = renderHtml(
    "password-reset",
    {
      actionUrl,
      userName: data.userName || "",
      expiryText: expiry,
    },
    {
      title: subject,
      preheader: `Reset your password — this link expires in ${expiry}.`,
    }
  );
  const hi = data.userName ? `Hi ${data.userName},\n\n` : "";
  const text = joinText([
    `${hi}We received a request to reset your ${PRODUCT_NAME} password.`,
    ``,
    `Reset it here (expires in ${expiry}):`,
    actionUrl,
    ``,
    `Didn't request this? You can ignore this email — your password won't change.`,
  ]);
  return { subject, html, text };
}

// --- Release update ---------------------------------------------------------

export interface ReleaseHighlight {
  title: string;
  body?: string;
}

export interface ReleaseUpdateData {
  headline: string;
  intro: string;
  version?: string;
  highlights?: ReleaseHighlight[];
  actionUrl?: string;
  actionLabel?: string;
}

export function renderReleaseUpdate(data: ReleaseUpdateData): Rendered {
  const highlights = data.highlights ?? [];
  // Rejected URLs normalize to "", which ALSO collapses the template's
  // {{#actionUrl}} section — so an unsafe link yields no button at all rather
  // than a dead one.
  const actionUrl = safeUrl(data.actionUrl);
  const subject = data.version
    ? `${PRODUCT_NAME} ${data.version} — ${data.headline}`
    : `${PRODUCT_NAME} — ${data.headline}`;
  const html = renderHtml(
    "release-update",
    {
      headline: data.headline,
      intro: data.intro,
      version: data.version || "",
      hasHighlights: highlights.length > 0,
      highlights: highlights.map((h) => ({ title: h.title, body: h.body || "" })),
      actionUrl,
      actionLabel: data.actionLabel || "See what's new",
    },
    {
      title: subject,
      preheader: data.intro,
    }
  );
  const lines = [
    data.version ? `${PRODUCT_NAME} ${data.version}` : `${PRODUCT_NAME}`,
    data.headline,
    ``,
    data.intro,
  ];
  if (highlights.length > 0) {
    lines.push("");
    for (const h of highlights) {
      lines.push(h.body ? `- ${h.title}: ${h.body}` : `- ${h.title}`);
    }
  }
  if (actionUrl) {
    lines.push("", `${data.actionLabel || "See what's new"}: ${actionUrl}`);
  }
  return { subject, html, text: joinText(lines) };
}

// --- Workshop update --------------------------------------------------------

export interface WorkshopDetail {
  label: string;
  value: string;
}

export interface WorkshopUpdateData {
  headline: string;
  body: string;
  workshopName?: string;
  recipientName?: string;
  details?: WorkshopDetail[];
  actionUrl?: string;
  actionLabel?: string;
}

export function renderWorkshopUpdate(data: WorkshopUpdateData): Rendered {
  const details = data.details ?? [];
  const actionUrl = safeUrl(data.actionUrl);
  const subject = data.workshopName
    ? `${data.workshopName}: ${data.headline}`
    : data.headline;
  const html = renderHtml(
    "workshop-update",
    {
      headline: data.headline,
      body: data.body,
      workshopName: data.workshopName || "",
      recipientName: data.recipientName || "",
      hasDetails: details.length > 0,
      details: details.map((d) => ({ label: d.label, value: d.value })),
      actionUrl,
      actionLabel: data.actionLabel || "Open workshop",
    },
    {
      title: subject,
      preheader: data.body.slice(0, 140),
    }
  );
  const lines = [
    data.workshopName ? `${data.workshopName} — ${data.headline}` : data.headline,
    ``,
    data.body,
  ];
  if (details.length > 0) {
    lines.push("");
    for (const d of details) lines.push(`${d.label}: ${d.value}`);
  }
  if (actionUrl) {
    lines.push("", `${data.actionLabel || "Open workshop"}: ${actionUrl}`);
  }
  return { subject, html, text: joinText(lines) };
}
