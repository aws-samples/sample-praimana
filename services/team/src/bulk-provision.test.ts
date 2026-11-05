// ── ENQUEUEING A BULK PROVISIONING JOB ───────────────────────────────────────────────────
//
// This route creates NOTHING — it answers "may you?" and publishes the plan. So the
// assertions worth having are the gate, the bounds, and one property that is easy to lose: the
// published event must carry an IDENTITY and never a credential.

import { describe, it, expect } from "vitest";
import { InMemoryPublisher } from "@praimana/service-shared";
import { createTeamRoutes } from "./routes";
import type { WorkshopAccess } from "./authz";
import type { BulkBatch, BulkBatchProgress } from "./bulk-batch";

const INTERNAL = "test-internal-token";
process.env.INTERNAL_SERVICE_TOKEN = INTERNAL;

function headers(role: string, email = "fac@example.com") {
  return {
    "content-type": "application/json",
    "x-internal-token": INTERNAL,
    "x-identity-id": "u-fac",
    "x-identity-email": email,
    "x-identity-role": role,
  };
}

/** Ownership answer is the only thing these tests vary in the workshop hop. */
class Workshops implements WorkshopAccess {
  probes = 0;
  constructor(private readonly owns: boolean) {}
  async teamSeatTemplate() {
    return 10 as const;
  }
  async ownsWorkshop() {
    this.probes++;
    return this.owns;
  }
  /**
   * Required by the interface but unreachable on this route — it resolves a workshop THROUGH a team,
   * and bulk provisioning names the workshop directly. Throws rather than returning false: a silent
   * `false` would make a future route that reaches it look correctly refused.
   */
  async ownsTeamWorkshop(): Promise<boolean> {
    throw new Error("ownsTeamWorkshop must not be reached by the bulk-provision route");
  }
}

const plan = (teams = 1, members = 1) => ({
  teams: Array.from({ length: teams }, (_, i) => ({
    teamKey: `t${i}`,
    teamName: `Team ${i}`,
    memberCount: 1,
  })),
  members: Array.from({ length: members }, (_, i) => ({
    line: i + 2,
    teamName: "Team 0",
    teamKey: "t0",
    email: `p${i}@example.com`,
    platformRole: "PARTICIPANT",
  })),
});

/**
 * The audit store, in memory.
 *
 * ⚠ THE ROUTE REFUSES WITHOUT ONE, so this is not optional scaffolding — it is the store the upload
 * is recorded in BEFORE the event is published, which is the order that makes a silently-failed
 * publish visible (the row stays `queued`). `failCreate` exercises the refusal.
 */
class Batches {
  readonly created: BulkBatch[] = [];
  readonly updates: Array<{ batchId: string; progress: BulkBatchProgress }> = [];
  failCreate = false;
  missing = false;

  async create(batch: BulkBatch) {
    if (this.failCreate) throw new Error("dynamo is unavailable");
    this.created.push(batch);
  }
  async update(_workshopId: string, batchId: string, progress: BulkBatchProgress) {
    this.updates.push({ batchId, progress });
    return !this.missing;
  }
  async listByWorkshop() {
    return this.created;
  }
}

function build(owns: boolean, opts: { batches?: Batches | null } = {}) {
  const events = new InMemoryPublisher();
  const workshops = new Workshops(owns);
  // `null` means "this environment has no audit store", which is a case the route must refuse.
  const batches = opts.batches === null ? undefined : (opts.batches ?? new Batches());
  // Only the deps this route touches need to be real; the rest are unused on this path.
  const app = createTeamRoutes({
    events,
    workshops,
    teams: { get: async () => null, listByWorkshop: async () => [], put: async (t: unknown) => t },
    members: {},
    invitations: {},
    users: {},
    audit: { write: async () => {} },
    workshopDirectory: { ownedWorkshopIds: async () => [] },
    bulkBatches: batches,
  } as never);
  return { app, events, workshops, batches: batches as Batches };
}

const post = (app: ReturnType<typeof build>["app"], body: unknown, role = "FACILITATOR") =>
  app.request("/v1/workshops/w1/bulk-provision", {
    method: "POST",
    headers: headers(role),
    body: JSON.stringify(body),
  });

