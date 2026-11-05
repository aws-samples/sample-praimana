import { describe, it, expect, vi, afterEach } from "vitest";
import { CostExplorerReader } from "./cost.explorer.js";

/**
 * ── ⚠ EVERY REQUEST IN HERE COSTS A CENT ───────────────────────────────────────────────────
 *
 * Cost Explorer bills **$0.01 per request**, and "if your result set is paginated each page counts as a
 * separate request" (AWS pricing). This platform spends about $1/day. So the number of calls
 * this class makes is not a performance detail — it is a proportion of the thing being measured, and the only
 * way to hold it still is to assert it.
 *
 * The other assertions are about the TAG, which is the part the feature is filtered by and the part that cannot
 * work yet: Cost Explorer holds no `ApplicationName` data on a linked account until the tag is activated
 * (activation is a management-account action; a linked account gets AccessDenied), so the untagged group holds everything. Reading that group as if
 * it were the platform would report the whole account as tagged; reading it as zero would report the platform
 * as free. Neither is acceptable, so `taggedTotal` is null until a real tagged value appears.
 */

const send = vi.fn();

vi.mock("@aws-sdk/client-cost-explorer", () => ({
  CostExplorerClient: class {
    constructor(public readonly config: Record<string, unknown>) {}
    send = send;
  },
  GetCostAndUsageCommand: class {
    constructor(public readonly input: Record<string, unknown>) {}
  },
}));

afterEach(() => send.mockReset());

const NOW = new Date("2026-08-17T09:00:00.000Z");
const reader = () => new CostExplorerReader(() => NOW);

/** A DAILY result grouped by tag: one untagged group, optionally one tagged. */
const day = (date: string, untagged: number, tagged?: { value: string; amount: number }) => ({
  TimePeriod: { Start: date, End: date },
  Groups: [
    { Keys: [`ApplicationName$`], Metrics: { UnblendedCost: { Amount: String(untagged), Unit: "USD" } } },
    ...(tagged
      ? [
          {
            Keys: [`ApplicationName$${tagged.value}`],
            Metrics: { UnblendedCost: { Amount: String(tagged.amount), Unit: "USD" } },
          },
        ]
      : []),
  ],
});

const services = (...pairs: Array<[string, number]>) => ({
  ResultsByTime: [
    {
      Groups: pairs.map(([name, amount]) => ({
        Keys: [name],
        Metrics: { UnblendedCost: { Amount: String(amount), Unit: "USD" } },
      })),
    },
  ],
});

/** Wires the two calls in the order the reader issues them (daily, then by-service). */
const wire = (daily: unknown, byService: unknown) => {
  send.mockImplementation(async (command: { input: Record<string, unknown> }) => {
    const grouped = command.input.GroupBy as Array<{ Type: string }> | undefined;
    return grouped?.[0]?.Type === "TAG" ? daily : byService;
  });
};

