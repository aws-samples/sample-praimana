import { randomBytes } from "node:crypto";

/**
 * ── THE TEAM JOIN CODE ─────────────────────────────────────────────────────────────────────
 *
 * The code was `ulid().slice(0, 8).toUpperCase()`, and that expression
 * contains NO RANDOMNESS AT ALL. A ULID's first 10 Crockford-base32 characters encode its
 * 48-bit millisecond timestamp; taking the first 8 keeps the high 40 bits of the clock and
 * discards the 80-bit random tail entirely. So the code was a pure function of the creation
 * time at ~256 ms granularity (2^8 ms, the resolution the dropped 8 bits carried).
 *
 * TWO CONSEQUENCES, AND THE SECOND IS THE ONE THAT BITES:
 *
 *   PREDICTABILITY — anyone who knows roughly when a team was created can enumerate a handful
 *     of candidate codes. Bounded in practice, because guessing a code grants nothing on its
 *     own: POST /teams/join additionally requires a live, unspent invitation row for the
 *     caller's OWN verified email on that team, and staff/platform roles are refused a
 *     membership row outright. So this half was a weakened semi-secret, not an access path.
 *
 *   COLLISIONS — ⚠ THE REAL DEFECT. Two teams created inside the same 256 ms window receive
 *     the IDENTICAL code, and bulk provisioning creates up to BULK_MAX_TEAMS (20) teams per
 *     upload in one Lambda invocation. Those creations are milliseconds apart, so duplicate
 *     codes were not a birthday-paradox tail risk — they were the EXPECTED outcome of the
 *     platform's own bulk path. `getByInviteCode` then queried the GSI with `Limit: 1` and
 *     returned whichever item DynamoDB happened to surface, so a legitimate joiner could be
 *     resolved to a team they were never invited to and refused with a message about an
 *     invitation that exists on their real team.
 *
 * ── THE ALPHABET ──
 *
 * Crockford base32 WITHOUT I, L, O and U. The first three are excluded because this value is
 * read off a screen and typed, often dictated, and I/1, L/1 and O/0 are the classic
 * transcription failures; U is excluded by Crockford to avoid accidental obscenities. 32
 * symbols is exactly 5 bits, which is what makes the unbiased mapping below possible.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Characters in a generated code. 8 × 5 bits = 40 bits of entropy.
 *
 * Chosen to keep the code the same LENGTH and shape as the value it replaces — it is rendered
 * in the portal, printed on workshop handouts and dictated aloud, so growing it has a real
 * cost — while making every one of those characters carry entropy, which none of them did
 * before. 40 bits puts the collision probability across 10,000 teams at roughly 4.5e-5 by the
 * birthday bound, against a NEAR-CERTAINTY for any two teams created in the same bulk upload.
 */
const CODE_LENGTH = 8;

/**
 * A fresh join code, from the CSPRNG.
 *
 * ⚠ `randomBytes`, NEVER `Math.random()` and never a time-derived value. The whole finding was
 * a code that looked random and was not.
 *
 * ⚠ `byte & 31` IS UNBIASED HERE, and it is worth stating why rather than leaving it as a
 * clever line: 256 is an exact multiple of 32, so each of the 32 symbols is produced by
 * exactly 8 of the 256 possible byte values. The modulo bias that makes `% n` wrong for a
 * general alphabet does not arise for a power-of-two alphabet that divides 256. If anybody
 * ever edits ALPHABET to a length that is not 32, this mapping becomes biased — hence the
 * assertion below, which fails loudly at module load rather than silently skewing codes.
 */
export function generateInviteCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) {
    code += ALPHABET[byte & 31];
  }
  return code;
}

/**
 * A self-check on the invariant the unbiased mapping depends on. Module scope, so a bad edit
 * to ALPHABET fails at import rather than producing skewed codes in production for weeks.
 */
if (ALPHABET.length !== 32) {
  throw new Error(
    `[team] invite-code ALPHABET must be exactly 32 symbols for an unbiased 5-bit mapping, got ${ALPHABET.length}`
  );
}

/**
 * More than one team carries the looked-up join code.
 *
 * ⚠ RAISED INSTEAD OF PICKING ONE. `getByInviteCode` queried the `inviteCode-index` GSI with
 * `Limit: 1`, so on a duplicate it returned whichever item DynamoDB surfaced first — silently
 * resolving a joiner to a team they were never invited to, and then refusing them with a
 * message about a missing invitation that exists perfectly well on their real team. An
 * ambiguous authorization-adjacent lookup has no correct arbitrary answer.
 *
 * ⚠ LEGACY ROWS CAN STILL TRIGGER THIS, and that is the honest trade rather than an oversight.
 * Teams created before the generator was fixed may already share a code, and for those the join
 * path now FAILS LOUDLY where it previously succeeded about half the time — on the wrong team.
 * A clear refusal plus an operator log beats a coin-flip that lands someone in a rival team, and
 * the remedy (re-issue the affected teams' codes) is visible instead of silent.
 */
export class AmbiguousInviteCodeError extends Error {
  constructor(readonly inviteCode: string, readonly matches: number) {
    super(
      `[team] join code resolves to ${matches} teams — refusing to guess which one was meant`
    );
    this.name = "AmbiguousInviteCodeError";
  }
}

/** True if `code` could have been produced by `generateInviteCode`. */
export function isWellFormedInviteCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) {
    if (!ALPHABET.includes(ch)) return false;
  }
  return true;
}

/**
 * How many times team creation will re-draw a code that is already in use.
 *
 * ⚠ THIS IS A NARROWING, NOT MUTUAL EXCLUSION, and the distinction is deliberately not
 * papered over. The check is a read (`getByInviteCode`) followed by a write, so two concurrent
 * creations that draw the same code can both observe it free and both write it. Closing that
 * properly needs a uniqueness ITEM written in the same `TransactWriteItems` as the team row —
 * a real change to the store's shape, to the team-deletion path that would have to clean the
 * item up, and to this repository's contract.
 *
 * NOT TAKEN HERE, on purpose: with 40 bits from a CSPRNG the race requires two creations to
 * draw the same 1-in-a-trillion value within the same few milliseconds, whereas the defect
 * this change exists to fix made a collision the EXPECTED result of an ordinary bulk upload.
 * The retry removes the observable-and-recoverable case; the residual is a genuine
 * birthday-bound tail. `getByInviteCode` now REFUSES an ambiguous lookup rather than picking
 * an arbitrary team, so even the residual fails safe instead of resolving someone to the wrong
 * team. Flagged for a follow-up rather than left implicit.
 *
 * 3 attempts because each is a GSI query on the join path's own index: with a collision
 * probability of ~1e-8 per draw at today's scale, three draws is already far past the point
 * where the retry is the thing that fails.
 */
export const MAX_INVITE_CODE_ATTEMPTS = 3;
