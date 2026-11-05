import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ACCESS_METRIC_NAMESPACE,
  UNAUDITED_ACCESS_CHANGES_METRIC,
  emitAccessAuditMetric,
  emitMetric,
  type AuditedAccessAction,
} from "./metrics.js";

/**
 * THE EMF ENVELOPE, asserted structurally rather than by eyeball.
 *
 * WHY THIS FILE IS WORTH ITS LENGTH. Every failure mode of an EMF metric is SILENT: a
 * wrong namespace, a missing empty dimension set, or a record CloudWatch rejects for a
 * blank dimension value all produce the same observable outcome — an alarm that sits
 * permanently OK because no datapoint ever reaches it. That is indistinguishable from a
 * healthy platform, so nothing but a test catches it. The alarm this helper feeds
 * (UnauditedAccessChangeAlarm) is the ONLY control on the unrecoverable half of the
 * access-change path, which is why its wiring is pinned here literal by literal.
 */

/** The EMF records written to stdout during one test. */
function captureEmf(): { records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    if (typeof line !== "string") return;
    try {
      records.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // A non-JSON log line is not an EMF record; ignored rather than failing here so a
      // test asserts on what it meant to assert on.
    }
  });
  return { records };
}

interface EmfEnvelope {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: Array<{
      Namespace: string;
      Dimensions: string[][];
      Metrics: Array<{ Name: string; Unit: string }>;
    }>;
  };
  [key: string]: unknown;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emitMetric — the EMF envelope", () => {
  it("publishes BOTH the empty dimension set and the keyed one", () => {
    // THE ONE ASSERTION THAT MATTERS MOST. CloudWatch treats each dimension combination as
    // its own metric and an alarm must match one exactly, so publishing only under
    // {Action} would leave a Dimensions-less alarm watching nothing — for ever, silently.
    // Both sets, and the empty one FIRST is not asserted because order is irrelevant to
    // CloudWatch; presence of both is the contract.
    const { records } = captureEmf();

    emitMetric({
      namespace: "Praimana/Test",
      name: "Widgets",
      value: 1,
      dimensions: { Action: "MEMBER_RESTORED" },
    });

    expect(records).toHaveLength(1);
    const emf = records[0] as unknown as EmfEnvelope;
    const directive = emf._aws.CloudWatchMetrics[0];
    expect(directive.Dimensions).toEqual(
      expect.arrayContaining([[], ["Action"]])
    );
    expect(directive.Dimensions).toHaveLength(2);
  });

  it("publishes the aggregate ALONE when there are no dimensions", () => {
    // `[[]]`, not `[[], []]` — a duplicated empty set would double-count the aggregate,
    // which is the statistic the alarm reads.
    const { records } = captureEmf();

    emitMetric({ namespace: "Praimana/Test", name: "Widgets", value: 1 });

    const emf = records[0] as unknown as EmfEnvelope;
    expect(emf._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
  });

  it("puts the value under the metric NAME, with a Count unit and a timestamp", () => {
    const { records } = captureEmf();

    emitMetric({ namespace: "Praimana/Test", name: "Widgets", value: 7 });

    const emf = records[0] as unknown as EmfEnvelope;
    expect(emf.Widgets).toBe(7);
    expect(emf._aws.CloudWatchMetrics[0].Metrics).toEqual([
      { Name: "Widgets", Unit: "Count" },
    ]);
    // A record with no/invalid Timestamp is dropped by the log-group parser.
    expect(typeof emf._aws.Timestamp).toBe("number");
    expect(emf._aws.Timestamp).toBeGreaterThan(0);
  });

  it("carries dimension VALUES as top-level properties, which is how EMF resolves them", () => {
    // The directive names dimension KEYS; the values are read off the record body. A
    // record naming a key it does not carry a value for is rejected whole.
    const { records } = captureEmf();

    emitMetric({
      namespace: "Praimana/Test",
      name: "Widgets",
      value: 1,
      dimensions: { Action: "ACCESS_DISABLED" },
    });

    expect(records[0].Action).toBe("ACCESS_DISABLED");
  });

  it("keeps `properties` searchable WITHOUT making them dimensions", () => {
    // The split the cardinality rule depends on: ids are on the
    // line for the investigation, and NOT in Dimensions where each distinct value would
    // become its own metric.
    const { records } = captureEmf();

    emitMetric({
      namespace: "Praimana/Test",
      name: "Widgets",
      value: 1,
      dimensions: { Action: "MEMBER_REMOVED" },
      properties: { subjectId: "u-1", actorId: "u-2" },
    });

    const emf = records[0] as unknown as EmfEnvelope;
    expect(emf.subjectId).toBe("u-1");
    expect(emf.actorId).toBe("u-2");
    expect(emf._aws.CloudWatchMetrics[0].Dimensions).toEqual(
      expect.arrayContaining([[], ["Action"]])
    );
    // Neither id appears as a dimension KEY anywhere.
    for (const set of emf._aws.CloudWatchMetrics[0].Dimensions) {
      expect(set).not.toContain("subjectId");
      expect(set).not.toContain("actorId");
    }
  });

  it("a property can NEVER shadow a dimension value", () => {
    // Dimensions are spread last for exactly this: a caller passing `properties.Action`
    // must not be able to publish the metric under a value the emitter did not choose,
    // which would let a breakdown be forged (or the alarm's aggregate be polluted).
    const { records } = captureEmf();

    emitMetric({
      namespace: "Praimana/Test",
      name: "Widgets",
      value: 1,
      dimensions: { Action: "MEMBER_REMOVED" },
      properties: { Action: "SOMETHING_ELSE" },
    });

    expect(records[0].Action).toBe("MEMBER_REMOVED");
  });

  it("DROPS a blank dimension value rather than emitting a record CloudWatch rejects", () => {
    // A blank value invalidates the WHOLE record, so the aggregate would be lost too.
    // Dropping the key keeps the empty dimension set publishing — losing the breakdown
    // beats losing the alarm's signal.
    const { records } = captureEmf();

    emitMetric({
      namespace: "Praimana/Test",
      name: "Widgets",
      value: 1,
      dimensions: { Action: "   " },
    });

    const emf = records[0] as unknown as EmfEnvelope;
    expect(emf._aws.CloudWatchMetrics[0].Dimensions).toEqual([[]]);
    expect(emf.Action).toBeUndefined();
    // The datapoint itself still lands.
    expect(emf.Widgets).toBe(1);
  });

  it("CLAMPS an over-long dimension value to CloudWatch's 255-char limit", () => {
    const { records } = captureEmf();

    emitMetric({
      namespace: "Praimana/Test",
      name: "Widgets",
      value: 1,
      dimensions: { Action: "A".repeat(300) },
    });

    expect(String(records[0].Action)).toHaveLength(255);
  });

  it("NEVER THROWS, even on a value JSON.stringify cannot serialise", () => {
    // The contract every caller relies on: each one is already on a degraded path where
    // the access change has taken effect, so a throwing metric would turn a reported
    // partial into a 500 on work that cannot be undone.
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;

    expect(() =>
      emitMetric({
        namespace: "Praimana/Test",
        name: "Widgets",
        value: 1,
        properties: { circular },
      })
    ).not.toThrow();
  });

  it("NEVER THROWS when console.log itself throws", () => {
    // A transport failure is still observability failing, and it must not propagate.
    vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout is gone");
    });

    expect(() =>
      emitMetric({ namespace: "Praimana/Test", name: "Widgets", value: 1 })
    ).not.toThrow();
  });
});

