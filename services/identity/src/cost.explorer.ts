import type { CostLine, CostReader, CostSnapshot } from "./domain.js";

/**
 * Reads spend from the Cost Explorer API.
 *
 * ── ⚠ EXACTLY TWO REQUESTS PER REFRESH, AND THE SHAPE IS CHOSEN TO KEEP IT THAT WAY ──
 *
 * Cost Explorer bills **$0.01 per request**, and each page of a paginated result counts as another one. So the
 * queries are designed to answer everything in two calls and to be too small to paginate:
 *
 *   1. DAILY for the month so far, GROUPED BY the ApplicationName TAG. One call yields the per-day series
 *      (hence the daily average and the month-to-date total, by summing groups) AND the tag split. Grouping
 *      rather than filtering is what makes the tag free: a filtered call would have been a third request and
 *      would return $0.00 today anyway.
 *   2. MONTHLY for the same period, GROUPED BY SERVICE — the "where is it going" breakdown, one row per
 *      service.
 *
 * ⚠ NO PAGINATION LOOP. Both results are ~20 rows. If a `NextPageToken` ever appears it is logged and ignored
 * rather than followed: following it silently doubles the bill, and the missing tail of a cost breakdown is
 * worth far less than a predictable spend.
 *
 * ── ⚠ THE TAG WILL READ ZERO UNTIL IT IS ACTIVATED, AND THAT IS NOT A BUG HERE ──
 *
 * `ce:GetTags --tag-key ApplicationName` returns a single EMPTY value on a linked account until the tag is
 * activated: Cost Explorer holds no tag data, because activating a cost allocation tag is a management-account
 * action (`ListCostAllocationTags` → AccessDenied from a linked account). Until that is done, every dollar
 * lands in the untagged group, `taggedTotal` is null, and the surface says it is showing the ACCOUNT total.
 *
 * Both the old and new tag values are accepted, because the value was renamed and a
 * single-value match would put a permanent gap in the series at the rename.
 *
 * ── ⚠ DYNAMIC IMPORT, SAME REASON AS THE HEALTH READER ──
 *
 * `@aws-sdk/client-cost-explorer` is external to the bundle and must come from the runtime. A top-level import
 * that failed to resolve would take down every route in this service, including `GET /v1/auth/me`. Imported
 * inside the call, the worst case is this one route answering 503.
 */

/** Accepted values for the platform's ApplicationName tag. */
const TAG_KEY = "ApplicationName";
const TAG_VALUES = ["Praimana"];

/** The read sits on a screen somebody is waiting for. */
const TIMEOUT_MS = 8_000;

type Group = { Keys?: string[]; Metrics?: Record<string, { Amount?: string; Unit?: string }> };
type ByTime = {
  TimePeriod?: { Start?: string; End?: string };
  Total?: Record<string, { Amount?: string; Unit?: string }>;
  Groups?: Group[];
};
type CostOutput = { ResultsByTime?: ByTime[]; NextPageToken?: string };
type ClientLike = {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<CostOutput>;
};

const METRIC = "UnblendedCost";

const amountOf = (metrics: Record<string, { Amount?: string }> | undefined): number => {
  const raw = metrics?.[METRIC]?.Amount;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : 0;
};

/** `2026-08-17` for a Date, in UTC — Cost Explorer takes dates, not instants. */
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

const round = (n: number): number => Math.round(n * 100) / 100;

