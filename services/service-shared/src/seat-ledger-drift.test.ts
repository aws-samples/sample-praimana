import { describe, it, expect, vi, afterEach } from "vitest";
import {
  emitSeatLedgerDriftMetric,
  SEAT_LEDGER_METRIC_NAMESPACE,
  SEAT_LEDGER_DRIFT_METRIC,
} from "./metrics.js";

/**
 * THE SEAT LEDGER DRIFT METRIC, and the three states it must keep apart.
 *
 * `memberCount` moves in the SAME `TransactWriteItems` as the membership row, so under the Team
 * service's own writes it cannot drift. This metric exists to catch the one thing the design
 * cannot prevent — a future write path that touches `team-members` without going through
 * `admit`/`deactivate`/`reactivate` — which would leave the ledger wrong and start refusing
 * joins to a team that has room.
 *
 * So the assertions below are mostly about NOT crying wolf: an unledgered row and a healthy row
 * must both report 0, or the one datapoint that means "somebody bypassed the repository" is
 * buried under noise from rows that simply predate the feature.
 *
 * Asserted on the EMITTED LOG LINE, because EMF is a log format: CloudWatch derives the metric
 * from what is written to stdout, so the line IS the contract.
 */

function captureEmf() {
  const lines: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(console, "log").mockImplementation((arg: unknown) => {
    if (typeof arg === "string") {
      try {
        lines.push(JSON.parse(arg));
      } catch {
        // Not an EMF line — the helper also logs human-readable text in some paths.
      }
    }
  });
  return { lines, spy };
}

afterEach(() => vi.restoreAllMocks());

/** The metric value CloudWatch will read off the line. */
const value = (line: Record<string, unknown>) =>
  (line as Record<string, number>)[SEAT_LEDGER_DRIFT_METRIC];

describe("agreement reports 0 — silence must not be the healthy state", () => {
  it("emits a datapoint even when nothing is wrong", () => {
    /**
     * A metric published ONLY on failure is indistinguishable from a metric nobody publishes,
     * so the alarm cannot tell "healthy" from "the emitting code was deleted in a refactor".
     * Emitting 0 makes silence itself a signal. Same reasoning as emitAccessAuditMetric.
     */
    const { lines } = captureEmf();

    emitSeatLedgerDriftMetric({ teamId: "t1", actualActive: 4, ledgerCount: 4 });

    expect(lines).toHaveLength(1);
    expect(value(lines[0])).toBe(0);
    expect(lines[0].event).toMatch(/agrees with the roster/);
  });

  it("publishes under the namespace and metric name the alarm watches", () => {
    // An exact-match contract: a typo here does not fail anything, it means the alarm watches
    // a metric nobody publishes and sits permanently OK.
    const { lines } = captureEmf();

    emitSeatLedgerDriftMetric({ teamId: "t1", actualActive: 1, ledgerCount: 1 });

    const meta = lines[0]._aws as {
      CloudWatchMetrics: Array<{ Namespace: string; Metrics: Array<{ Name: string }> }>;
    };
    expect(meta.CloudWatchMetrics[0].Namespace).toBe(SEAT_LEDGER_METRIC_NAMESPACE);
    expect(meta.CloudWatchMetrics[0].Metrics[0].Name).toBe(SEAT_LEDGER_DRIFT_METRIC);
    expect(SEAT_LEDGER_METRIC_NAMESPACE).toBe("Praimana/TeamSeats");
    expect(SEAT_LEDGER_DRIFT_METRIC).toBe("SeatLedgerDrift");
  });
});