describe("the access-change metric identifiers", () => {
  it("match the alarm in the infrastructure CloudFormation template EXACTLY", () => {
    // ⚠ THE LINK BETWEEN THE CODE AND THE TEMPLATE, asserted against literal strings
    // because reading the YAML from here is not possible. If this fails, either the
    // template changed or these constants did, and UnauditedAccessChangeAlarm is watching
    // a metric nobody publishes — an alarm that stays OK through the exact failure it
    // exists to catch. Change both files or neither.
    expect(ACCESS_METRIC_NAMESPACE).toBe("Praimana/AccessChanges");
    expect(UNAUDITED_ACCESS_CHANGES_METRIC).toBe("UnauditedAccessChanges");
  });

  it("is ONE metric for EVERY action, not one metric each", () => {
    // ── WIDENED: THIS ASSERTED FOUR ACTIONS, AND ENTITLEMENT_REVOKED IS THE FIFTH ──
    //
    // The four original members are UNCHANGED and still asserted below, in the same order. The
    // fifth is the withdrawal of a JUDGE's WORKSHOP entitlement by the
    // team service's DELETE …/invitations/:email/workshop, and it belongs on THIS metric for
    // the reason the metric is shared at all: the alarm question is "did ANY access change go
    // unrecorded", so N metrics would mean N alarms and N-1 chances to forget one.
    //
    // ⚠ THIS IS ALSO THE ONLY THING THAT PROVES A NEW ACTION IS COVERED BY THE ALARM.
    // UnauditedAccessChangeAlarm declares NO Dimensions and watches the empty set, so a new
    // action is picked up with no template change — which is convenient and also means nothing
    // at runtime would report a fifth action publishing under the wrong namespace or name.
    const { records } = captureEmf();

    for (const action of [
      "MEMBER_REMOVED",
      "MEMBER_RESTORED",
      "ACCESS_DISABLED",
      "ACCESS_ENABLED",
      "ENTITLEMENT_REVOKED",
    ] as const) {
      emitAccessAuditMetric({
        action,
        audited: false,
        subjectId: "u-1",
        actorId: "u-2",
        source: "test",
      });
    }

    expect(records).toHaveLength(5);
    for (const record of records) {
      const emf = record as unknown as EmfEnvelope;
      expect(emf._aws.CloudWatchMetrics[0].Namespace).toBe(
        "Praimana/AccessChanges"
      );
      expect(emf._aws.CloudWatchMetrics[0].Metrics[0].Name).toBe(
        "UnauditedAccessChanges"
      );
      expect(emf.UnauditedAccessChanges).toBe(1);
      // BOTH dimension sets on every action, including the fifth: the empty one is what the
      // alarm actually watches, so publishing only under {Action} would leave a new action
      // invisible to it — silently, and indistinguishably from a healthy platform.
      expect(emf._aws.CloudWatchMetrics[0].Dimensions).toEqual(
        expect.arrayContaining([[], ["Action"]])
      );
    }
    expect(records.map((r) => r.Action)).toEqual([
      "MEMBER_REMOVED",
      "MEMBER_RESTORED",
      "ACCESS_DISABLED",
      "ACCESS_ENABLED",
      "ENTITLEMENT_REVOKED",
    ]);
  });

  it("keeps `Action` a BOUNDED dimension — five values, not an unbounded set", () => {
    // The cardinality rule: a dimension multiplies into a separate metric per distinct value,
    // so `Action` is only legal while the set is closed. Asserted against the LITERAL list
    // rather than derived from the type, because a type cannot fail at runtime and the point is
    // that GROWING this set is a deliberate decision with a cost — every new value is a new
    // metric stream and a new line on the bill.
    //
    // If this fails, someone added an action: check it is genuinely an access change that writes
    // the audit trail, and that the count is still small enough to justify the dimension.
    const actions: AuditedAccessAction[] = [
      "MEMBER_REMOVED",
      "MEMBER_RESTORED",
      "ACCESS_DISABLED",
      "ACCESS_ENABLED",
      "ENTITLEMENT_REVOKED",
    ];
    expect(actions).toHaveLength(5);
    expect(new Set(actions).size).toBe(actions.length);
  });
});