describe("⚠ the gate is the same one that guards team creation", () => {
  /**
   * This job CREATES TEAMS, so "may you set up this experience?" must have exactly one answer. A
   * second spelling of the rule is how the two drift, and drift on this one grants a stranger the
   * ability to mint accounts.
   */
  it("403s a facilitator who does not own the experience", async () => {
    const { app, events } = build(false);
    const res = await post(app, { plan: plan() });

    expect(res.status).toBe(403);
    // Nothing queued: a refusal must not leave work in flight.
    expect(events.published).toHaveLength(0);
  });

  it("202s a facilitator who owns it", async () => {
    const { app } = build(true);
    expect((await post(app, { plan: plan() })).status).toBe(202);
  });

  /**
   * ⚠ AN ADMIN SHORT-CIRCUITS WITHOUT THE OWNERSHIP HOP. Not an optimisation — an ADMIN is
   * platform-wide by definition, and asking Workshop would make a global authority contingent on
   * another service being reachable.
   */
  it("202s an ADMIN without probing workshop ownership", async () => {
    const { app, workshops } = build(false);

    expect((await post(app, { plan: plan() }, "ADMIN")).status).toBe(202);
    expect(workshops.probes).toBe(0);
  });

  it.each(["PARTICIPANT", "EXECUTIVE", "JUDGE"])("403s a %s even if they own nothing", async (role) => {
    const { app } = build(false);
    expect((await post(app, { plan: plan() }, role)).status).toBe(403);
  });
});

describe("⚠ the plan is shape-checked HERE, because the BFF is not a boundary", () => {
  /**
   * Every route is `Method: ANY` behind an authorizer with no scoping and the browser holds its own
   * token, so a caller can reach this directly without passing through the portal. A malformed or
   * unbounded plan would otherwise be published to a queue and handed to a worker that creates
   * accounts — the last place to discover it is wrong.
   */
  it.each([
    ["no body at all", undefined],
    ["no plan", {}],
    ["teams not an array", { plan: { teams: "x", members: [] } }],
    ["members not an array", { plan: { teams: [], members: "x" } }],
  ])("400s %s", async (_label, body) => {
    const { app, events } = build(true);
    const res = await post(app, body);
    expect(res.status).toBe(400);
    expect(events.published).toHaveLength(0);
  });

  it("400s an empty plan rather than queuing a no-op", async () => {
    const { app } = build(true);
    expect((await post(app, { plan: { teams: [], members: [] } })).status).toBe(400);
  });

  /**
   * ⚠ THE CEILINGS ARE DUPLICATED FROM THE BFF ON PURPOSE. This Lambda is bundled without the
   * portal's modules, and a bound only the client enforces is not a bound at all.
   */
  it("400s a plan over the row ceiling", async () => {
    const { app, events } = build(true);
    const res = await post(app, { plan: plan(1, 81) });
    expect(res.status).toBe(400);
    expect(events.published).toHaveLength(0);
  });

  it("400s a plan over the team ceiling", async () => {
    const { app } = build(true);
    expect((await post(app, { plan: plan(21, 1) })).status).toBe(400);
  });

  it("accepts a plan exactly at both ceilings", async () => {
    // The boundary must pass, or the documented limit is a lie by one.
    const { app } = build(true);
    expect((await post(app, { plan: plan(20, 80) })).status).toBe(202);
  });
});

