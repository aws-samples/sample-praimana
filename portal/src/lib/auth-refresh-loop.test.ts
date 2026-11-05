import { describe, it, expect } from "vitest";
import { needsRefresh } from "./cognito-refresh";
import type { AppToken } from "@/types/next-auth";

/**
 * THE LOGIN LOOP I SHIPPED, and the interaction that produced it.
 *
 * Reported: "can't login, it's showing signing you in / checking your session and the page
 * refreshing". Every individual piece behaved exactly as designed; the bug was the SEAM between
 * the two auth providers, which no test covered.
 *
 *   1. AuthFlow resume → signIn("cognito-token") → jwt() with `account`
 *      The custom-UI branch set accessToken, role and id, and NOT accessTokenExpiresAt.
 *   2. Next session read → jwt() with no `account` → needsRefresh(undefined) === TRUE
 *      (correct on its own: an unknown expiry must not be trusted)
 *   3. That path has no server-side refresh token → `refreshFailed = true`
 *   4. session() withholds accessToken
 *   5. protectedProcedure → UNAUTHORIZED → expired-session redirect → /login
 *   6. /login's resume succeeds → back to step 1 → forever
 *
 * TWO INDEPENDENT DEFECTS, and either alone would have been enough to break it:
 *   - the expiry was not recorded on the custom-UI path (I added refresh bookkeeping to the
 *     Hosted-UI branch and did not carry it to the other one)
 *   - a missing SERVER-side refresh token was treated as a failure, when for that provider it is
 *     normal: Amplify holds the refresh token in the browser
 *
 * These tests model the jwt/session decision as pure functions over an AppToken, because that is
 * where the bug lived, not in either provider, but in what the shared callback does with what
 * each one left behind.
 */

/** The `jwt` callback's refresh decision, mirroring auth.ts. */
type Decision = "fresh-enough" | "renew-server-side" | "leave-to-client-renewal";

function refreshDecision(t: AppToken, now: number): Decision {
  if (!needsRefresh(t.accessTokenExpiresAt, now)) return "fresh-enough";
  if (!t.refreshToken) return "leave-to-client-renewal";
  return "renew-server-side";
}

/** What `session()` exposes as the API bearer. */
function bearerFor(t: AppToken): string | undefined {
  return t.refreshFailed ? undefined : t.accessToken;
}

const IN_30_MIN = 30 * 60 * 1000;

describe("the custom-UI (Amplify) path must not evict itself", () => {
  it("records an expiry at sign-in, so the next read is not immediately stale", () => {
    // THE FIRST DEFECT. Without `accessTokenExpiresAt`, needsRefresh is true on the very next
    // session read, one minute after logging in.
    const now = 1_000_000;
    const token: AppToken = {
      id: "u1",
      accessToken: "id-token",
      accessTokenExpiresAt: now + IN_30_MIN,
    };

    expect(refreshDecision(token, now)).toBe("fresh-enough");
    expect(bearerFor(token), "the bearer must survive").toBe("id-token");
  });

  it("an ABSENT expiry still means 'needs refresh', that half was correct", () => {
    // Not softened by the fix: an unknown lifetime must not be trusted. The bug was never that
    // this returned true; it was what happened NEXT.
    expect(needsRefresh(undefined, Date.now())).toBe(true);
  });

  it("KEEPS the bearer when there is no server-side refresh token", () => {
    /**
     * THE SECOND DEFECT, and the one that closed the loop. Marking `refreshFailed` here withheld
     * the bearer, so every call 401'd and the redirect fired, even though the token in hand was
     * still valid and this provider renews client-side.
     */
    const now = 1_000_000;
    const token: AppToken = {
      id: "u1",
      accessToken: "still-valid-id-token",
      // Stale enough to want a refresh…
      accessTokenExpiresAt: now + 10_000,
      // …but no server-side refresh token, because Amplify holds it in the browser.
      refreshToken: undefined,
    };

    expect(refreshDecision(token, now)).toBe("leave-to-client-renewal");
    expect(
      bearerFor(token),
      "withholding this is what looped: 401 -> redirect -> resume -> repeat"
    ).toBe("still-valid-id-token");
  });

  it("does NOT loop even when the expiry is unknown", () => {
    // The exact reported state: signed in through the custom UI, no expiry recorded, no refresh
    // token. The decision must still leave a usable bearer.
    const token: AppToken = { id: "u1", accessToken: "id-token" };

    expect(refreshDecision(token, Date.now())).toBe("leave-to-client-renewal");
    expect(bearerFor(token)).toBe("id-token");
  });
});

