import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  hashInviteToken,
  inviteExpiry,
  isExpired,
  mintInviteToken,
  tokenHashEquals,
  INVITE_TTL_HOURS,
} from "./invite-token.js";

describe("mintInviteToken", () => {
  it("returns a token whose stored form is its SHA-256, never the token itself", () => {
    // The whole point of the design: a dump of the invitations table must yield no
    // usable links. If a refactor ever stored the raw token in tokenHash, this
    // assertion is what catches it.
    const { token, tokenHash } = mintInviteToken();
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mints 256 bits of entropy, base64url so it survives a URL path segment", () => {
    const { token } = mintInviteToken();
    // 32 raw bytes → 43 base64url chars (unpadded). base64url means no +, / or =,
    // which is what lets the token sit in a link without encoding.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("never repeats a token across mints", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => mintInviteToken().token));
    expect(tokens.size).toBe(200);
  });
});

describe("tokenHashEquals", () => {
  it("matches identical hashes and rejects a different one of the same length", () => {
    const a = hashInviteToken("alpha");
    const b = hashInviteToken("beta");
    expect(tokenHashEquals(a, a)).toBe(true);
    expect(tokenHashEquals(a, b)).toBe(false);
  });

  it("returns false instead of throwing on a length mismatch", () => {
    // node's timingSafeEqual THROWS on unequal buffer lengths, so the length guard
    // is load-bearing: without it, malformed input turns a comparison into a 500.
    expect(() => tokenHashEquals(hashInviteToken("alpha"), "short")).not.toThrow();
    expect(tokenHashEquals(hashInviteToken("alpha"), "short")).toBe(false);
    expect(tokenHashEquals("", "")).toBe(true);
  });
});

describe("inviteExpiry", () => {
  it("is INVITE_TTL_HOURS after the given instant, as an ISO string", () => {
    const from = new Date("2026-07-31T10:00:00.000Z");
    const expiry = inviteExpiry(from);
    expect(Date.parse(expiry) - from.getTime()).toBe(INVITE_TTL_HOURS * 3600_000);
    // ISO-8601, NOT an epoch number. That type choice is deliberate (see the note
    // in invite-token.ts): DynamoDB TTL ignores non-Number attributes, so if TTL is
    // ever enabled on the invitations table it cannot silently start deleting the
    // ACCEPTED/audit rows behind /invitations/mine.
    expect(expiry).toBe(new Date(Date.parse(expiry)).toISOString());
    expect(typeof expiry).toBe("string");
  });
});

describe("isExpired", () => {
  const now = new Date("2026-07-31T12:00:00.000Z");

  it("treats a past instant as expired and a future one as live", () => {
    expect(isExpired("2026-07-31T11:59:59.000Z", now)).toBe(true);
    expect(isExpired("2026-07-31T12:00:01.000Z", now)).toBe(false);
  });

  it("treats the exact expiry instant as expired (boundary is inclusive)", () => {
    expect(isExpired(now.toISOString(), now)).toBe(true);
  });

  it("treats a MISSING expiresAt as not expired", () => {
    // Backward compatibility, matching the stance platformRole/teamRole take: the
    // invitations that predate this field — including the bootstrap admin row —
    // would otherwise become permanently un-redeemable.
    expect(isExpired(undefined, now)).toBe(false);
    expect(isExpired("", now)).toBe(false);
  });

  it("treats an UNPARSEABLE expiresAt as expired (corruption fails closed)", () => {
    // The opposite default from "missing", and deliberately so: a garbage value is
    // corruption, and corruption must not admit a sign-up.
    expect(isExpired("not-a-date", now)).toBe(true);
    expect(isExpired("2026-13-45T99:99:99Z", now)).toBe(true);
  });

  it("round-trips with inviteExpiry: fresh is live, one tick past TTL is not", () => {
    const from = new Date("2026-07-31T12:00:00.000Z");
    const expiresAt = inviteExpiry(from);
    expect(isExpired(expiresAt, from)).toBe(false);
    expect(
      isExpired(expiresAt, new Date(from.getTime() + INVITE_TTL_HOURS * 3600_000 + 1))
    ).toBe(true);
  });
});
