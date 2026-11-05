import { describe, it, expect, vi } from "vitest";
import { TRPCClientError } from "@trpc/client";
import { teamContentGate } from "./team-content-gate";

/**
 * THE GATE THAT DECIDES WHAT A TEAM-CONTENT PAGE RENDERS, and it makes a three-way distinction
 * where two of the three are authorization answers.
 *
 * ── THE BUG THAT ADDED THE THIRD STATE ──
 *
 * Reported live on `/w/:id/t/:id/phases` after an idle period:
 *
 *     Couldn't load this team's phases
 *     This is a failure to load, not an empty team, the data is missing, not absent.
 *     Try again ...  Backend error: 401
 *
 * A 401 is an expired SESSION, and that screen got three things wrong: it blamed the data when
 * the data was fine, it offered a retry that cannot succeed (every attempt sends the same dead
 * token), and it asked the user to report a bug that is just an expired login.
 *
 * `Providers` does call `signOut()` on UNAUTHORIZED, but that is an async round trip while React
 * renders on this tick, so the wrong screen is shown for its duration and permanently if the
 * sign-out request itself fails. The gate therefore has to NAME the state; a redirect winning a
 * race is not a design.
 *
 * The three states are asymmetric on purpose, and the ORDER is the substance:
 *   expired      the server could not evaluate any rule -> re-authenticate
 *   member-only  the server evaluated the rule and said no -> nothing to do
 *   failed       something broke -> retry
 */

/** A tRPC client error carrying a structured code, exactly as the real client produces. */
function trpcError(code: string, message = "boom"): TRPCClientError<never> {
  const err = new TRPCClientError(message);
  // `data` is what `trpcErrorCode` reads; the real client populates it from the server.
  (err as unknown as { data: { code: string } }).data = { code };
  return err;
}

const q = (error: unknown = null) => ({ error, refetch: vi.fn() });

describe("expired outranks every other state", () => {
  it("reports EXPIRED for a 401, not failed", async () => {
    // The exact reported bug. `failed` renders "Couldn't load ... Try again", which is both
    // wrong about the cause and useless as an action.
    const gate = teamContentGate([q(trpcError("UNAUTHORIZED"))]);
    expect(gate.state).toBe("expired");
  });

  it("reports EXPIRED even when another query is FORBIDDEN", async () => {
    /**
     * ⚠ THE ORDERING THAT MATTERS MOST. Once the token is gone the server cannot evaluate
     * membership, so a 403 arriving alongside a 401 tells us nothing reliable. Reporting
     * `member-only` here would tell somebody they are not on their own team, an authentication
     * failure wearing an authorization failure's clothes.
     */
    const gate = teamContentGate([
      q(trpcError("FORBIDDEN")),
      q(trpcError("UNAUTHORIZED")),
    ]);
    expect(gate.state).toBe("expired");
  });

  it("reports EXPIRED regardless of which query carries the 401", async () => {
    // Insights passes three queries; the 401 can arrive on any of them.
    expect(
      teamContentGate([q(), q(), q(trpcError("UNAUTHORIZED"))]).state
    ).toBe("expired");
    expect(
      teamContentGate([q(trpcError("UNAUTHORIZED")), q(), q()]).state
    ).toBe("expired");
  });

  it("does NOT offer a retry on the expired state", () => {
    // Structural: `expired` deliberately carries no `retry`, so a page cannot render a button
    // that sends the same dead token again. The type enforces it; this pins the shape.
    const gate = teamContentGate([q(trpcError("UNAUTHORIZED"))]);
    expect(gate).toEqual({ state: "expired" });
  });
});

describe("the other two states are unchanged", () => {
  it("FORBIDDEN alone is member-only, a rule, needing no action", () => {
    const gate = teamContentGate([q(trpcError("FORBIDDEN"))]);
    expect(gate.state).toBe("member-only");
  });

  it("an unstructured failure is FAILED, with the service's own message and a retry", () => {
    // A dropped connection or a non-tRPC throw carries no code. That is the correct direction:
    // a refusal we never received is not a rule, and the ambiguous case must say "broken".
    const refetch = vi.fn();
    const gate = teamContentGate([{ error: new Error("socket hang up"), refetch }]);

    expect(gate.state).toBe("failed");
    if (gate.state !== "failed") throw new Error("unreachable");
    expect(gate.detail).toMatch(/socket hang up/);
    gate.retry();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("retries EVERY failed query, not just the first", () => {
    // Retrying one of three leaves the page neither loaded nor legibly broken.
    const a = { error: new Error("a"), refetch: vi.fn() };
    const ok = q();
    const c = { error: new Error("c"), refetch: vi.fn() };

    const gate = teamContentGate([a, ok, c]);
    if (gate.state !== "failed") throw new Error("expected failed");
    gate.retry();

    expect(a.refetch).toHaveBeenCalledTimes(1);
    expect(c.refetch).toHaveBeenCalledTimes(1);
    expect(ok.refetch, "a healthy query is not refetched").not.toHaveBeenCalled();
  });

  it("no errors at all is ALLOWED", () => {
    expect(teamContentGate([q(), q()]).state).toBe("allowed");
    expect(teamContentGate([]).state).toBe("allowed");
  });
});

describe("codes are read structurally, never from the message", () => {
  it("a message mentioning 401 is NOT treated as expired", () => {
    /**
     * The messages on these paths come from several services and get reworded. A control-flow
     * decision made by string-matching one of them breaks silently the next time somebody
     * improves the wording, so the gate reads `data.code` and nothing else.
     */
    const gate = teamContentGate([
      { error: new Error("Backend error: 401"), refetch: vi.fn() },
    ]);
    expect(gate.state, "no structured code ⇒ failed, not expired").toBe("failed");
  });

  it("an unknown structured code falls through to failed", () => {
    // INTERNAL_SERVER_ERROR, TOO_MANY_REQUESTS and friends are faults, not rules.
    expect(
      teamContentGate([q(trpcError("INTERNAL_SERVER_ERROR"))]).state
    ).toBe("failed");
  });
});
