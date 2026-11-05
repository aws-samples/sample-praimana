import { describe, it, expect } from "vitest";
import { tokenExpiryMs, WS_CLOSE_TOKEN_EXPIRED } from "./ws-server.js";

/**
 * THE WEBSOCKET SESSION BOUND.
 *
 * The team event stream verified its token ONCE, at handshake, and never again. The heartbeat
 * only reaps sockets that stop answering pings — a healthy client kept streaming every team
 * event for as long as it stayed connected.
 *
 * So "access ends when the token expires" was FALSE for this path, by an unbounded margin. A
 * member removed from a team, a user whose access was disabled, a changed role: none of them
 * closed an open stream. Disabling someone's account stopped them signing in and left them
 * watching the team's live events indefinitely.
 *
 * Closing at the token's `exp` bounds every socket to the lifetime of the credential that
 * opened it (30 minutes here), which fixes the whole class rather than only the deactivation
 * case. The client reconnects with a fresh token; a client that can no longer get one stays
 * out.
 *
 * `tokenExpiryMs` is DECODE-ONLY and safe because of ordering: `authorize()` has already run
 * `verifyJwtIdentity`, which checks signature, issuer, audience and expiry against the pool's
 * JWKS. This re-reads a claim from a payload already proven authentic — a forged token never
 * reaches it.
 */

/** An unsigned JWT-shaped string. Signature is irrelevant: this decoder never checks one. */
function tokenWith(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.signature-not-checked-here`;  // nosemgrep: missing-template-string-indicator
}

describe("tokenExpiryMs", () => {
  it("reads exp and converts SECONDS to MILLISECONDS", () => {
    // JWT `exp` is in seconds; setTimeout wants milliseconds. Getting this wrong by 1000x
    // means a 30-minute session closes after 1.8 seconds (or lasts three weeks).
    const expSeconds = 1_800_000_000;
    expect(tokenExpiryMs(tokenWith({ exp: expSeconds }))).toBe(expSeconds * 1000);
  });

  it("returns null when exp is absent", () => {
    expect(tokenExpiryMs(tokenWith({ sub: "u1" }))).toBeNull();
  });

  it("returns null when exp is not a number", () => {
    // A string "1800000000" would multiply into a plausible-looking number via JS coercion
    // if this used arithmetic without a type check — so the check is explicit.
    for (const exp of ["1800000000", null, true, {}, []]) {
      expect(tokenExpiryMs(tokenWith({ exp }))).toBeNull();
    }
  });

  it("returns null for a malformed token instead of throwing", () => {
    // A throw here would take down the upgrade handler for every connection. The caller
    // treats null as "no bound" and logs it — see the call site note on why that is right.
    for (const t of ["", "not-a-jwt", "only.two", "a.!!!not-base64!!!.c"]) {
      expect(tokenExpiryMs(t)).toBeNull();
    }
  });

  it("handles a payload that is valid base64url but not an object", () => {
    const b64 = Buffer.from(JSON.stringify("a string")).toString("base64url");
    expect(tokenExpiryMs(`header.${b64}.sig`)).toBeNull();
  });
});

describe("the derived close delay", () => {
  // Mirrors the call site: Math.max(0, expiresAtMs - Date.now()).
  const ttl = (expiresAtMs: number, now: number) => Math.max(0, expiresAtMs - now);

  it("schedules the remaining lifetime for a live token", () => {
    const now = 1_700_000_000_000;
    expect(ttl(now + 30 * 60_000, now)).toBe(30 * 60_000);
  });

  it("CLAMPS TO ZERO for a token that expired between verify and connect", () => {
    // Never a negative delay: a token expiring in that window closes on the next tick rather
    // than scheduling into the past, which some timer implementations treat as "never".
    const now = 1_700_000_000_000;
    expect(ttl(now - 5_000, now)).toBe(0);
  });
});

describe("WS_CLOSE_TOKEN_EXPIRED", () => {
  it("is in the private 4000-4999 range, so it cannot collide with a protocol code", () => {
    expect(WS_CLOSE_TOKEN_EXPIRED).toBeGreaterThanOrEqual(4000);
    expect(WS_CLOSE_TOKEN_EXPIRED).toBeLessThanOrEqual(4999);
  });

  it("is distinct, so a client can tell expiry from a refusal", () => {
    // Presenting "your session ended, reconnect" as a generic 1000/1008 would show the user
    // an unexplained disconnect.
    expect(WS_CLOSE_TOKEN_EXPIRED).not.toBe(1000);
    expect(WS_CLOSE_TOKEN_EXPIRED).not.toBe(1008);
  });
});