describe("emitAccessAuditMetric", () => {
  it("emits 1 on an UNAUDITED change — the alarm's datapoint", () => {
    const { records } = captureEmf();

    emitAccessAuditMetric({
      action: "MEMBER_RESTORED",
      audited: false,
      subjectId: "victim",
      actorId: "fac",
      teamId: "t1",
      source: "team",
    });

    const emf = records[0] as unknown as EmfEnvelope;
    expect(emf.UnauditedAccessChanges).toBe(1);
    expect(emf.Action).toBe("MEMBER_RESTORED");
    expect(emf.subjectId).toBe("victim");
    expect(emf.actorId).toBe("fac");
    expect(emf.teamId).toBe("t1");
    // The greppable half of the runbook's step 2.
    expect(String(emf.event)).toContain("UNRECORDED");
  });

  it("emits 0 on the AUDITED path, so the metric exists in a healthy account", () => {
    // Without this datapoint "no data" and "no failures" are identical at the alarm, and a
    // deploy that broke the emission entirely would read as a permanently healthy platform.
    const { records } = captureEmf();

    emitAccessAuditMetric({
      action: "ACCESS_DISABLED",
      audited: true,
      subjectId: "victim",
      actorId: "admin",
      source: "user-access",
    });

    const emf = records[0] as unknown as EmfEnvelope;
    expect(emf.UnauditedAccessChanges).toBe(0);
    expect(emf.Action).toBe("ACCESS_DISABLED");
    // Still BOTH dimension sets on the success path: the alarm's aggregate is what needs
    // the zero, so emitting it only under {Action} would defeat the point.
    expect(emf._aws.CloudWatchMetrics[0].Dimensions).toEqual(
      expect.arrayContaining([[], ["Action"]])
    );
  });

  it("omits teamId entirely for a platform-wide change rather than carrying undefined", () => {
    // Absent must stay absent so a reader can tell "not a team action" from "team unknown".
    const { records } = captureEmf();

    emitAccessAuditMetric({
      action: "ACCESS_ENABLED",
      audited: false,
      subjectId: "victim",
      actorId: "admin",
      source: "user-access",
    });

    expect(records[0]).not.toHaveProperty("teamId");
  });

  it("carries NO email, NO reason text and NO PII — ids only", () => {
    // The cardinality rule plus the standing rule that the reason is operator free-text
    // which may name a person. Asserted on the SERIALISED line, because that is what
    // actually reaches CloudWatch.
    const { records } = captureEmf();

    emitAccessAuditMetric({
      action: "MEMBER_REMOVED",
      audited: false,
      subjectId: "victim",
      actorId: "fac",
      teamId: "t1",
      source: "team",
    });

    const line = JSON.stringify(records[0]);  // nosemgrep: no-stringify-keys
    expect(line).not.toContain("@");
    expect(line.toLowerCase()).not.toContain("email");
    expect(line.toLowerCase()).not.toContain("reason");
    // The Action dimension is the only dimension, so no id can be one.
    const emf = records[0] as unknown as EmfEnvelope;
    for (const set of emf._aws.CloudWatchMetrics[0].Dimensions) {
      expect(set.every((key) => key === "Action")).toBe(true);
    }
  });
});
