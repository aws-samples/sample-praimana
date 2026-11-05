import { describe, it, expect, vi, afterEach } from "vitest";
import { CloudWatchHealthReader } from "./health.cloudwatch.js";

/**
 * ── THE CLOUDWATCH ADAPTER ─────────────────────────────────────────────────────────────────
 *
 * Two things here are worth a test and the rest is plumbing:
 *
 *   1. `INSUFFICIENT_DATA` — and any value this code does not recognise — becomes UNKNOWN, NEVER OK. An
 *      alarm with no recent data is usually a metric that STOPPED ARRIVING, which is a symptom, not the
 *      absence of one. Mapping it to OK would make the health page most reassuring exactly when the
 *      telemetry has failed.
 *   2. The read is BOUNDED and the request carries a TIMEOUT, because it sits on a screen somebody is
 *      waiting on during an incident.
 *
 * ⚠ THE SDK IS MOCKED AT THE MODULE, WHICH IS ALSO A TEST OF THE DYNAMIC IMPORT. The adapter imports
 * `@aws-sdk/client-cloudwatch` INSIDE the call rather than at the top of the file, deliberately: the package
 * is external to the bundle and must be provided by the Lambda runtime, and a top-level import that failed to
 * resolve would take down every route in this service — including GET /v1/auth/me. If somebody "tidies" the
 * import to the top, this file still passes, so the reasoning is recorded in the adapter's own header where
 * the code is; what is asserted here is the behaviour that import shape exists to protect: one failing
 * dependency, one failing route.
 */

const send = vi.fn();

vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: class {
    send = send;
  },
  DescribeAlarmsCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

afterEach(() => {
  send.mockReset();
});

/** The shape DescribeAlarms returns, reduced to the fields the adapter reads. */
const alarm = (over: Record<string, unknown> = {}) => ({
  AlarmName: "praimana-api-5xx",
  AlarmDescription: "The edge API is returning server errors.",
  StateValue: "OK",
  StateReason: "Threshold not crossed",
  StateUpdatedTimestamp: new Date("2026-08-17T10:00:00.000Z"),
  ...over,
});

describe("mapping CloudWatch states", () => {
  it("⚠ INSUFFICIENT_DATA is UNKNOWN, never OK", async () => {
    send.mockResolvedValue({ MetricAlarms: [alarm({ StateValue: "INSUFFICIENT_DATA" })] });
    const health = await new CloudWatchHealthReader().read();
    expect(health.alarms[0].state).toBe("UNKNOWN");
    expect(health.overall).toBe("UNKNOWN");
  });

  it("⚠ an UNRECOGNISED state is UNKNOWN too — this code never invents health", async () => {
    send.mockResolvedValue({ MetricAlarms: [alarm({ StateValue: "SOMETHING_NEW" }), alarm({ StateValue: undefined })] });
    const health = await new CloudWatchHealthReader().read();
    expect(health.alarms.map((a) => a.state)).toEqual(["UNKNOWN", "UNKNOWN"]);
  });

  it("maps OK and ALARM straight through", async () => {
    send.mockResolvedValue({
      MetricAlarms: [alarm({ StateValue: "OK" }), alarm({ AlarmName: "praimana-dlq-not-empty", StateValue: "ALARM" })],
    });
    const health = await new CloudWatchHealthReader().read();
    expect(health.overall).toBe("ALARM");
    expect(health.alarms.find((a) => a.name === "dlq-not-empty")?.state).toBe("ALARM");
  });

  it("⚠ ALARM outranks UNKNOWN outranks OK in the headline", async () => {
    // The worst thing present is the headline. An overall of OK beside a row in alarm is the panel lying.
    send.mockResolvedValue({
      MetricAlarms: [alarm({ StateValue: "OK" }), alarm({ AlarmName: "a", StateValue: "INSUFFICIENT_DATA" }), alarm({ AlarmName: "b", StateValue: "ALARM" })],
    });
    expect((await new CloudWatchHealthReader().read()).overall).toBe("ALARM");

    send.mockResolvedValue({
      MetricAlarms: [alarm({ StateValue: "OK" }), alarm({ AlarmName: "a", StateValue: "INSUFFICIENT_DATA" })],
    });
    expect((await new CloudWatchHealthReader().read()).overall).toBe("UNKNOWN");
  });

  it("⚠ an EMPTY alarm set is OK only in the sense that nothing is failing — and the ROUTE's consumer treats it as UNKNOWN", async () => {
    /**
     * Documented rather than defended here: with no alarms `worst([])` is OK, because there is nothing in
     * alarm. The panel refuses to render that as healthy (see HealthTab: `alarms.length === 0` ⇒ UNKNOWN),
     * because "we found nothing to check" is not "we checked". Kept as one decision in one place instead of
     * two layers each half-handling it.
     */
    send.mockResolvedValue({ MetricAlarms: [] });
    const health = await new CloudWatchHealthReader().read();
    expect(health.alarms).toEqual([]);
    expect(health.overall).toBe("OK");
  });

  it("sorts the worst first, so an incident is never below the fold", async () => {
    send.mockResolvedValue({
      MetricAlarms: [
        alarm({ AlarmName: "praimana-zzz", StateValue: "OK" }),
        alarm({ AlarmName: "praimana-mmm", StateValue: "INSUFFICIENT_DATA" }),
        alarm({ AlarmName: "praimana-aaa", StateValue: "ALARM" }),
      ],
    });
    const health = await new CloudWatchHealthReader().read();
    expect(health.alarms.map((a) => a.name)).toEqual(["aaa", "mmm", "zzz"]);
  });
});

