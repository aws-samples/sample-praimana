import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { backendFetch } from "@/lib/backend";
import {
  MAX_FEEDBACK_MESSAGE,
  MAX_FEEDBACK_SUBJECT,
  checkFeedbackField,
  type FeedbackField,
} from "@praimana/shared";

/**
 * ── FEEDBACK AND BUG REPORTS, the BFF over the identity service ──────────────────────────
 *
 * THE RULE: reports go in the database and staff are emailed from the backend, replacing
 * the `mailto:` links this router made redundant.
 *
 * ── ⚠ TWO AUDIENCES, TWO PATHS, AND THE SPLIT IS THE POINT ──
 *
 * `submit` calls `/v1/auth/feedback`: ANY signed-in person may file a report, and a PARTICIPANT hitting a
 * bug is the most important reporter there is. `list` and `acknowledge` call `/v1/admin/feedback`, whose
 * whole router is gated on `canManageUsers` (ADMIN + FACILITATOR) by middleware in the service.
 *
 * ⚠ NO CLIENT-SIDE AUTHORIZATION LIVES HERE. `protectedProcedure` proves a session; every rule about who
 * may read the inbox is the service's, checked against the token. A UI that hides the tab is a courtesy,
 * and the service refuses regardless.
 */

export type FeedbackReport = {
  id: string;
  kind: "BUG" | "FEEDBACK";
  status: "NEW" | "ACKNOWLEDGED";
  /** The one-line summary. May be "" on a row written before the field existed. */
  subject: string;
  message: string;
  reportedById: string;
  reportedByEmail: string;
  reportedByRole: string;
  surface: "portal" | "desktop";
  version: string | null;
  location: string | null;
  workshopId: string | null;
  teamId: string | null;
  /**
   * Resolved by the BFF for display, see `withNames`. NOT stored on the report, and `null` whenever the
   * lookup could not be made or the caller may not see that experience, which the inbox renders as the id.
   */
  workshopName?: string | null;
  teamName?: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedById: string | null;
};

/**
 * The word bounds as a zod refinement, so the field error a reporter sees is the shared sentence verbatim.
 *
 * `superRefine` rather than `refine` for one reason worth stating: the check runs ONCE and its result is
 * reused for the message. The `refine(check, messageFn)` form calls the validator a second time to build the
 * string, which is harmless today and is the kind of duplicate call that goes wrong the moment a validator
 * stops being pure.
 */
const bounded =
  (field: FeedbackField) =>
  (value: string, ctx: z.RefinementCtx): void => {
    const problem = checkFeedbackField(field, value);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem.message });
  };

/**
 * ── ⚠ NAMES FOR THE IDS ON A REPORT ────────────────────────────────────────────────────────
 *
 * Reports show experience and team NAMES rather than raw ids ("experience 01KZ… · team 01KZ…"),
 * and this is where that belongs. The reasoning matters more than the code:
 *
 * ── WHY NOT STORED ON THE REPORT ──
 *
 * The identity service records IDS ONLY, deliberately, it has no client for the workshop or team contexts,
 * so resolving a name at FILING time would mean a new east-west hop on a path that must not fail. A bug
 * report that cannot be filed because a name lookup timed out is a strictly worse product than one that
 * shows an id. (It would also snapshot the name, so a renamed experience would read wrong forever.)
 *
 * ── WHY THE BFF AND NOT THE COMPONENT ──
 *
 * ⚠ THE LOOKUPS RUN WITH THE CALLER'S OWN TOKEN, so authorization is not re-implemented anywhere: a
 * FACILITATOR sees names for the experiences THEY can see and ids for the rest, because `/v1/workshops`
 * already returns only what they may read. Resolving in the browser would have been the same number of
 * requests with the role logic copied into a component.
 *
 * ── ⚠ AND IT CANNOT FAIL THE INBOX ──
 *
 * Every lookup is wrapped: a failure leaves the name `null` and the screen falls back to the id. This is the
 * same distinction applied to a label, "I could not resolve this" is not "this does not exist", and
 * neither is a reason to refuse somebody the bug reports. An inbox that 500s because an experience lookup
 * was throttled would be a worse outage than the one it is there to help diagnose.
 *
 * ── ⚠ BY ID, NOT FROM `GET /v1/workshops`, AND THIS WAS MEASURED RATHER THAN REASONED ──
 *
 * The first version resolved every name from one `/v1/workshops` call. Against the running service it
 * returns ZERO workshops for a real ADMIN, so the feature would have shown a ULID in exactly the case it
 * exists for. The reason is in the workshop service: for ADMIN and FACILITATOR that route is
 * `listByOwner(callerId)`, the experiences you OWN, not the ones you can see. An administrator triaging a
 * report about somebody else's experience owns none of it.
 *
 * `GET /v1/workshops/:id` is the right source because its gate (`requireWorkshopRead`) admits
 * ADMIN → owner → member. In practice an ADMIN gets 200 and the name; a FACILITATOR who does not own it
 * gets 403, which lands here as `null` and renders as the id. That is the correct outcome, not a shortfall.
 *
 * ⚠ THE FAN-OUT IS BOUNDED, at two calls per DISTINCT experience (the name, and that experience's team
 * names), not per report. Fifty reports from one experience cost two requests; an empty inbox costs none.
 * Past MAX_EXPERIENCE_LOOKUPS the remaining experiences keep their ids rather than the page issuing an
 * unbounded fan-out. Nothing is hidden by that cap: an unresolved id still renders, which is the visible
 * signal that a name was not fetched.
 */
