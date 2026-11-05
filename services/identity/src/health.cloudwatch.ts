import type {
  HealthAlarm,
  HealthState,
  PlatformHealth,
  PlatformHealthReader,
} from "./domain.js";

/**
 * Reads platform health from CloudWatch alarm states.
 *
 * ── ⚠ THE IMPORT IS DYNAMIC, AND THAT IS A BLAST-RADIUS DECISION, NOT A STYLE ONE ──
 *
 * `@aws-sdk/client-cloudwatch` is marked EXTERNAL by the esbuild command in package.json — every
 * `@aws-sdk/*` is — so it is not in the bundle and must be provided by the Lambda runtime. The evidence that
 * it will be: `notify` declares `@aws-sdk/client-sesv2` the same way and demonstrably sends mail in
 * production, and `docs` does the same with `client-s3`. So a core v3 client resolves on nodejs22.x.
 *
 * ⚠ BUT "demonstrably, for two other clients" IS NOT "verified, for this one", and a TOP-LEVEL import that
 * fails takes down the WHOLE FUNCTION — including `GET /v1/auth/me`, which every signed-in page calls. The
 * cost of being wrong would be the platform's profile endpoint, to add a status panel. Imported inside the
 * call instead, so the worst case is this one route answering 503 while everything else is untouched.
 *
 * Cached after the first success: a dynamic import is memoised by the module system anyway, and holding the
 * client keeps the connection pool warm across invocations in the same execution environment.
 *
 * ── ⚠ BOUNDED, AND SINGLE-PAGE ON PURPOSE ──
 *
 * One `DescribeAlarms` with the platform's name prefix and a hard `MaxRecords`. No pagination loop: there are
 * twelve alarms, a status panel does not need the thirteenth-through-hundredth, and an unbounded loop on a
 * page an operator refreshes during an incident is the wrong shape. If the platform ever exceeds the cap the
 * route says so rather than silently showing a prefix of the truth.
 */
const ALARM_PREFIX = "praimana-";
const MAX_ALARMS = 100;
/** The read is on a screen somebody is waiting for; a hung metrics API must not hold the request open. */
const TIMEOUT_MS = 4_000;

type DescribeAlarmsOutput = {
  MetricAlarms?: Array<{
    AlarmName?: string;
    AlarmDescription?: string;
    StateValue?: string;
    StateReason?: string;
    StateUpdatedTimestamp?: Date | string;
  }>;
  NextToken?: string;
};

type CloudWatchLike = {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<DescribeAlarmsOutput>;
};

/**
 * CloudWatch's state values, mapped onto ours.
 *
 * ⚠ `INSUFFICIENT_DATA` BECOMES `UNKNOWN`, NEVER `OK`. It means the alarm has no recent data to judge — often
 * because the metric stopped being published, which is a symptom rather than the absence of one. An
 * unrecognised value lands in the same bucket for the same reason: this function must never invent health.
 */
function toState(value: string | undefined): HealthState {
  if (value === "OK") return "OK";
  if (value === "ALARM") return "ALARM";
  return "UNKNOWN";
}

/** ALARM beats UNKNOWN beats OK — the worst thing present is the headline. */
function worst(states: HealthState[]): HealthState {
  if (states.includes("ALARM")) return "ALARM";
  if (states.includes("UNKNOWN")) return "UNKNOWN";
  return "OK";
}

export class CloudWatchHealthReader implements PlatformHealthReader {
  private client: CloudWatchLike | null = null;
  private command: (new (input: unknown) => unknown) | null = null;

  async read(): Promise<PlatformHealth> {
    const { client, command: Command } = await this.aws();

    const res = await client.send(
      new Command({ AlarmNamePrefix: ALARM_PREFIX, MaxRecords: MAX_ALARMS }),
      { abortSignal: AbortSignal.timeout(TIMEOUT_MS) }
    );

    const alarms: HealthAlarm[] = (res.MetricAlarms ?? [])
      .filter((a) => typeof a.AlarmName === "string")
      .map((a) => {
        const stamp = a.StateUpdatedTimestamp;
        return {
          // The prefix is on every alarm, so repeating it twelve times is twelve times the noise and no
          // information. Kept in the reason/description if CloudWatch put it there.
          name: a.AlarmName!.startsWith(ALARM_PREFIX)
            ? a.AlarmName!.slice(ALARM_PREFIX.length)
            : a.AlarmName!,
          state: toState(a.StateValue),
          description: a.AlarmDescription ?? "",
          reason: a.StateReason ?? "",
          since:
            stamp instanceof Date
              ? stamp.toISOString()
              : typeof stamp === "string"
                ? stamp
                : null,
        };
      })
      // Worst first: during an incident the thing that is wrong must not be below the fold.
      .sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));

    if (res.NextToken) {
      // Not thrown, not hidden: the panel is still useful, and the log is where "we capped it" belongs.
      console.warn("[identity] platform health: more alarms than one page", { cap: MAX_ALARMS });
    }

    return {
      overall: worst(alarms.map((a) => a.state)),
      alarms,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Load the SDK and build the client, once.
   *
   * The failure is deliberately left to propagate — the route turns it into a 503 saying the check could not
   * be made, which is the honest answer and the one thing a health page must never get wrong.
   */
  private async aws(): Promise<{ client: CloudWatchLike; command: new (input: unknown) => unknown }> {
    if (!this.client || !this.command) {
      const mod = (await import("@aws-sdk/client-cloudwatch")) as unknown as {
        CloudWatchClient: new (config: Record<string, unknown>) => CloudWatchLike;
        DescribeAlarmsCommand: new (input: unknown) => unknown;
      };
      this.client = new mod.CloudWatchClient({});
      this.command = mod.DescribeAlarmsCommand;
    }
    return { client: this.client, command: this.command };
  }
}

/** ALARM (0) sorts above UNKNOWN (1) above OK (2). */
function rank(state: HealthState): number {
  return state === "ALARM" ? 0 : state === "UNKNOWN" ? 1 : 2;
}
