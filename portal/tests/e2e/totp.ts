import { createHmac } from "node:crypto";

/**
 * RFC 6238 TOTP, so a browser test can answer the pool's MFA challenge as a person would.
 *
 * ── WHY THIS EXISTS RATHER THAN MFA BEING SWITCHED OFF FOR TESTS ──
 * The pool is `MfaConfiguration: ON`, so `AuthFlow` continues into a TOTP challenge on
 * every sign-in — there is no password-only path to authenticate past. The obvious
 * shortcut is to disable MFA on the pool while the suite runs, and it is the wrong one on
 * three counts:
 *
 *   1. `.env` points local dev at the REAL user pool. Disabling MFA there is
 *      a change to the pool serving actual accounts, not to a fixture.
 *   2. Re-enabling it forces TOTP RE-ENROLMENT on every account's next sign-in, because
 *      Cognito issues MFA_SETUP when MFA is required and no factor is registered. That is
 *      the same step that turns a leaked temporary password into a full account takeover
 *      (the attacker enrols their own authenticator), so it is not a state to create
 *      casually.
 *   3. A suite that only passes with the safety mechanism removed has not tested the
 *      journey users take. The TOTP challenge is part of the login flow; skipping it means
 *      never exercising it.
 *
 * A TOTP code is a pure function of (shared secret, current time), so knowing a test
 * account's enrolment secret is enough to compute a valid one. That tests the real flow.
 *
 * ── NO DEPENDENCY ──
 * `otplib` would do this, but it is ~6 lines against `node:crypto` and adding a package to
 * the root manifest for a test helper is a worse trade than owning the arithmetic.
 *
 * ── THE SECRET IS NOT A PRODUCTION CREDENTIAL, AND MUST NOT BECOME ONE ──
 * It is supplied through the environment (never committed) and must belong to a
 * PURPOSE-MADE test account with no privileges beyond what a spec exercises. Do not point
 * this at a real operator's authenticator: it would put a permanent second factor for a
 * human's account into CI configuration.
 */

/** Base32 alphabet, RFC 4648. Cognito hands the enrolment secret out in this encoding. */
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decode a base32 secret to bytes.
 *
 * Tolerant of the shapes a secret arrives in when a person copies it out of an
 * authenticator app or a QR URI: lowercase, `=` padding, and the spaces those apps insert
 * every four characters. A secret that fails to decode would otherwise surface as "invalid
 * code", sending the reader looking for a clock-skew problem that is really a typo.
 */
export function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) {
      throw new Error(
        `TOTP secret contains a character that is not base32: ${JSON.stringify(char)}`
      );
    }
    value = (value << 5) | index;
    bits += 5;
    // Emit a byte as soon as 8 bits have accumulated; the remainder carries forward.
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }

  if (out.length === 0) throw new Error("TOTP secret decoded to zero bytes");
  return Buffer.from(out);
}

/** Seconds per code. 30 is the RFC default and what Cognito expects. */
export const TOTP_PERIOD_SECONDS = 30;

/**
 * The 6-digit code for `secret` at `atMs`.
 *
 * `atMs` is a parameter rather than an internal `Date.now()` so a unit test can pin it to
 * the RFC's published vectors — a generator verified only against itself is a generator
 * that agrees with its own bugs.
 */
export function totp(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);

  // The counter is a 64-bit big-endian integer. Written as two 32-bit halves because
  // `writeUInt32BE` is exact, whereas shifting a JS number past 32 bits is not.
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  message.writeUInt32BE(counter % 0x100000000, 4);

  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();

  // Dynamic truncation (RFC 4226 §5.4): the low nibble of the last byte picks the offset,
  // and the high bit of the selected word is masked off so the result is always positive.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(binary % 1_000_000).padStart(6, "0");
}

/** Milliseconds until the current code expires. */
export function msUntilNextCode(atMs: number = Date.now()): number {
  const periodMs = TOTP_PERIOD_SECONDS * 1000;
  return periodMs - (atMs % periodMs);
}

/**
 * A code with enough life left to be typed, submitted and validated.
 *
 * THE FLAKE THIS PREVENTS. A code generated 200ms before its window closes is valid when
 * computed and expired by the time Cognito checks it — an authentication failure that
 * reproduces a few times an hour and looks like a broken selector or a bad password.
 * Waiting for the next window costs at most `TOTP_PERIOD_SECONDS` and removes the whole
 * class of failure.
 *
 * Returns the code and how long was spent waiting, so a caller can log the pause rather
 * than appear to hang.
 */
export async function freshTotp(
  secret: string,
  minimumValidityMs = 5_000
): Promise<{ code: string; waitedMs: number }> {
  const remaining = msUntilNextCode();
  let waitedMs = 0;

  if (remaining < minimumValidityMs) {
    // +250ms so the wait lands inside the next window rather than exactly on its boundary,
    // where a rounding difference between this clock and Cognito's could still straddle it.
    waitedMs = remaining + 250;
    await new Promise((resolve) => setTimeout(resolve, waitedMs));
  }

  return { code: totp(secret), waitedMs };
}