describe("⚠ the published event carries an IDENTITY, never a credential", () => {
  /**
   * THE MOST IMPORTANT ASSERTION IN THIS FILE.
   *
   * The worker must act with the caller's authority. The obvious way — forwarding their bearer —
   * would leave a live token at rest in the queue for up to 14 days, replayed on redrive and copied
   * into the DLQ. One `console.log` in a worker would then disclose it. The same rule refused exactly
   * this for the temporary password; it applies here too.
   *
   * So the worker gets an identity to ASSERT (with the internal service token), not a credential to
   * REPLAY.
   */
  it("publishes the identity and the plan, and no token", async () => {
    const { app, events } = build(true);
    await post(app, { plan: plan() });

    expect(events.published).toHaveLength(1);
    const e = events.published[0] as { type: string; detail: Record<string, unknown> };

    expect(e.type).toBe("bulk-provision.requested");
    expect(e.detail.requestedBy).toMatchObject({ id: "u-fac", role: "FACILITATOR" });
    expect(e.detail.workshopId).toBe("w1");
    expect(e.detail.batchId).toBeTruthy();

    /**
     * ⚠ AN EXACT KEY SET, NOT A LIST OF FORBIDDEN SUBSTRINGS — and the difference is the whole
     * value of this assertion.
     *
     * My first version sent a bearer and asserted the serialised event did not contain it. That was
     * UNFALSIFIABLE twice over: forwarding `c.req.header("authorization")` yields `undefined`, which
     * `JSON.stringify` silently drops, so the test passed on a route that would leak a real token;
     * and sending an actual Authorization header makes the edge middleware reject the request with
     * 401, so the test could not run at all. Both discovered by mutating the route to forward the
     * header and watching the suite stay green.
     *
     * A closed key set catches ANY addition — a bearer, a temporary password, a session cookie, an
     * internal token — including ones nobody thought to forbid by name.
     */
    expect(Object.keys(e.detail).sort()).toEqual([
      "batchId",
      "plan",
      "requestedBy",
      "workshopId",
    ]);
    expect(Object.keys(e.detail.requestedBy as object).sort()).toEqual(["email", "id", "role"]);

    const serialised = JSON.stringify(e);
    expect(serialised).not.toContain(INTERNAL);
    expect(serialised.toLowerCase()).not.toContain("password");
  });

  /**
   * ── ⚠ THE REQUESTER'S EMAIL MUST HAVE A VALUE, NOT JUST A KEY ────────────────────────
   *
   * The closed key set above passed while `email` was `""`, and that empty string cost a real
   * facilitator their report. The route read `c.req.header("x-identity-email")`, which exists ONLY on
   * the internal-hop path (path 3) — and every test in this file used exactly that path, because it
   * is the convenient one to fake. A facilitator uploading through the gateway arrives on path 1,
   * where the email is a verified CLAIM in the Lambda event and no such header exists.
   *
   * So the published event carried `email: ""`, the worker logged "no requester email — report NOT
   * sent", and the one promise the feature makes — "you can navigate away, we'll email you the
   * outcome" — was silently broken. On the same run the upload had also failed, so the person who
   * most needed that email got nothing at all.
   *
   * ⚠ THE LESSON IS ABOUT THE TEST, NOT THE ROUTE. A suite that exercises one auth path and asserts
   * the SHAPE of the result cannot see a field that is empty only on the other path. Hence both paths
   * below, both asserting the VALUE.
   */
  it("publishes the requester's email from the internal-hop headers", async () => {
    const { app, events } = build(true);
    await post(app, { plan: plan() });

    const e = events.published[0] as { detail: { requestedBy: { email: string } } };
    expect(e.detail.requestedBy.email).toBe("fac@example.com");
  });

  it("⚠ publishes the requester's email on the GATEWAY path, where there is no x-identity header", async () => {
    const { app, events } = build(true);

    // Path 1 exactly as the deployed gateway delivers it: claims in the Lambda EVENT, which a client
    // cannot inject — and NO x-identity-* headers, because nothing sets them on this path.
    const res = await app.request(
      "/v1/workshops/w1/bulk-provision",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: plan() }),
      },
      {
        requestContext: {
          authorizer: {
            jwt: {
              claims: {
                sub: "u-fac",
                email: "facilitator@example.com",
                "cognito:groups": ["FACILITATOR"],
              },
            },
          },
        },
      }
    );

    expect(res.status).toBe(202);

    const e = events.published[0] as { detail: { requestedBy: { email: string; id: string } } };
    // The assertion that was missing. An empty string here means nobody gets a report.
    expect(e.detail.requestedBy.email).toBe("facilitator@example.com");
    expect(e.detail.requestedBy.id).toBe("u-fac");
  });

  it("gives every batch its own id, so two uploads are distinguishable in the logs", async () => {
    const { app, events } = build(true);
    await post(app, { plan: plan() });
    await post(app, { plan: plan() });

    const ids = (events.published as Array<{ detail: { batchId: string } }>).map(
      (e) => e.detail.batchId
    );
    expect(new Set(ids).size).toBe(2);
  });

  it("returns the batch id so the operator can be told which run is theirs", async () => {
    const { app } = build(true);
    const body = await (await post(app, { plan: plan() })).json();
    expect(body).toMatchObject({ queued: true });
    expect(body.batchId).toBeTruthy();
  });
});

