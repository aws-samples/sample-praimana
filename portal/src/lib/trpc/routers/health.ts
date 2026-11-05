import { router, protectedProcedure } from "../trpc";
import { backendFetch } from "@/lib/backend";

/**
 * ── PLATFORM HEALTH, the BFF over the identity service's admin router ─────────────────────
 *
 * A read-only platform health tab in Administration, visible only to admins and facilitators.
 *
 * ⚠ NO CLIENT-SIDE AUTHORIZATION LIVES HERE, and none is needed. `protectedProcedure` proves a session; the
 * rule about WHO may read health is the service's `/v1/admin` middleware (ADMIN + FACILITATOR), checked
 * against the token. The `/admin` route gate hides the page from other roles as a courtesy, and the service
 * refuses regardless, which is the same division of labour as the feedback inbox next to it.
 *
 * ⚠ AND THE ERROR IS NOT SWALLOWED. `backendFetch` throws on a 503, and this deliberately lets it: the panel
 * must be able to distinguish "the platform is healthy" from "the health check did not run", and the only way
 * to get that wrong is to catch the failure and return an empty-but-successful shape. A status page that goes
 * quiet during an incident is worse than one that says it cannot tell.
 */

export type HealthState = "OK" | "ALARM" | "UNKNOWN";

export type HealthAlarm = {
  name: string;
  state: HealthState;
  description: string;
  reason: string;
  since: string | null;
};

export type PlatformHealth = {
  overall: HealthState;
  alarms: HealthAlarm[];
  checkedAt: string;
};

export const healthRouter = router({
  platform: protectedProcedure.query(async ({ ctx }) => {
    const data = await backendFetch("/v1/admin/platform-health", { token: ctx.token });
    return {
      // `?? "UNKNOWN"` rather than `?? "OK"`: a response this client cannot read must never present as
      // healthy. Every fallback in this file leans the same way.
      overall: (data.overall ?? "UNKNOWN") as HealthState,
      alarms: (data.alarms ?? []) as HealthAlarm[],
      checkedAt: (data.checkedAt ?? "") as string,
    } satisfies PlatformHealth;
  }),
});

/**
 * ── WHAT THE PLATFORM COSTS TO RUN, ADMIN ONLY ────────────────────────────────────────────
 *
 * Estimated daily and overall spend, for admins only, based on the ApplicationName tag.
 *
 * ⚠ NO ROLE CHECK HERE, AND THAT IS CORRECT. `protectedProcedure` proves a session; the ADMIN-only rule is
 * the service's, checked against the token by `canSeePlatformSpend` on the route. The tab is hidden from a
 * facilitator as a courtesy, the service refuses them regardless, which is the only check that matters.
 *
 * ⚠ AND THE ERROR IS NOT CAUGHT. A 503 must reach the panel as a 503: "$0.00" is a plausible, wrong number
 * that reads as good news, and a catch returning zeros is how a cost page becomes actively misleading.
 */

export type CostLine = { label: string; amount: number };

export type CostSnapshot = {
  currency: string;
  monthToDate: number;
  dailyAverage: number;
  yesterday: number | null;
  projectedMonth: number;
  byService: CostLine[];
  daily: CostLine[];
  /** Null when Cost Explorer holds no tag data, see the panel, which explains rather than showing 0. */
  taggedTotal: number | null;
  asOf: string;
};

export const costRouter = router({
  platform: protectedProcedure.query(async ({ ctx }) => {
    const data = await backendFetch("/v1/admin/cost", { token: ctx.token });
    return {
      currency: (data.currency ?? "USD") as string,
      monthToDate: Number(data.monthToDate ?? 0),
      dailyAverage: Number(data.dailyAverage ?? 0),
      yesterday: data.yesterday === null || data.yesterday === undefined ? null : Number(data.yesterday),
      projectedMonth: Number(data.projectedMonth ?? 0),
      byService: (data.byService ?? []) as CostLine[],
      daily: (data.daily ?? []) as CostLine[],
      // `?? null` and never `?? 0`: "we have no tag data" must not render as "the tagged spend is nothing".
      taggedTotal: data.taggedTotal === null || data.taggedTotal === undefined ? null : Number(data.taggedTotal),
      asOf: (data.asOf ?? "") as string,
    } satisfies CostSnapshot;
  }),
});
