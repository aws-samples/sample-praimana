// ── WHERE AN INVITE LINK POINTS ──────────────────────────────────────────────────────────
//
// ⚠ ONE DEFINITION, because there were briefly two and the second one was wrong.
//
// `/api/invite` derived this correctly, `NEXT_PUBLIC_APP_URL || NEXTAUTH_URL || localhost` with the
// token encoded. The bulk path interpolated `process.env.NEXT_PUBLIC_APP_URL ?? ""` inline, which is
// broken in two ways that only show up in a recipient's inbox:
//
//   1. NO FALLBACK. An unset var yields "/join/<token>", a RELATIVE url, in an EMAIL. Unclickable,
//      and it fails silently at the only moment that matters.
//   2. NO ENCODING of the token.
//
// ⚠ AND IT WOULD HAVE BURNED EIGHTEEN REAL INVITATIONS. Run from a dev machine, `.env` sets
// NEXT_PUBLIC_APP_URL=http://localhost:3001, so every link would have pointed at localhost, useless
// to the recipient, and each token is single-use, so recovering means revoking and re-inviting all of
// them. Caught before the first live upload; the fix is to have one function rather than to remember.

/**
 * The app origin an invite link should use.
 *
 * The fallback chain matters more than it looks: `NEXTAUTH_URL` is always set wherever auth works, so
 * it is a truthful second choice, and the localhost default keeps local development honest instead of
 * producing a relative link.
 */
export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3001";

/** The `/join/<token>` link for an invitation. Token encoded, it is opaque input. */
export function buildInviteUrl(token: string): string {
  return `${APP_URL}/join/${encodeURIComponent(token)}`;
}

/**
 * True when the link would point at a local dev server.
 *
 * ⚠ THE POINT IS TO REFUSE, NOT TO WARN. A bulk run from a dev machine sends REAL email to REAL
 * addresses with links nobody else can open, and each token is single-use. Callers use this to stop
 * before sending rather than to log something nobody reads.
 */
export function isLocalAppUrl(): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(APP_URL);
}