// ── THE AUDIT ROW ────────────────────────────────────────────────────────────────────────
//
// ⚠ THIS SECTION EXISTS BECAUSE "ACCEPTED" WAS THE LAST THING ANYONE EVER LEARNED ABOUT A BATCH.
//
// Making the work asynchronous bought the facilitator their time back and cost them all visibility.
// The first real upload proved the cost: every team was refused by a broken east-west hop, the
// requester's email was empty so no report could be sent, and the only trace was a line in a Lambda
// log group. The screen still said "Accepted", and would have said it forever.

describe("⚠ the upload is recorded BEFORE it is published", () => {
  /**
   * THE ORDER IS THE DESIGN. `EventBridgePublisher.publish` deliberately swallows its errors so a bus
   * hiccup never fails the originating write — so publish-then-record would let a silent publish
   * failure leave "accepted" on screen with nothing anywhere disagreeing. Recording first means the
   * row stays `queued` and the portal shows it as stalled, which is the ONLY way that becomes visible.
   */
  it("writes a queued row carrying what the file asked for", async () => {
    const { app, batches } = build(true);
    const body = await (await post(app, { plan: plan(3, 18) })).json();

    expect(batches.created).toHaveLength(1);
    const row = batches.created[0];
    expect(row.batchId).toBe(body.batchId);
    expect(row.status).toBe("queued");
    // What was ASKED for, recorded at accept time — "18 requested, 12 invited" is the sentence an
    // operator needs later, and a single mutable counter could not say it.
    expect(row.requested).toEqual({ teams: 3, members: 18 });
    expect(row.workshopId).toBe("w1");
    expect(row.createdAt).toBeTruthy();
  });

  it("records the uploader, because that is who the report is owed to", async () => {
    const { app, batches } = build(true);
    await post(app, { plan: plan() });

    expect(batches.created[0].requestedBy).toEqual({ id: "u-fac", email: "fac@example.com" });
  });

  it("records the row before publishing, not after", async () => {
    // Asserted through the refusal below rather than by spying on call order: if the write is
    // attempted second, a failing write cannot prevent the publish — and this is exactly that case.
    const batches = new Batches();
    batches.failCreate = true;
    const { app, events } = build(true, { batches });

    expect((await post(app, { plan: plan() })).status).toBe(503);
    // ⚠ NOTHING QUEUED. A job that creates accounts and sends email must not run unobservably.
    expect(events.published).toHaveLength(0);
  });

  /**
   * ⚠ AN ENVIRONMENT WITH THE FEATURE ON AND NO TABLE IS A DEPLOYMENT MISTAKE, NOT THE OPERATOR'S.
   * It refuses rather than proceeding, because the alternative is an upload nobody can observe.
   */
  it("503s when there is no audit store at all, and queues nothing", async () => {
    const { app, events } = build(true, { batches: null });

    expect((await post(app, { plan: plan() })).status).toBe(503);
    expect(events.published).toHaveLength(0);
  });

  it("does not record anything for a file it refuses", async () => {
    // A 403 must not leave an audit row implying an upload happened.
    const { app, batches } = build(false);

    expect((await post(app, { plan: plan() })).status).toBe(403);
    expect(batches.created).toHaveLength(0);
  });

  it("does not record anything for a plan that fails the shape check", async () => {
    const { app, batches } = build(true);

    expect((await post(app, { plan: { teams: [], members: [] } })).status).toBe(400);
    expect(batches.created).toHaveLength(0);
  });
});

