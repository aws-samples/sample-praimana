// ── SES HAS A SEND RATE, AND FIRING IN PARALLEL IGNORES IT ───────────────────────────────
//
// ⚠ THE BUG THIS FIXES IS PRE-EXISTING AND NOT ABOUT BULK UPLOAD.
//
// `POST /api/invite` sends with `Promise.allSettled(emailable.map(...))`, an UNBOUNDED fan-out.
// SES in this account allows `MaxSendRate: 1.0/sec` (sandbox, verified via `aws sesv2 get-account`),
// so inviting five people at once issues five simultaneous sends against a one-per-second ceiling
// and four of them are throttled. The AWS SDK retries a throttle three times with backoff, which
// rescues a small batch and cannot rescue a large one.
//
// ⚠ AND A LOST SEND IS NOT MERELY A LOST EMAIL. The invite email carries the account's TEMPORARY
// PASSWORD, which `provision.ts` mints once and stores nowhere. A send that fails means the operator
// must RE-INVITE that person, which is precisely the reconciliation work bulk upload exists to
// remove. So pacing is a correctness fix here, not a politeness one.
//
// ── WHY A SEQUENTIAL PACER RATHER THAN A CONCURRENCY LIMIT ──
//
// A limiter of N still issues N sends in the same instant; the constraint SES imposes is a RATE, not
// a concurrency. One at a time with a minimum gap is the shape that matches the constraint, and at
// the sizes this path handles (a team of five, a file of fifteen) the wall-clock cost is seconds.

/**
 * Minimum gap between two sends, in milliseconds.
 *
 * Default 1100ms rather than exactly 1000ms: SES measures its own rate and a request issued at
 * exactly the boundary is a coin flip, so the margin buys a deterministic pass instead of an
 * occasional retry. Overridable because **the sandbox rate is not the production rate**, once
 * production access is granted the ceiling rises and this should fall, and that must not require a
 * code change.
 */
export const DEFAULT_SEND_GAP_MS = 1100;

export function sendGapMs(): number {
  const raw = process.env.SES_SEND_GAP_MS;
  if (!raw) return DEFAULT_SEND_GAP_MS;
  const parsed = Number(raw);
  // Fail SAFE, not fast: an unparseable or negative override falls back to the safe default rather
  // than to "no gap". A typo in an env var must not silently restore the unbounded behaviour.
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn("[invite] ignoring an invalid SES_SEND_GAP_MS", { value: raw });
    return DEFAULT_SEND_GAP_MS;
  }
  return parsed;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `task` over `items` one at a time, leaving at least `gapMs` between STARTS.
 *
 * Returns `PromiseSettledResult` per item, in input order, the same shape `Promise.allSettled`
 * returns, so a caller's existing success/failure accounting keeps working unchanged. A rejection
 * does NOT stop the run: every recipient must get their own attempt, because one bad address must
 * not cost the other fourteen their invitations.
 *
 * ⚠ THE GAP IS MEASURED FROM START TO START, not appended after each task. Appending would add the
 * task's own duration to every interval, so a 400ms send would pace at 1.5s and a batch of fifteen
 * would take 50% longer than necessary for no benefit.
 */
export async function runPaced<T, R>(
  items: readonly T[],
  task: (item: T) => Promise<R>,
  gapMs: number = sendGapMs()
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];

  for (let i = 0; i < items.length; i++) {
    const startedAt = Date.now();

    try {
      results.push({ status: "fulfilled", value: await task(items[i]) });
    } catch (reason) {
      results.push({ status: "rejected", reason });
    }

    // No trailing wait after the last item, it would add a second of latency to every batch for
    // nothing, and on the last send there is no following request to space away from.
    if (i < items.length - 1) {
      const elapsed = Date.now() - startedAt;
      if (elapsed < gapMs) await sleep(gapMs - elapsed);
    }
  }

  return results;
}