describe("real drift is reported, in either direction", () => {
  it("reports the magnitude when the ledger UNDER-counts", () => {
    // The dangerous direction: the ledger says 3, the roster says 5, so the team keeps two
    // seats it should not have — a bypassing writer added rows without incrementing.
    const { lines } = captureEmf();

    emitSeatLedgerDriftMetric({ teamId: "t1", actualActive: 5, ledgerCount: 3 });

    expect(value(lines[0])).toBe(2);
    expect(lines[0].event).toMatch(/SEAT LEDGER DRIFT/);
    expect(lines[0].event).toMatch(/bypassed the membership repository/);
  });

  it("reports the magnitude when the ledger OVER-counts", () => {
    // The other direction is also drift, and also actionable: the ledger says 6 of 6 while only
    // 4 people are on the team, so two legitimate joins are refused with TEAM_FULL. `Math.abs`
    // is why this is not silently zero.
    const { lines } = captureEmf();

    emitSeatLedgerDriftMetric({ teamId: "t1", actualActive: 4, ledgerCount: 6 });

    expect(value(lines[0])).toBe(2);
    expect(lines[0].event).toMatch(/SEAT LEDGER DRIFT/);
  });

  it("carries the ids as PROPERTIES, never as dimensions", () => {
    /**
     * teamId is unbounded cardinality: one metric per team is one billed metric per team, and
     * CloudWatch treats every dimension combination as a separate metric. The investigation
     * needs the id, so it goes on the log line where Logs Insights can search it.
     */
    const { lines } = captureEmf();

    emitSeatLedgerDriftMetric({ teamId: "team-abc", actualActive: 5, ledgerCount: 3 });

    expect(lines[0].teamId).toBe("team-abc");
    expect(lines[0].actualActive).toBe(5);
    expect(lines[0].ledgerCount).toBe(3);
    const meta = lines[0]._aws as {
      CloudWatchMetrics: Array<{ Dimensions: string[][] }>;
    };
    for (const dims of meta.CloudWatchMetrics[0].Dimensions ?? []) {
      expect(dims, "no id may become a dimension").not.toContain("teamId");
    }
  });
});

describe("an UNLEDGERED row is not drift — the distinction the alarm depends on", () => {
  it("reports 0, not the whole roster, when memberCount is ABSENT", () => {
    /**
     * THE ASSERTION THAT KEEPS THE ALARM USABLE.
     *
     * A row predating the ledger has no `memberCount`. Treating that as drift would report a
     * magnitude equal to the team's entire roster — so three unbackfilled teams would swamp the
     * single datapoint that actually means "somebody bypassed the repository", and the alarm
     * would be muted within a day.
     *
     * It also needs a DIFFERENT action: run the backfill, not hunt for a rogue writer.
     */
    const { lines } = captureEmf();

    emitSeatLedgerDriftMetric({ teamId: "t1", actualActive: 4, ledgerCount: null });

    expect(value(lines[0])).toBe(0);
    expect(lines[0].unledgered).toBe(true);
    // Points at the remedy by NAME, because that is what an operator needs at 3am.
    expect(lines[0].event).toMatch(/backfill-team-seat-ledger/);
    expect(lines[0].event, "must not read as a bypassing writer").not.toMatch(/DRIFT/);
  });

  it("flags a ledgered row as NOT unledgered, so the two are separable in Logs Insights", () => {
    const { lines } = captureEmf();
    emitSeatLedgerDriftMetric({ teamId: "t1", actualActive: 4, ledgerCount: 4 });
    expect(lines[0].unledgered).toBe(false);
  });

  it("treats a ledger of 0 as a real ledger, not an absent one", () => {
    // `0` is falsy, so a truthiness check here would report an EMPTY team as unledgered and
    // hide genuine drift on it. The emitter tests `=== null` for exactly this reason.
    const { lines } = captureEmf();

    emitSeatLedgerDriftMetric({ teamId: "t1", actualActive: 2, ledgerCount: 0 });

    expect(lines[0].unledgered).toBe(false);
    expect(value(lines[0])).toBe(2);
  });
});

describe("observability never breaks the operation it reports on", () => {
  it("does NOT throw when the log sink fails", () => {
    // This sits on a read path that has already produced its answer. A throwing emitter would
    // turn a served roster into a 500 — the operation succeeded, so the report must not fail it.
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout is gone");
    });

    expect(() =>
      emitSeatLedgerDriftMetric({ teamId: "t1", actualActive: 5, ledgerCount: 3 })
    ).not.toThrow();
  });
});