describe("the audit trail is readable, under the SAME gate as the upload", () => {
  const list = (app: ReturnType<typeof build>["app"], role = "FACILITATOR") =>
    app.request("/v1/workshops/w1/bulk-provision/batches", { headers: headers(role) });

  /**
   * ⚠ THE ROW NAMES THE ADDRESSES OF EVERYONE IN SOMEBODY'S FILE, which is PII. So "may you read the
   * audit trail?" must have exactly the same answer as "may you upload one?" — not a laxer one on the
   * grounds that a read is harmless.
   */
  it("403s a facilitator who does not own the experience", async () => {
    expect((await list(build(false).app)).status).toBe(403);
  });

  it.each(["PARTICIPANT", "EXECUTIVE", "JUDGE"])("403s a %s", async (role) => {
    expect((await list(build(false).app, role)).status).toBe(403);
  });

  it("returns the owner's uploads", async () => {
    const { app } = build(true);
    await post(app, { plan: plan(2, 5) });

    const body = await (await list(app)).json();
    expect(body.batches).toHaveLength(1);
    expect(body.batches[0].requested).toEqual({ teams: 2, members: 5 });
  });

  /**
   * ⚠ AN EMPTY LIST, NOT A 503, WHEN THE FEATURE IS OFF — and the asymmetry with the accept path is
   * deliberate. There is nothing to show and nothing at risk: "no uploads yet" is TRUE of an
   * environment that cannot accept one. The accept path refuses because it would otherwise create
   * accounts unobservably; a read has no such consequence.
   */
  it("answers with an empty list rather than an error when the feature is off", async () => {
    const res = await list(build(true, { batches: null }).app);
    expect(res.status).toBe(200);
    expect((await res.json()).batches).toEqual([]);
  });
});

describe("⚠ the worker's progress reports are validated, not trusted", () => {
  const patch = (app: ReturnType<typeof build>["app"], batchId: string, body: unknown) =>
    app.request(`/v1/workshops/w1/bulk-provision/batches/${batchId}`, {
      method: "PATCH",
      headers: headers("FACILITATOR"),
      body: JSON.stringify(body),
    });

  it("advances a batch to a terminal status with its counts", async () => {
    const { app, batches } = build(true);
    const { batchId } = await (await post(app, { plan: plan() })).json();

    const res = await patch(app, batchId, {
      status: "completed_with_errors",
      completedAt: "2026-08-12T21:08:12.186Z",
      counts: { teamsCreated: 2, teamsMatched: 0, invited: 10, skipped: 0, failed: 3 },
      failures: [{ teamName: "Wakanda", reason: "the team was not created" }],
      reportSent: true,
    });

    expect(res.status).toBe(200);
    const applied = batches.updates.at(-1)!.progress;
    expect(applied.status).toBe("completed_with_errors");
    expect(applied.counts).toEqual({
      teamsCreated: 2,
      teamsMatched: 0,
      invited: 10,
      skipped: 0,
      failed: 3,
    });
    expect(applied.failures).toEqual([
      { teamName: "Wakanda", reason: "the team was not created" },
    ]);
  });

  it("rejects a status it does not recognise", async () => {
    // An allowlist, not a sanitiser: an unknown status stored on the row would render as an unknown
    // state in the UI and could not be reasoned about.
    const { app } = build(true);
    const { batchId } = await (await post(app, { plan: plan() })).json();

    expect((await patch(app, batchId, { status: "nearly-done" })).status).toBe(400);
  });

  it("ignores fields that are not part of the progress contract", async () => {
    /**
     * ⚠ THE UPDATE IS BUILT FROM AN ALLOWLIST, NOT FROM THE BODY'S KEYS. This body reaches a DynamoDB
     * write, so iterating whatever arrived would let a caller name an attribute nobody intended —
     * `requested`, `requestedBy`, or a field a future schema adds.
     */
    const { app, batches } = build(true);
    const { batchId } = await (await post(app, { plan: plan() })).json();

    await patch(app, batchId, {
      status: "completed",
      requested: { teams: 999, members: 999 },
      requestedBy: { id: "someone-else", email: "attacker@example.com" },
      workshopId: "another-workshop",
    });

    const applied = batches.updates.at(-1)!.progress as unknown as Record<string, unknown>;
    expect(Object.keys(applied).sort()).toEqual(["status"]);
  });

  it("404s a batch that does not exist, rather than creating one", async () => {
    // An upsert would MANUFACTURE an audit record for a batch nobody accepted — which is precisely
    // what a replayed DLQ event whose row was pruned would do.
    const batches = new Batches();
    batches.missing = true;
    const { app } = build(true, { batches });

    expect((await patch(app, "01KZNOSUCHBATCH", { status: "completed" })).status).toBe(404);
  });

  it("403s a caller who does not own the experience", async () => {
    // The worker asserts the uploading facilitator's identity, so it passes this gate exactly as they
    // would. There is no "internal" exemption to be abused.
    expect((await patch(build(false).app, "01KZBATCH", { status: "completed" })).status).toBe(403);
  });
});
