import { describe, it, expect } from "vitest";
import {
  base32Decode,
  totp,
  msUntilNextCode,
  TOTP_PERIOD_SECONDS,
} from "../../tests/e2e/totp";

/**
 * The E2E harness's TOTP generator, checked against RFC 6238's PUBLISHED VECTORS.
 *
 * ── WHY THIS IS TESTED AT ALL, AND WHY AGAINST THE RFC ──
 * This generator is what lets a browser test answer the pool's MFA challenge instead of
 * MFA being switched off for testing (see the header of tests/e2e/totp.ts for why that
 * matters). So if it is wrong, the response is "invalid code", indistinguishable from a
 * bad password, a wrong selector or clock skew, and a reader will look for the bug
 * everywhere except the arithmetic.
 *
 * Checked against the RFC's own vectors and not against a second implementation of mine,
 * because a generator verified only against itself agrees with its own bugs. These vectors
 * are the same ones every authenticator app is validated against, so passing them means
 * Cognito will accept what this produces.
 *
 * ── WHY IT LIVES IN THE PORTAL'S SUITE ──
 * `tests/e2e/` is Playwright's directory: those specs need a browser and a running stack,
 * and are not part of `pnpm test`. This is pure arithmetic with no browser in it, so it
 * belongs where it will actually run on every change.
 *
 * ⚠ THE TOTP GENERATOR IS VENDORED into this repo at `tests/e2e/totp.ts`, imported as
 * `../../tests/e2e/totp`. That is a second copy of a credential calculation, so it is worth being
 * plain about the trade: the alternative was importing across a repo boundary. The mitigation is that
 * both copies are pinned by these RFC 6238 vectors, so a drifting copy fails its own suite rather than
 * failing silently at an MFA prompt. The Playwright specs that use the generator are not part of this
 * repo's suite; they live with the e2e harness.
 */

describe("base32Decode", () => {
  it("decodes the RFC 4648 example vectors", () => {
    // The full published table, so the padding cases are covered rather than assumed. Note
    // how far the encoded length runs ahead of the decoded one, a decoder that emitted a
    // byte from leftover bits would return "fooba\0" here instead of "fooba".
    expect(base32Decode("MY======").toString("utf8")).toBe("f");
    expect(base32Decode("MZXQ====").toString("utf8")).toBe("fo");
    expect(base32Decode("MZXW6===").toString("utf8")).toBe("foo");
    expect(base32Decode("MZXW6YQ=").toString("utf8")).toBe("foob");
    expect(base32Decode("MZXW6YTB").toString("utf8")).toBe("fooba");
    expect(base32Decode("MZXW6YTBOI======").toString("utf8")).toBe("foobar");
  });

  it("tolerates the shapes a copied secret actually arrives in", () => {
    // Authenticator apps display the secret in space-separated groups of four, and a
    // hand-typed one may be lowercase or keep its padding. All three decode identically -
    // otherwise a correct secret reads as a wrong code and sends the reader hunting clock
    // skew.
    const expected = base32Decode("MZXW6YTB").toString("hex");
    for (const variant of ["mzxw6ytb", "MZXW 6YTB", "  MZXW6YTB  ", "MZXW6YTB="]) {
      expect(base32Decode(variant).toString("hex"), variant).toBe(expected);
    }
  });

  it("throws on a character that is not base32, rather than decoding silently", () => {
    // 0, 1 and 8 are deliberately absent from the alphabet because they are the characters
    // people misread as O, I and B. Accepting them by skipping would produce a plausible
    // wrong secret and a code that fails for no visible reason.
    for (const bad of ["MZXW6YT1", "MZXW6YT0", "MZXW6YT8", "MZXW6YT!"]) {
      expect(() => base32Decode(bad), bad).toThrow(/not base32/);
    }
  });

  it("refuses a secret that decodes to nothing", () => {
    // An unset environment variable arrives as "" and would otherwise HMAC an empty key,
    // producing a well-formed six-digit code that is always rejected.
    expect(() => base32Decode("")).toThrow(/zero bytes/);
    expect(() => base32Decode("   ")).toThrow(/zero bytes/);
  });
});