const MAX_EXPERIENCE_LOOKUPS = 8;

/** Never throws: a name is a nicety, and the caller has already decided the inbox must render. */
async function safely<T>(work: () => Promise<T>, onFailure: T): Promise<T> {
  try {
    return await work();
  } catch {
    return onFailure;
  }
}

async function withNames(items: FeedbackReport[], token?: string): Promise<FeedbackReport[]> {
  // Nothing to resolve ⇒ no requests at all. The commonest case is an empty inbox.
  const workshopIds = [...new Set(items.map((r) => r.workshopId).filter(Boolean))] as string[];
  const needsTeam = items.some((r) => r.teamId);
  if (workshopIds.length === 0 && !needsTeam) return items;

  const workshopNames = new Map<string, string>();
  const teamNames = new Map<string, string>();

  /**
   * Two lookups per experience, concurrently, capped.
   *
   * Team names come per experience because that is the route that exists, and it is gated the way the product
   * describes it: a facilitator may see that a team exists and what it is called, never its content.
   */
  await Promise.all(
    workshopIds.slice(0, MAX_EXPERIENCE_LOOKUPS).flatMap((id) => {
      const path = encodeURIComponent(id);
      return [
        safely(async () => {
          const data = await backendFetch(`/v1/workshops/${path}`, { token });
          const name = (data.workshop as { name?: unknown } | undefined)?.name;
          if (typeof name === "string" && name) workshopNames.set(id, name);
        }, undefined),
        safely(async () => {
          const data = await backendFetch(`/v1/workshops/${path}/teams`, { token });
          for (const t of (data.teams || []) as { id?: string; name?: string }[]) {
            if (t?.id && typeof t.name === "string") teamNames.set(t.id, t.name);
          }
        }, undefined),
      ];
    })
  );

  return items.map((report) => ({
    ...report,
    // `?? null` and never the id as a fallback: the COMPONENT decides how to present an unresolved id, and a
    // name field secretly holding a ULID is the kind of value that ends up in a sentence reading
    // "reported in 01KZVC9…".
    workshopName: (report.workshopId && workshopNames.get(report.workshopId)) || null,
    teamName: (report.teamId && teamNames.get(report.teamId)) || null,
  }));
}

export const feedbackRouter = router({
  /**
   * File a report.
   *
   * ⚠ THE BOUNDS ARE THE SHARED ONES, which is where the SERVICE reads them from too. These zod checks exist
   * so a too-short or over-long field fails instantly instead of costing a round trip, NOT so the client can
   * be trusted: the service refuses the identical input and its refusal is the real one.
   *
   * ⚠ `checkFeedbackField` RATHER THAN `.min(20, "words")` HAND-ROLLED IN ZOD, because zod counts characters
   * and the rule is in WORDS. A `.min()` on length would refuse a different set of inputs from the service -
   * the exact drift that makes a client-side check worse than none, since it would reject reports the API
   * would have taken.
   *
   * ⚠ NOTHING ABOUT *WHO* IS SENT. The service takes the reporter's id, email and role from the verified
   * token; a field here would be ignored at best and a spoofing surface at worst.
   */
  submit: protectedProcedure
    .input(
      z.object({
        kind: z.enum(["BUG", "FEEDBACK"]),
        subject: z.string().trim().max(MAX_FEEDBACK_SUBJECT).superRefine(bounded("subject")),
        message: z.string().trim().max(MAX_FEEDBACK_MESSAGE).superRefine(bounded("message")),
        /** Context the service records verbatim, bounded there as well. */
        surface: z.literal("portal").default("portal"),
        location: z.string().optional(),
        workshopId: z.string().optional(),
        teamId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch("/v1/auth/feedback", {
        method: "POST",
        body: JSON.stringify(input),
        token: ctx.token,
      });
      return data.report as FeedbackReport;
    }),

  /**
   * The inbox, newest first, with the number still unread.
   *
   * ⚠ `unreadCount` COMES FROM THE SERVICE, NOT FROM COUNTING `items`. Counting the page would report only
   * the unread reports ON IT, a badge reading "3" with fifty more behind the cursor.
   */
  list: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(100).optional(), cursor: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const params = new URLSearchParams();
      if (input?.limit) params.set("limit", String(input.limit));
      if (input?.cursor) params.set("cursor", input.cursor);
      const query = params.toString();
      const data = await backendFetch(`/v1/admin/feedback${query ? `?${query}` : ""}`, {
        token: ctx.token,
      });
      const items = (data.items || []) as FeedbackReport[];
      return {
        items: await withNames(items, ctx.token),
        nextCursor: (data.nextCursor ?? null) as string | null,
        unreadCount: (data.unreadCount ?? 0) as number,
      };
    }),

  /** Mark one report dealt with. Idempotent in the service, two admins clicking at once is normal. */
  acknowledge: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/admin/feedback/${encodeURIComponent(input.id)}/acknowledge`,
        { method: "POST", token: ctx.token }
      );
      return data.report as FeedbackReport;
    }),
});
