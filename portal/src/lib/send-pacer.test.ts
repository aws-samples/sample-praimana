// ── PACING SES SENDS ─────────────────────────────────────────────────────────────────────
//
// ⚠ WHAT THIS FILE DOES *NOT* COVER, STATED UP FRONT: `src/app/api/invite/route.ts`
// has NO TEST FILE AT ALL. The route that stores invitations, provisions Cognito accounts and sends
// the emails is untested, which is how an unbounded `Promise.allSettled` fan-out against a 1/sec SES
// limit survived in it. These tests cover the pacer the route now calls; they do not cover the
// route. Writing that test is worth doing and is not done here.
//
// The pacer exists because SES imposes a RATE (`MaxSendRate: 1.0/sec` in this sandbox account), and
// a lost send takes the account's temporary password with it, `provision.ts` mints it once and
// stores it nowhere, so a throttled email means the operator must RE-INVITE. That is the
// reconciliation work bulk upload exists to remove, which makes pacing a correctness fix.

import { describe, it, expect, vi, afterEach } from "vitest";
import { runPaced, sendGapMs, DEFAULT_SEND_GAP_MS } from "./send-pacer";

afterEach(() => {
  vi.useRealTimers();
  delete process.env.SES_SEND_GAP_MS;
  vi.unstubAllGlobals();
});

/**
 * Drive a paced run under fake timers, recording the virtual time each task STARTED.
 *
 * Fake timers because the real gap is 1.1 seconds: a fifteen-recipient test would take sixteen
 * real seconds, and a suite nobody wants to run is a suite that stops being run.
 */
async function pacedStarts(count: number, gapMs: number) {
  vi.useFakeTimers();
  const starts: number[] = [];

  const pending = runPaced(
    Array.from({ length: count }, (_, i) => i),
    async () => {
      starts.push(Date.now());
    },
    gapMs
  );

  // Let each task settle and each inter-task sleep elapse.
  await vi.runAllTimersAsync();
  await pending;
  return starts;
}

describe("⚠ sends are spaced, not fired in parallel", () => {
  /**
   * THE ASSERTION THAT MATTERS. The previous code issued every send in the same instant; SES
   * throttles all but the first. This pins that consecutive sends are at least a gap apart.
   */
  it("leaves at least the gap between consecutive sends", async () => {
    const starts = await pacedStarts(5, 1000);

    expect(starts).toHaveLength(5);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(1000);
    }
  });

  it("runs strictly one at a time, in input order", async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];

    const pending = runPaced(
      [0, 1, 2, 3],
      async (i) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(i);
        inFlight--;
      },
      1000
    );
    await vi.runAllTimersAsync();
    await pending;

    // Concurrency of 1 is the whole point, a limiter of N would still burst N at the same instant.
    expect(maxInFlight).toBe(1);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  /**
   * ⚠ START-TO-START, NOT APPENDED AFTER EACH TASK. Appending would add the send's own duration to
   * every interval, so a 400ms send would pace at 1.4s and a batch of fifteen would take 50% longer
   * than necessary, for no benefit, since SES measures request arrivals.
   */
  it("counts the task's own duration towards the gap", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];

    const pending = runPaced(
      [0, 1],
      async () => {
        starts.push(Date.now());
        // A send that itself takes 400ms.
        await new Promise((r) => setTimeout(r, 400));
      },
      1000
    );
    await vi.runAllTimersAsync();
    await pending;

    // 1000, not 1400, the 400ms of work counts towards the interval rather than adding to it.
    expect(starts[1] - starts[0]).toBe(1000);
  });

  it("does not wait after the LAST item", async () => {
    // A trailing sleep would add a second of latency to every batch with nothing to space away from.
    vi.useFakeTimers();
    const pending = runPaced([0], async () => "done", 5_000);
    await vi.runAllTimersAsync();

    const started = Date.now();
    await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("handles an empty list without waiting or throwing", async () => {
    expect(await runPaced([], async () => "x", 10_000)).toEqual([]);
  });
});

describe("⚠ one bad address must not cost the others their invitations", () => {
  /**
   * A rejection is CAPTURED and the run continues. The route counts fulfilled vs rejected to report
   * "3 of 5 emailed"; a pacer that threw on the first failure would abandon the remaining
   * recipients, and each abandoned one is a provisioned account whose owner never learns they have
   * one.
   */
  it("keeps going after a failure and reports per-item outcomes in order", async () => {
    vi.useFakeTimers();
    const pending = runPaced(
      ["ok1", "bad", "ok2"],
      async (item) => {
        if (item === "bad") throw new Error("SES said no");
        return item;
      },
      100
    );
    await vi.runAllTimersAsync();
    const results = await pending;

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    // The shape matches `Promise.allSettled`, which is what keeps the route's accounting unchanged.
    expect(results[0]).toMatchObject({ status: "fulfilled", value: "ok1" });
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
  });

  it("still paces AFTER a failure", async () => {
    // A throttled send is exactly the case where slowing down matters most; skipping the gap on
    // failure would hammer SES precisely when it is refusing.
    vi.useFakeTimers();
    const starts: number[] = [];
    const pending = runPaced(
      [0, 1],
      async () => {
        starts.push(Date.now());
        throw new Error("throttled");
      },
      1000
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
  });
});

describe("the gap is configurable, because the sandbox rate is not the production rate", () => {
  it("defaults above 1000ms so a boundary-timed request is not a coin flip", () => {
    expect(sendGapMs()).toBe(DEFAULT_SEND_GAP_MS);
    expect(DEFAULT_SEND_GAP_MS).toBeGreaterThan(1000);
  });

  it("honours a valid override", () => {
    // Production access raises SES's ceiling; lowering this must not need a code change.
    process.env.SES_SEND_GAP_MS = "50";
    expect(sendGapMs()).toBe(50);
  });

  it("allows 0 explicitly, for a local transport with no rate limit", () => {
    process.env.SES_SEND_GAP_MS = "0";
    expect(sendGapMs()).toBe(0);
  });

  /**
   * ⚠ FAILS SAFE, NOT FAST. A typo in an env var must fall back to the SAFE default rather than to
   * "no gap", silently restoring the unbounded behaviour this module exists to prevent would be
   * the worst possible reading of a malformed value.
   */
  it.each(["abc", "-5", "NaN"])("ignores the invalid override %s and keeps the safe default", (bad) => {
    vi.stubGlobal("console", { ...console, warn: vi.fn() });
    process.env.SES_SEND_GAP_MS = bad;
    expect(sendGapMs()).toBe(DEFAULT_SEND_GAP_MS);
  });

  it("warns when it ignores an override, so the operator learns their setting did nothing", () => {
    const warn = vi.fn();
    vi.stubGlobal("console", { ...console, warn });
    process.env.SES_SEND_GAP_MS = "not-a-number";

    sendGapMs();

    expect(warn).toHaveBeenCalled();
  });
});
