import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Invite-link tokens — the unguessable secret in the emailed registration link.
 *
 * WHY A TOKEN AT ALL, given the signup gate is keyed on EMAIL?
 * The Cognito Hosted UI does NOT forward arbitrary query parameters to the
 * pre-signup trigger (`validationData` is only populated by the SignUp/
 * AdminCreateUser SDK calls, never by the Hosted UI). So this token can NOT be
 * the thing that admits a sign-up — the trigger only ever sees the email.
 *
 * What the token DOES buy us:
 *   1. The invite URL is unguessable, so it can't be forged from a known address.
 *   2. The /join page can tell the recipient "this invite expired" instead of
 *      dumping them at a Hosted UI form that fails for reasons they can't see.
 *   3. Possession of the token is enough to read back the invited email, which is
 *      how /join prefills the Hosted UI without accepting an email from the URL.
 *
 * The AUTHORITATIVE expiry check therefore lives on the invitation ROW and is
 * enforced by the pre-signup trigger (see isExpired below and the trigger's own
 * mirrored copy) — otherwise skipping the link and going straight to the Hosted
 * UI would bypass expiry entirely.
 *
 * Only the HASH is stored. A dump of the invitations table yields no usable
 * links, exactly as with a password digest. The raw token exists only in the
 * email we send and in the create-invitation response that builds it.
 */

/** Hours an invite link stays usable. Overridable for tests/ops, default 24h. */
export const INVITE_TTL_HOURS = Number(process.env.INVITE_TTL_HOURS || 24);

/**
 * A fresh invite secret: the raw token (emailed, never stored) and the SHA-256
 * hash (stored, indexed by tokenHash-index).
 *
 * 32 random bytes = 256 bits, base64url so it survives a URL path segment
 * untouched. At that entropy the lookup route can be unauthenticated: guessing a
 * token is not a threat model, so no rate limiting is load-bearing here.
 *
 * A plain SHA-256 (not a slow KDF) is right for this input: unlike a password it
 * is full-entropy and machine-generated, so there is nothing for an offline
 * attacker to brute-force.
 */
export function mintInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInviteToken(token) };
}

/** SHA-256 hex of a raw token — the form stored and queried. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time compare of two token hashes. Both are fixed-length hex, so a
 * length mismatch means malformed input rather than a near-miss guess.
 */
export function tokenHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** ISO-8601 expiry, INVITE_TTL_HOURS from `from` (default: now). */
export function inviteExpiry(from: Date = new Date()): string {
  return new Date(from.getTime() + INVITE_TTL_HOURS * 3600_000).toISOString();
}

/**
 * True when an invitation's link has lapsed.
 *
 * A MISSING expiresAt counts as NOT expired. Every invitation minted from here on
 * carries one; the invitations that predate this field (including the bootstrap
 * admin row) would otherwise become permanently un-redeemable, which is the same
 * backward-compatibility stance `platformRole`/`teamRole` already take in
 * domain.ts. An unparseable value IS treated as expired — that's corruption, and
 * corruption should fail closed.
 *
 * NOTE the type: `expiresAt` is deliberately an ISO STRING, not the epoch NUMBER
 * that the sessions/verification-tokens tables use for the same attribute name.
 * Those two have DynamoDB TTL enabled; this table must NOT, because an
 * invitation row is also the ACCEPTED/audit record behind /invitations/mine.
 * Keeping it a String means enabling TTL here later could not silently start
 * deleting that history (TTL ignores non-Number attributes).
 */
export function isExpired(
  expiresAt: string | undefined,
  now: Date = new Date()
): boolean {
  if (!expiresAt) return false;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return true;
  return at <= now.getTime();
}