export class CostExplorerReader implements CostReader {
  private client: ClientLike | null = null;
  private command: (new (input: unknown) => unknown) | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async read(): Promise<CostSnapshot> {
    const { client, command: Command } = await this.aws();
    const today = this.now();

    /**
     * ⚠ `End` IS EXCLUSIVE, so passing today gives the month up to and including YESTERDAY. Today's partial
     * spend is deliberately excluded: a part-day is always low, and including it would drag the daily average
     * down and make every morning look like a saving.
     */
    const start = `${isoDay(today).slice(0, 7)}-01`;
    const end = isoDay(today);

    // Guard the first of the month, where start === end and Cost Explorer rejects an empty interval.
    if (start === end) {
      return {
        currency: "USD",
        monthToDate: 0,
        dailyAverage: 0,
        yesterday: null,
        projectedMonth: 0,
        byService: [],
        daily: [],
        taggedTotal: null,
        asOf: today.toISOString(),
      };
    }

    const period = { Start: start, End: end };
    const signal = () => ({ abortSignal: AbortSignal.timeout(TIMEOUT_MS) });

    const [byDay, byService] = await Promise.all([
      client.send(
        new Command({
          TimePeriod: period,
          Granularity: "DAILY",
          Metrics: [METRIC],
          GroupBy: [{ Type: "TAG", Key: TAG_KEY }],
        }),
        signal()
      ),
      client.send(
        new Command({
          TimePeriod: period,
          Granularity: "MONTHLY",
          Metrics: [METRIC],
          GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        }),
        signal()
      ),
    ]);

    for (const [name, res] of [["daily", byDay], ["service", byService]] as const) {
      if (res.NextPageToken) {
        // Logged, never followed — see the header.
        console.warn("[identity] cost query paginated; the tail is ignored to keep the bill fixed", {
          query: name,
        });
      }
    }

    const daily: CostLine[] = [];
    let taggedTotal = 0;
    let sawTaggedData = false;
    let currency = "USD";

    for (const day of byDay.ResultsByTime ?? []) {
      let dayTotal = 0;
      for (const group of day.Groups ?? []) {
        const amount = amountOf(group.Metrics);
        dayTotal += amount;
        currency = group.Metrics?.[METRIC]?.Unit ?? currency;

        /**
         * A TAG group key arrives as "ApplicationName$<value>" — and "ApplicationName$" (empty suffix) is the
         * UNTAGGED bucket, which is where every dollar sits until the tag is activated. Matching the empty
         * value as if it were the platform would report the whole account as tagged, which is the false
         * precision this whole design is trying to avoid.
         */
        const value = (group.Keys?.[0] ?? "").split("$").slice(1).join("$");
        if (value && TAG_VALUES.includes(value)) {
          taggedTotal += amount;
          sawTaggedData = true;
        }
      }
      daily.push({ label: day.TimePeriod?.Start ?? "", amount: round(dayTotal) });
    }

    const monthToDate = daily.reduce((sum, d) => sum + d.amount, 0);
    const dailyAverage = daily.length ? monthToDate / daily.length : 0;

    /**
     * Days left in the calendar month, counting today as still to come — `end` excluded yesterday, so today's
     * spend is part of the projection rather than of the actual.
     */
    const daysInMonth = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)
    ).getUTCDate();
    const remaining = Math.max(0, daysInMonth - daily.length);

    return {
      currency,
      monthToDate: round(monthToDate),
      dailyAverage: round(dailyAverage),
      yesterday: daily.length ? daily[daily.length - 1].amount : null,
      projectedMonth: round(monthToDate + dailyAverage * remaining),
      byService: (byService.ResultsByTime?.[0]?.Groups ?? [])
        .map((g) => ({ label: g.Keys?.[0] ?? "unknown", amount: round(amountOf(g.Metrics)) }))
        .filter((line) => line.amount > 0)
        .sort((a, b) => b.amount - a.amount),
      daily,
      // NULL, not 0, when Cost Explorer returned no tagged data at all — "unknown" is not "nothing".
      taggedTotal: sawTaggedData ? round(taggedTotal) : null,
      asOf: today.toISOString(),
    };
  }

  private async aws(): Promise<{ client: ClientLike; command: new (input: unknown) => unknown }> {
    if (!this.client || !this.command) {
      const mod = (await import("@aws-sdk/client-cost-explorer")) as unknown as {
        CostExplorerClient: new (config: Record<string, unknown>) => ClientLike;
        GetCostAndUsageCommand: new (input: unknown) => unknown;
      };
      // Cost Explorer is a global service reached through us-east-1 regardless of where this runs.
      this.client = new mod.CostExplorerClient({ region: "us-east-1" });
      this.command = mod.GetCostAndUsageCommand;
    }
    return { client: this.client, command: this.command };
  }
}