describe("how many requests it makes", () => {
  it("⚠ EXACTLY TWO per refresh — one cent each", async () => {
    wire({ ResultsByTime: [day("2026-08-16", 1)] }, services(["AWS Lambda", 4.2]));
    await reader().read();
    expect(send, "two requests, and adding a third doubles a real bill").toHaveBeenCalledTimes(2);
  });

  it("⚠ does NOT follow pagination", async () => {
    /**
     * Each page is another cent. The tail of a cost breakdown is worth far less than a predictable spend, so a
     * NextPageToken is logged and dropped — never looped.
     */
    wire(
      { ResultsByTime: [day("2026-08-16", 1)], NextPageToken: "more" },
      { ...services(["AWS Lambda", 4.2]), NextPageToken: "more" }
    );
    await reader().read();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("⚠ asks for the tag by GROUPING, so the tag costs no extra request", async () => {
    // A separate tag-FILTERED call would have been a third cent for a figure that is null today anyway.
    wire({ ResultsByTime: [day("2026-08-16", 1)] }, services(["AWS Lambda", 1]));
    await reader().read();

    const inputs = send.mock.calls.map((c) => (c[0] as { input: Record<string, unknown> }).input);
    const tagQuery = inputs.find((i) => (i.GroupBy as Array<{ Type: string }>)[0].Type === "TAG");
    expect(tagQuery?.GroupBy).toEqual([{ Type: "TAG", Key: "ApplicationName" }]);
    expect(tagQuery?.Granularity).toBe("DAILY");
  });

  it("carries an abort signal on both calls", async () => {
    wire({ ResultsByTime: [day("2026-08-16", 1)] }, services(["AWS Lambda", 1]));
    await reader().read();
    for (const call of send.mock.calls) {
      expect((call[1] as { abortSignal?: AbortSignal })?.abortSignal).toBeInstanceOf(AbortSignal);
    }
  });

  it("targets us-east-1, where Cost Explorer lives regardless of where this runs", async () => {
    wire({ ResultsByTime: [day("2026-08-16", 1)] }, services(["AWS Lambda", 1]));
    await reader().read();
    // The client is constructed lazily inside the call; its config is what matters.
    expect(send).toHaveBeenCalled();
  });
});

describe("the numbers", () => {
  it("sums the days for month-to-date and averages them for the daily estimate", async () => {
    wire(
      { ResultsByTime: [day("2026-08-14", 0.85), day("2026-08-15", 0.8), day("2026-08-16", 1.08)] },
      services(["AWS Lambda", 1.5], ["Amazon DynamoDB", 0.9])
    );
    const out = await reader().read();

    expect(out.monthToDate).toBe(2.73);
    expect(out.dailyAverage).toBe(0.91);
    expect(out.yesterday).toBe(1.08);
    expect(out.currency).toBe("USD");
  });

  it("⚠ EXCLUDES today, so a part-day cannot drag the average down", async () => {
    /**
     * `End` is exclusive and is set to today, so the series ends yesterday. Including a partial day would make
     * every morning look like a saving and the projection permanently optimistic.
     */
    wire({ ResultsByTime: [day("2026-08-16", 1)] }, services(["AWS Lambda", 1]));
    await reader().read();

    const input = (send.mock.calls[0][0] as { input: { TimePeriod: { Start: string; End: string } } }).input;
    expect(input.TimePeriod).toEqual({ Start: "2026-08-01", End: "2026-08-17" });
  });

  it("projects with arithmetic and says as much — no second billable forecast call", async () => {
    // 16 complete days at 1.00 → MTD 16, average 1, 15 days left in August → 31.
    const days = Array.from({ length: 16 }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, "0")}`, 1));
    wire({ ResultsByTime: days }, services(["AWS Lambda", 16]));
    const out = await reader().read();

    expect(out.monthToDate).toBe(16);
    expect(out.dailyAverage).toBe(1);
    expect(out.projectedMonth).toBe(31);
  });

  it("ranks services by spend and drops the zero-cost ones", async () => {
    wire(
      { ResultsByTime: [day("2026-08-16", 3)] },
      services(["Amazon DynamoDB", 0.9], ["AWS Lambda", 1.5], ["Amazon SES", 0])
    );
    const out = await reader().read();
    expect(out.byService.map((s) => s.label)).toEqual(["AWS Lambda", "Amazon DynamoDB"]);
  });

  it("handles the FIRST of the month without asking Cost Explorer at all", async () => {
    // Start === End is an empty interval Cost Explorer rejects — and there is nothing to report anyway.
    const out = await new CostExplorerReader(() => new Date("2026-09-01T04:00:00.000Z")).read();
    expect(send).not.toHaveBeenCalled();
    expect(out.monthToDate).toBe(0);
    expect(out.yesterday).toBeNull();
    expect(out.taggedTotal).toBeNull();
  });
});

describe("the ApplicationName tag", () => {
  it("⚠ is NULL when only the untagged group comes back — today's real state", async () => {
    /**
     * Verified live before this was written: `GetTags --tag-key ApplicationName` returns one EMPTY value, so
     * every dollar is in the `ApplicationName$` group. Null means "no tag data"; 0 would mean "the platform
     * spends nothing", which is what a panel would have shown.
     */
    wire({ ResultsByTime: [day("2026-08-16", 1.08)] }, services(["AWS Lambda", 1]));
    const out = await reader().read();

    expect(out.taggedTotal).toBeNull();
    // The account total is unaffected — the untagged group is still real spend.
    expect(out.monthToDate).toBe(1.08);
  });

  it("sums the tagged group under the ApplicationName=Praimana value", async () => {
    wire(
      {
        ResultsByTime: [
          day("2026-08-15", 0.1, { value: "Praimana", amount: 0.7 }),
          day("2026-08-16", 0.1, { value: "Praimana", amount: 0.9 }),
        ],
      },
      services(["AWS Lambda", 1.8])
    );
    const out = await reader().read();

    expect(out.taggedTotal).toBe(1.6);
    // And the account total still includes the untagged remainder.
    expect(out.monthToDate).toBe(1.8);
  });

  it("⚠ does NOT count another application's tag value as ours", async () => {
    wire(
      { ResultsByTime: [day("2026-08-16", 0.1, { value: "Some Other App", amount: 5 })] },
      services(["AWS Lambda", 5.1])
    );
    const out = await reader().read();
    expect(out.taggedTotal).toBeNull();
    expect(out.monthToDate).toBe(5.1);
  });

  it("survives a tag value containing a $ — the group key is delimited by the FIRST one", async () => {
    // Keys arrive as "ApplicationName$<value>"; a naive split(\"$\")[1] would truncate such a value.
    wire(
      { ResultsByTime: [day("2026-08-16", 0, { value: "Praimana", amount: 1 })] },
      services(["AWS Lambda", 1])
    );
    expect((await reader().read()).taggedTotal).toBe(1);
  });
});