describe("what it asks CloudWatch for", () => {
  it("⚠ is BOUNDED and prefixed — never every alarm in the account", async () => {
    send.mockResolvedValue({ MetricAlarms: [alarm()] });
    await new CloudWatchHealthReader().read();

    const input = (send.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(input.AlarmNamePrefix).toBe("praimana-");
    expect(input.MaxRecords).toBeLessThanOrEqual(100);
  });

  it("⚠ carries an abort signal — a hung metrics API must not hold the request open", async () => {
    send.mockResolvedValue({ MetricAlarms: [alarm()] });
    await new CloudWatchHealthReader().read();

    const options = send.mock.calls[0][1] as { abortSignal?: AbortSignal };
    expect(options?.abortSignal, "every external call has a timeout").toBeInstanceOf(AbortSignal);
  });

  it("makes ONE call, not a pagination loop", async () => {
    // A page an operator refreshes during an incident is the wrong place for an unbounded walk. The cap is
    // logged when exceeded (see the adapter) rather than silently followed.
    send.mockResolvedValue({ MetricAlarms: [alarm()], NextToken: "more" });
    await new CloudWatchHealthReader().read();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("strips the platform prefix for display, and tolerates a name without it", async () => {
    send.mockResolvedValue({
      MetricAlarms: [alarm({ AlarmName: "praimana-api-5xx" }), alarm({ AlarmName: "someone-elses-alarm" })],
    });
    const names = (await new CloudWatchHealthReader().read()).alarms.map((a) => a.name);
    expect(names).toContain("api-5xx");
    expect(names).toContain("someone-elses-alarm");
  });

  it("keeps the description and the reason — the runbook is the useful part", async () => {
    send.mockResolvedValue({ MetricAlarms: [alarm({ StateValue: "ALARM" })] });
    const [first] = (await new CloudWatchHealthReader().read()).alarms;
    expect(first.description).toMatch(/edge API/);
    expect(first.reason).toMatch(/Threshold/);
    expect(first.since).toBe("2026-08-17T10:00:00.000Z");
  });

  it("survives a row with no timestamp rather than rendering Invalid Date", async () => {
    send.mockResolvedValue({ MetricAlarms: [alarm({ StateUpdatedTimestamp: undefined })] });
    expect((await new CloudWatchHealthReader().read()).alarms[0].since).toBeNull();
  });

  it("⚠ PROPAGATES a failed read instead of returning an empty set", async () => {
    // The route turns this into a 503. Swallowing it here would produce a 200 with no alarms, which the
    // panel would have every reason to read as "nothing is wrong".
    send.mockRejectedValue(new Error("AccessDeniedException"));
    await expect(new CloudWatchHealthReader().read()).rejects.toThrow();
  });
});