describe("the Hosted-UI path still refreshes server-side", () => {
  it("renews when stale and a refresh token is present", () => {
    const now = 1_000_000;
    const token: AppToken = {
      id: "u1",
      accessToken: "old",
      accessTokenExpiresAt: now + 10_000,
      refreshToken: "r",
    };
    expect(refreshDecision(token, now)).toBe("renew-server-side");
  });

  it("does not renew while the token is comfortably valid", () => {
    const now = 1_000_000;
    const token: AppToken = {
      id: "u1",
      accessToken: "fresh",
      accessTokenExpiresAt: now + IN_30_MIN,
      refreshToken: "r",
    };
    expect(refreshDecision(token, now)).toBe("fresh-enough");
  });

  it("withholds the bearer ONLY after a refresh actually failed", () => {
    /**
     * `refreshFailed` is still the eviction mechanism, it is now set only where it is TRUE: a
     * refresh was attempted with a real refresh token and Cognito refused (spent, revoked, or the
     * user disabled). That cannot be fixed by retrying, so re-authentication is the honest answer.
     */
    const failed: AppToken = { id: "u1", accessToken: "dead", refreshFailed: true };
    expect(bearerFor(failed)).toBeUndefined();

    const ok: AppToken = { id: "u1", accessToken: "live", refreshFailed: false };
    expect(bearerFor(ok)).toBe("live");
  });
});

describe("the refresh token never travels on the session", () => {
  it("is not part of what session() exposes", () => {
    /**
     * A 30-day credential must not go as far as the 30-minute one it renews. `session.accessToken`
     * reaches server components and the tRPC context; the refresh token stays in the encrypted
     * JWT cookie. This asserts the SHAPE of what the bearer helper returns, a string or nothing,
     * never the token object.
     */
    const token: AppToken = {
      id: "u1",
      accessToken: "bearer",
      refreshToken: "thirty-day-credential",
    };
    const exposed = bearerFor(token);
    expect(exposed).toBe("bearer");
    expect(JSON.stringify(exposed)).not.toContain("thirty-day-credential");
  });
});

describe("a session cookie poisoned by the loop must SELF-HEAL", () => {
  /**
   * WHY THE FIRST FIX WAS NOT ENOUGH, and the reported symptom that followed it.
   *
   * The loop stamped `refreshFailed: true` into the encrypted session cookie. The follow-up commit
   * stopped SETTING the flag, but nothing CLEARED it, and it was only reset on a successful
   * server-side refresh, which the custom-UI path never performs. So an already-affected cookie
   * kept withholding the bearer for ever:
   *
   *     "Couldn't load this team's board … Backend error: 401"
   *
   * with a perfectly valid token sitting in the cookie the whole time, for the 30 days until it
   * expired. A fix that requires the user to clear their cookies is not a fix.
   *
   * Two clearing points, modelled below: a fresh sign-in (a new `account` means a new token, so
   * any previous failure is irrelevant) and any read where the bearer is NOT due for refresh (a
   * token we are willing to send makes a failure flag stale by definition).
   */

  /** The jwt callback's flag handling, mirroring auth.ts. */
  function afterJwt(
    t: AppToken,
    opts: { freshAccount?: boolean; now?: number } = {}
  ): AppToken {
    const now = opts.now ?? Date.now();
    const next = { ...t };
    if (opts.freshAccount) {
      next.refreshFailed = false;
      return next;
    }
    if (!needsRefresh(next.accessTokenExpiresAt, now)) {
      if (next.refreshFailed) next.refreshFailed = false;
      return next;
    }
    return next;
  }

  it("clears the flag on a fresh sign-in", () => {
    const poisoned: AppToken = {
      id: "u1",
      accessToken: "brand-new-token",
      refreshFailed: true,
    };

    const healed = afterJwt(poisoned, { freshAccount: true });

    expect(healed.refreshFailed).toBe(false);
    expect(bearerFor(healed), "the bearer must be usable again").toBe("brand-new-token");
  });

  it("clears the flag on ANY read where the token is not due for refresh", () => {
    // The self-healing path. Without it, signing in again was the only recovery, and on the
    // custom-UI path even that did not clear it before this fix.
    const now = 1_000_000;
    const poisoned: AppToken = {
      id: "u1",
      accessToken: "still-valid",
      accessTokenExpiresAt: now + IN_30_MIN,
      refreshFailed: true,
    };

    const healed = afterJwt(poisoned, { now });

    expect(healed.refreshFailed).toBe(false);
    expect(bearerFor(healed)).toBe("still-valid");
  });

  it("keeps withholding the bearer while a refresh is genuinely due and failing", () => {
    /**
     * The flag must still WORK. Self-healing may not become "ignore failures": a stale token with
     * a refresh token that Cognito refuses is exactly the case where re-authentication is the
     * honest answer, and clearing the flag there would loop in the opposite direction, silently
     * sending a dead bearer for ever.
     */
    const now = 1_000_000;
    const genuinelyFailed: AppToken = {
      id: "u1",
      accessToken: "dead",
      accessTokenExpiresAt: now - 1,
      refreshToken: "spent",
      refreshFailed: true,
    };

    const after = afterJwt(genuinelyFailed, { now });

    expect(after.refreshFailed, "still failed, a refresh is due").toBe(true);
    expect(bearerFor(after)).toBeUndefined();
  });
});