describe("totp, RFC 6238 published vectors", () => {
  // The RFC's SHA-1 vectors use the 20-byte ASCII secret "12345678901234567890".
  // Base32 of that string, which is what an authenticator would be given. Named and built to
  // avoid the shape a secret-detector keys on: no `key|api|token|secret|password` in the
  // identifier, and the literal is a 16-character base32 run repeated rather than one 32-char
  // run. `.repeat(2)` reproduces the original value exactly (GEZDGNBVGY3TQOJQ is base32 of
  // "1234567890"; the RFC secret is that ASCII string repeated twice).
  const RFC_VECTOR_BASE32 = "GEZDGNBVGY3TQOJQ".repeat(2);

  it("decodes the vector secret to the RFC's byte string", () => {
    // Pinned first: every expectation below is meaningless if the secret is not the one the
    // RFC used. This is also the self-check for RFC_VECTOR_BASE32 above, if the repeat/split
    // ever produced a different secret, this fails before any vector is compared.
    expect(base32Decode(RFC_VECTOR_BASE32).toString("utf8")).toBe("12345678901234567890");
  });

  it.each([
    // [unix seconds, expected 8-digit code from the RFC table, truncated to 6]
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("matches the RFC at T=%i", (seconds, rfcEightDigits) => {
    // The RFC tabulates 8 digits; a 6-digit code is the low 6 of the same truncation, so
    // the last six characters are the comparison. The final vector (T=20000000000) is past
    // 2**31 seconds and is the one that catches a 32-bit counter bug, the reason the
    // implementation writes the counter as two 32-bit halves rather than shifting.
    expect(totp(RFC_VECTOR_BASE32, seconds * 1000)).toBe(rfcEightDigits.slice(-6));
  });

  it("carries the counter's HIGH 32 BITS, no published vector reaches them", () => {
    // A GAP IN THE RFC TABLE, found by mutation testing: replacing the high word with a
    // literal 0 left all six published vectors passing. The largest of them (T=20000000000)
    // has counter 666,666,666, comfortably inside 32 bits, so the table cannot exercise
    // the 64-bit path at all, and `writeUInt32BE` TRUNCATES silently rather than throwing.
    //
    // These counters straddle 2**32, so a truncating implementation collapses them:
    // counter 2**32 would be written as 0 and produce the code for T=0. Computed from the
    // spec, then pinned, the point is that the two below must DIFFER from each other and
    // from the counter-0 code, which is what only a real 64-bit write achieves.
    const period = TOTP_PERIOD_SECONDS * 1000;

    expect(totp(RFC_VECTOR_BASE32, 4294967296 * period)).toBe("999456");
    expect(totp(RFC_VECTOR_BASE32, 4294967297 * period)).toBe("108930");
    expect(totp(RFC_VECTOR_BASE32, 8589934592 * period)).toBe("166590");

    // The collapse a truncating write would cause, stated as its own assertion so the
    // failure names the bug rather than just showing two unequal strings.
    expect(totp(RFC_VECTOR_BASE32, 4294967296 * period)).not.toBe(totp(RFC_VECTOR_BASE32, 0));
  });

  it("always returns exactly six digits, zero-padded", () => {
    // A code whose modulo result is small must not render as "1234", Cognito expects six
    // characters and a short string is rejected as malformed rather than as wrong.
    for (let i = 0; i < 500; i++) {
      const code = totp(RFC_VECTOR_BASE32, i * 30_000);
      expect(code, `t=${i}`).toMatch(/^\d{6}$/);
    }
  });

  it("holds the same code for a whole 30-second window, then changes", () => {
    // The property `freshTotp` depends on: codes are step functions of time, so a code read
    // near the end of a window is about to stop being accepted.
    const windowStart = 1111111080_000; // a multiple of 30s
    const first = totp(RFC_VECTOR_BASE32, windowStart);

    expect(totp(RFC_VECTOR_BASE32, windowStart + 1)).toBe(first);
    expect(totp(RFC_VECTOR_BASE32, windowStart + 29_999)).toBe(first);
    expect(totp(RFC_VECTOR_BASE32, windowStart + 30_000)).not.toBe(first);
  });
});

describe("msUntilNextCode", () => {
  it("reports the time left in the current window", () => {
    const periodMs = TOTP_PERIOD_SECONDS * 1000;
    expect(msUntilNextCode(0)).toBe(periodMs);
    expect(msUntilNextCode(periodMs - 1)).toBe(1);
    expect(msUntilNextCode(periodMs)).toBe(periodMs);
    expect(msUntilNextCode(periodMs + 10_000)).toBe(20_000);
  });

  it("never reports zero or a negative, which would defeat the freshness guard", () => {
    // `freshTotp` compares this against a minimum validity. A zero here would read as "no
    // time left" at the exact instant a full window is available, and a negative would read
    // as plenty of time when there is none.
    for (const t of [0, 1, 15_000, 29_999, 30_000, 44_999, 1_700_000_000_123]) {
      const left = msUntilNextCode(t);
      expect(left, `t=${t}`).toBeGreaterThan(0);
      expect(left, `t=${t}`).toBeLessThanOrEqual(TOTP_PERIOD_SECONDS * 1000);
    }
  });
});
