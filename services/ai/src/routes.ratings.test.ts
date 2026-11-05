import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAiRoutes } from "./routes.js";
import {
  IDENTITY_HEADERS,
  INTERNAL_TOKEN_HEADER,
} from "@praimana/service-shared";
import type {
  AiMessage,
  AiThread,
  KnowledgeModelInput,
  MessageRepository,
  RatingAnalyst,
  SummaryModelInput,
  TeamAiRatingRepository,
  TeamAiRatingSnapshot,
  TeamChatReader,
  TeamCountersReader,
  TeamWorkshopLookup,
  ThreadRepository,
  UsersReadModel,
} from "./domain.js";
import { GENERATION_LEASE_MS } from "./domain.js";
import type { TeamAccess, WorkshopEntitlements } from "./authz.js";
import { isReadOnlyRole } from "./authz.js";
// The SAME constants the Bedrock adapter sends — asserting on a local copy of the prose would
// test that this file agrees with itself. See ratings-prompts.ts.
import { KNOWLEDGE_SYSTEM, SUMMARY_SYSTEM } from "./ratings-prompts.js";

/**
 * TWO MODEL CALLS, TWO AUDIENCES — and the tests that keep them apart.
 *
 * The design rests on one invariant: the PUBLISHABLE output (the team summary) is generated
 * from five integers per member, and members' MESSAGE TEXT never enters that call. That is
 * what makes it safe for a judge to read — not a prompt instruction, because instruction
 * following is probabilistic and authorization cannot be.
 *
 * So the highest-value assertion in this file is negative: whatever reached the summary call
 * contains no message text and no names. It is asserted on the RECORDED INPUT of an injected
 * fake, which is the only place that fact is observable.
 *
 * Audience rules:
 *   members (including an EXECUTIVE on the team) → per-member assessments AND the summary
 *   executive NOT on the team, judge, facilitator → the PUBLISHED summary only
 */

const INTERNAL_TOKEN = "test-internal-token";
beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
});

function asUser(id: string, role = "PARTICIPANT") {
  return {
    "content-type": "application/json",
    [INTERNAL_TOKEN_HEADER]: INTERNAL_TOKEN,
    [IDENTITY_HEADERS.id]: id,
    [IDENTITY_HEADERS.email]: `${id}@example.com`,
    [IDENTITY_HEADERS.role]: role,
  };
}

const thread: AiThread = {
  teamId: "team-1",
  id: "t1",
  title: null,
  phaseContext: null,
  aiProvider: null,
  createdById: "alice",
  createdAt: "2026-08-08T09:00:00.000Z",
  updatedAt: "2026-08-08T09:00:00.000Z",
};

/** A private sentence that must NEVER appear in the summary call's payload. */
const SECRET = "our pricing model is broken and legal is worried";

const AI_MESSAGES: AiMessage[] = [
  {
    threadId: "t1",
    id: "m1",
    role: "user",
    content: SECRET,
    createdAt: "2026-08-08T09:01:00.000Z",
    userId: "alice",
  },
];

class FakeThreads implements ThreadRepository {
  async get() {
    return thread;
  }
  async getById() {
    return thread;
  }
  async listByTeam() {
    return [thread];
  }
  async touch(): Promise<void> {}

  async put(t: AiThread) {
    return t;
  }
}

class FakeMessages implements MessageRepository {
  async listByThread() {
    return AI_MESSAGES;
  }
  async listByThreadSince(_threadId: string, since: string) {
    return AI_MESSAGES.filter((m) => m.createdAt > since);
  }
  async listByThreadPage(_threadId: string, opts: { limit: number; before?: string }) {
    const older = opts.before ? AI_MESSAGES.filter((m) => m.createdAt < opts.before!) : AI_MESSAGES;
    const sorted = [...older].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const messages = sorted.slice(Math.max(0, sorted.length - opts.limit));
    const nextBefore = sorted.length > opts.limit && messages.length > 0 ? messages[0].createdAt : null;
    return { messages, nextBefore };
  }
  async put(m: AiMessage) {
    return m;
  }
}

/** Membership only — mirrors the real `canReadTeamContent`, which ignores `role`. */
class Access implements TeamAccess {
  constructor(
    private readonly isMember: boolean,
    private readonly isAdminScope = false
  ) {}
  async canRead() {
    return this.isAdminScope;
  }
  async canWrite() {
    return this.isAdminScope;
  }
  async canReadContent() {
    return this.isMember;
  }
  async canWriteContent() {
    return this.isMember;
  }
}

const users: UsersReadModel = {
  get: async (id: string) => ({ id, name: id === "alice" ? "Alice Smith" : "Bob Jones" }),
  upsert: async () => {},
  delete: async () => {},
};

class FakeRatings implements TeamAiRatingRepository {
  rows: TeamAiRatingSnapshot[] = [];
  async latest(teamId: string) {
    return [...this.rows].reverse().find((r) => r.teamId === teamId) ?? null;
  }
  async put(s: TeamAiRatingSnapshot) {
    this.rows.push(s);
    return s;
  }
  async publish(teamId: string, generationId: string, publishedById: string) {
    const newest = await this.latest(teamId);
    if (!newest || newest.generationId !== generationId) return null;
    newest.publishedAt = "2026-08-08T10:00:00.000Z";
    newest.publishedById = publishedById;
    return newest;
  }

  /**
   * THE GENERATION LEASE, modelled with the same semantics the conditional write has — free when
   * unheld OR when the holder's lease has lapsed.
   *
   * ⚠ A FAKE CANNOT PROVE THE CONDITIONAL WRITE IS ATOMIC. That is a DynamoDB property, and the
   * lesson this repository has already learned the hard way (an illegal `NOT begins_with`, a
   * rejected `temperature`) is that fakes verify logic and not external legality. What this DOES
   * verify is the route's use of the port: that a refused claim short-circuits before any model
   * call, that the lease is released on every exit path, and that a lapsed lease is reclaimable.
   * The atomicity is asserted against the real table by the probe in the deploy notes.
   */
  claims = new Map<string, { by: string; expiresAtMs: number }>();
  claimCalls = 0;
  releaseCalls = 0;
  /** Set to make `releaseGeneration` throw, proving a failed release cannot fail the request. */
  releaseThrows = false;

  async claimGeneration(teamId: string, actorId: string, now: number) {
    this.claimCalls += 1;
    const held = this.claims.get(teamId);
    if (held && held.expiresAtMs > now) return false;
    this.claims.set(teamId, { by: actorId, expiresAtMs: now + GENERATION_LEASE_MS });
    return true;
  }

  async releaseGeneration(teamId: string) {
    this.releaseCalls += 1;
    // Mirrors the real adapter, which logs and swallows: the caller must not see a 500 because a
    // delete failed after the analysis was already stored.
    if (this.releaseThrows) return;
    this.claims.delete(teamId);
  }
}

/**
 * Records what each model call RECEIVED. That recording is the point of the file: it is the
 * only way to assert that no message text reached the publishable call.
 */
class SpyAnalyst implements RatingAnalyst {
  knowledgeInputs: KnowledgeModelInput[] = [];
  summaryInputs: SummaryModelInput[] = [];
  constructor(private readonly summary = "The team worked steadily across the build phase.") {}
  /** ONE member per call now — the route loops, so this records one input per member. */
  async assessKnowledge(input: KnowledgeModelInput) {
    this.knowledgeInputs.push(input);
    return {
      handle: input.handle,
      aiKnowledgeScore: 72,
      rationale: "Iterates on prompts rather than restating them.",
      strengths: ["gives the assistant context"],
      improvements: ["ask for alternatives before accepting the first answer"],
    };
  }
  async summariseTeam(input: SummaryModelInput) {
    this.summaryInputs.push(input);
    return this.summary;
  }
}

/** Throws if touched — proves a route never invokes a model. */
const forbiddenAnalyst = {
  assessKnowledge: async () => {
    throw new Error("model must not be invoked");
  },
  summariseTeam: async () => {
    throw new Error("model must not be invoked");
  },
} as unknown as RatingAnalyst;

const chat: TeamChatReader = {
  recentByTeam: async () => [{ userId: "alice", content: "I'll take the auth ticket" }],
};

const counters: TeamCountersReader = {
  byTeam: async () => [
    {
      userId: "alice",
      tasksCreated: 4,
      tasksCompleted: 12,
      messagesSent: 88,
      commitsPushed: 21,
      aiThreadsShared: 3,
      aiTurns: 3,
    },
  ],
};

const workshops: TeamWorkshopLookup = { workshopIdForTeam: async () => "ws-1" };

/** A judge entitled to ws-1 — the workshop the snapshot records. */
const entitlements: WorkshopEntitlements = {
  listEntitledWorkshopIds: async () => ({ workshopIds: ["ws-1"], truncated: false }),
};

function build(
  opts: {
    isMember?: boolean;
    isAdminScope?: boolean;
    analyst?: RatingAnalyst;
    ratings?: FakeRatings;
    chat?: TeamChatReader;
    counters?: TeamCountersReader;
    entitlements?: WorkshopEntitlements;
    wired?: boolean;
  } = {}
) {
  const ratings = opts.ratings ?? new FakeRatings();
  const analyst = opts.analyst ?? new SpyAnalyst();
  const wired = opts.wired !== false;
  const app = createAiRoutes({
    threads: new FakeThreads(),
    messages: new FakeMessages(),
    users,
    teamAccess: new Access(opts.isMember ?? true, opts.isAdminScope ?? false),
    events: { publish: async () => {} },
    ...(wired
      ? {
          ratings,
          analyst,
          teamChat: opts.chat ?? chat,
          counters: opts.counters ?? counters,
          workshops,
          entitlements: opts.entitlements ?? entitlements,
        }
      : {}),
  });
  return { app, ratings, analyst: analyst as SpyAnalyst };
}

/**
 * THE DEFAULT CALLER FOR `analyze` IS AN EXECUTIVE MEMBER, on the rule that
 * generating an assessment is an executive action rather than a participant one.
 *
 * That inverts the usual read-only rule for this ONE route: EXECUTIVE is the read-only role
 * platform-wide, so `requireTeamContentWrite` — which every other write uses —
 * refuses exactly the person who is now supposed to press the button. Hence a dedicated guard,
 * and hence this caller.
 *
 * Membership is still required and is asserted separately: executive is a licence to assess a
 * team you belong to, not any team.
 */
const EXEC_MEMBER = asUser("exec", "EXECUTIVE");

const post = (app: ReturnType<typeof build>["app"], path: string, body: unknown, who = EXEC_MEMBER) =>
  app.request(path, { method: "POST", headers: who, body: JSON.stringify(body) });
const get = (app: ReturnType<typeof build>["app"], path: string, who = asUser("alice")) =>
  app.request(path, { method: "GET", headers: who });

const ANALYZE = "/v1/ai/teams/team-1/ratings/analyze";
const ANALYSIS = "/v1/ai/teams/team-1/ratings/analysis";
const SUMMARY = "/v1/ai/teams/team-1/ratings/summary";
const PUBLISH = "/v1/ai/teams/team-1/ratings/publish";
const PROMPTS = "/v1/ai/teams/team-1/ratings/prompts";

describe("THE INVARIANT: no message text reaches the publishable call", () => {
  it("the summary call receives ONLY team totals — no text, and no per-member row", async () => {
    // The single most important assertion here. If message text ever reaches this call, the
    // published summary becomes a laundering channel for private chat read by a judge.
    //
    // ⚠ AND NO PER-MEMBER ROW EITHER. This originally sent one row per member under an opaque
    // handle; a live Bedrock probe then wrote "one member drove the majority of messaging,
    // commits, and AI-assisted work" — naming nobody while identifying someone in a
    // three-person team. Totals remove the capability instead of asking the model to refrain.
    const { app, analyst } = build();

    await post(app, ANALYZE, {});

    expect(analyst.summaryInputs).toHaveLength(1);
    const input = analyst.summaryInputs[0];
    const payload = JSON.stringify(input);
    expect(payload).not.toContain(SECRET);
    expect(payload).not.toContain("auth ticket");
    expect(payload).not.toContain("Alice");
    // Only these keys, so a future field cannot smuggle text — or a per-person axis — in
    // unnoticed. `members` reappearing here would silently restore the defect above.
    expect(Object.keys(input).sort()).toEqual(["distribution", "memberCount", "totals"]);
    /**
     * AND THE TOTALS' KEY SET IS PINNED TOO, for the same reason one level down.
     *
     * `aiTurns` was ADDED here deliberately — it is the honest AI-usage figure, and it is a
     * COUNT, so it carries no message text and no per-person axis. That is what makes it safe
     * for the publishable call. Anything added to this list in future has to clear the same bar,
     * and this assertion is what forces someone to think about it rather than inherit it.
     */
    expect(Object.keys(input.totals).sort()).toEqual([
      "aiThreadsShared",
      "aiTurns",
      "commitsPushed",
      "messagesSent",
      "tasksCompleted",
      "tasksCreated",
    ]);
    expect(payload, "not even an opaque handle").not.toMatch(/\bM[0-9]+\b/);
  });

  it("SUMS the counters rather than passing them through", async () => {
    // The totals must be arithmetically right, or a judge reads a wrong number. Two members
    // here, so the sum is distinguishable from either row.
    const { app, analyst } = build({
      counters: {
        byTeam: async () => [
          {
            userId: "alice",
            tasksCreated: 4,
            tasksCompleted: 12,
            messagesSent: 88,
            commitsPushed: 21,
            aiThreadsShared: 3,
            // Turns deliberately much larger than shares — the whole point of the counter is
            // that a heavy assistant user may share almost nothing.
            aiTurns: 40,
          },
          {
            userId: "bob",
            tasksCreated: 1,
            tasksCompleted: 2,
            messagesSent: 10,
            commitsPushed: 4,
            aiThreadsShared: 1,
            aiTurns: 5,
          },
        ],
      },
    });

    await post(app, ANALYZE, {});

    const input = analyst.summaryInputs[0];
    expect(input.memberCount).toBe(2);
    expect(input.totals).toEqual({
      tasksCreated: 5,
      tasksCompleted: 14,
      messagesSent: 98,
      commitsPushed: 25,
      aiThreadsShared: 4,
      aiTurns: 45,
    });
    // 168 vs 23 of total effort is a wide spread, and the label is the only shape signal that
    // survives aggregation. `aiTurns` is part of that effort sum: a member whose contribution is
    // mostly assistant-driven must not read as idle.
    expect(input.distribution).toBe("highly uneven");
  });

  it("labels a ONE-PERSON team as such, not as 'even'", async () => {
    // There is nothing to be even between, and "effort was evenly distributed" about one
    // person is a sentence that means nothing.
    const { app, analyst } = build();
    await post(app, ANALYZE, {});
    expect(analyst.summaryInputs[0].distribution).toBe("single-member");
  });

  it("does not divide by zero on an all-zero team", async () => {
    // Reachable: a team whose only rows are zeroed counters. `NaN` would serialise to null
    // and the label would be missing rather than wrong.
    const zeroed = (userId: string) => ({
      userId,
      tasksCreated: 0,
      tasksCompleted: 0,
      messagesSent: 0,
      commitsPushed: 0,
      aiThreadsShared: 0,
      aiTurns: 0,
    });
    const { app, analyst } = build({
      counters: { byTeam: async () => [zeroed("alice"), zeroed("bob")] },
    });

    await post(app, ANALYZE, {});

    expect(analyst.summaryInputs[0].distribution).toBe("even");
  });

  it("the knowledge call DOES receive the text — that is its whole purpose", async () => {
    // The counterpart. Assessing AI skill from counters is impossible: aiThreadsShared counts
    // button presses, so a heavy CLI user who never pressed "share" would score zero.
    const { app, analyst } = build();

    await post(app, ANALYZE, {});

    const payload = JSON.stringify(analyst.knowledgeInputs[0]);  // nosemgrep: no-stringify-keys
    expect(payload).toContain(SECRET);
    expect(payload).toContain("auth ticket");
  });

  it("NEITHER call receives a member's NAME — the knowledge call gets an opaque handle", async () => {
    // The model cannot name an individual in either output because it never saw a name. A
    // property of the input, not an instruction it was asked to follow.
    const { app, analyst } = build();

    await post(app, ANALYZE, {});

    for (const payload of [
      JSON.stringify(analyst.knowledgeInputs[0]),  // nosemgrep: no-stringify-keys
      JSON.stringify(analyst.summaryInputs[0]),  // nosemgrep: no-stringify-keys
    ]) {
      expect(payload).not.toContain("Alice Smith");
      expect(payload).not.toContain("alice");
    }
    // Call A keeps a per-person axis — it must, since its output IS per person — but keyed on
    // a handle that is mapped back server-side. Call B has no such axis at all.
    expect(analyst.knowledgeInputs[0].handle).toBe("M1");
  });

  it("REJECTS a summary that names a member, keeping the previous snapshot", async () => {
    // Belt and braces over the handle scheme. If a model names someone anyway, the
    // generation is discarded rather than stored and published.
    const ratings = new FakeRatings();
    const { app } = build({ ratings, analyst: new SpyAnalyst("Alice Smith carried the team.") });

    const res = await post(app, ANALYZE, {});

    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("MODEL_RESPONSE_INVALID");
    expect(ratings.rows, "nothing stored").toHaveLength(0);
  });
});

describe("audiences", () => {
  it("an EXECUTIVE MEMBER reads the full per-member analysis", async () => {
    /**
     * ⚠ THIS WAS "a MEMBER reads…", and the rule inverted: per-member AI insights are read only
     * by executives; the team summary is read by executives and judges.
     * Pure membership meant every teammate read every other member's score and rationale.
     */
    const { app } = build({ isMember: true });
    await post(app, ANALYZE, {});

    const res = await get(app, ANALYSIS, EXEC_MEMBER);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { analysis: TeamAiRatingSnapshot };
    expect(body.analysis.members[0].aiKnowledgeScore).toBe(72);
    expect(body.analysis.members[0].improvements.length).toBeGreaterThan(0);
  });

  it("an EXECUTIVE ON the team reads it too — as a member, with no special case", async () => {
    // `canReadContent` is pure membership and ignores role, so this needs no code branch —
    // which is the point: a special case is a thing to get wrong later.
    const { app } = build({ isMember: true });
    await post(app, ANALYZE, {});

    const res = await get(app, ANALYSIS, asUser("exec", "EXECUTIVE"));

    expect(res.status).toBe(200);
  });

  it("a JUDGE is REFUSED the per-member analysis", async () => {
    const { app } = build({ isMember: false });
    const res = await get(app, ANALYSIS, asUser("judge", "JUDGE"));
    expect(res.status).toBe(403);
  });

  it("a JUDGE gets 404 on an UNPUBLISHED summary — not 403", async () => {
    // A 403 would confirm a snapshot exists, which is itself information about a team the
    // caller is not part of.
    const { app } = build({ isMember: true });
    await post(app, ANALYZE, {});

    const { app: judgeView, ratings } = build({ isMember: false });
    void ratings;
    const res = await get(judgeView, SUMMARY, asUser("judge", "JUDGE"));

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("SUMMARY_NOT_PUBLISHED");
  });

  it("a JUDGE reads the summary ONCE PUBLISHED, and gets no per-member field", async () => {
    const ratings = new FakeRatings();
    const { app } = build({ ratings, isMember: true });
    const created = await post(app, ANALYZE, {});
    const generationId = (await created.json()).analysis.generationId;
    await post(app, PUBLISH, { generationId });

    // Same store, a caller who is not a member.
    const { app: judgeView } = build({ ratings, isMember: false });
    const res = await get(judgeView, SUMMARY, asUser("judge", "JUDGE"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toContain("worked steadily");
    // The RESPONSE SHAPE is the enforcement, not a filter over a wider object.
    expect(body).not.toHaveProperty("members");
    expect(JSON.stringify(body)).not.toContain("aiKnowledgeScore");
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  /**
   * ── ⚠ ENTITLEMENT IS NOT A READING CREDENTIAL ────────────────────────────────────────────
   *
   * Branch 4 of `requirePublishedSummaryRead` originally asked Team for the caller's
   * entitled workshops and then tested only whether the snapshot's workshop was among them. The
   * `role` was passed to that call and never predicated on, even though the branch's own header
   * said its audience was "JUDGE, and an EXECUTIVE who is not on the team".
   *
   * Entitlement is not role-restricted: Team's `GET /v1/entitlements/workshops` unions workshops
   * from live invitations with workshops reached through ANY team membership, for ANY role. So an
   * ordinary PARTICIPANT on team A in workshop W was entitled to W and could read the published
   * summary of every RIVAL team in W — mid-competition, with team ids visible from the workshop's
   * own team listing.
   *
   * ⚠ THE FIXTURE IS THE ATTACK: `isMember: false` (not on the victim team) with the default
   * entitlements fake answering `["ws-1"]` (entitled to the workshop, exactly as a participant on
   * some other team in it would be). The published snapshot carries `ws-1`.
   */
  describe("ATTACK: a same-workshop non-member reading a rival team's published summary", () => {
    /** Publish a snapshot on `team-1`, then return a view for a caller who is NOT a member. */
    async function publishedThenOutsiderView() {
      const ratings = new FakeRatings();
      const { app } = build({ ratings, isMember: true });
      const created = await post(app, ANALYZE, {});
      const generationId = (await created.json()).analysis.generationId;
      await post(app, PUBLISH, { generationId });
      return build({ ratings, isMember: false });
    }

    it("REFUSES a PARTICIPANT who is merely entitled to the workshop", async () => {
      const { app } = await publishedThenOutsiderView();

      const res = await get(app, SUMMARY, asUser("rival", "PARTICIPANT"));

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("SUMMARY_NOT_ENTITLED");
    });

    it("refuses the participant WITHOUT asking Team for entitlements", async () => {
      // The local-check-first ordering, mirroring evaluation/src/authz.ts. This is not merely a
      // latency preference now: a refused participant is the overwhelmingly common way branch 4
      // is reached, so paying an east-west hop to refuse them would be the normal case.
      let hops = 0;
      const ratings = new FakeRatings();
      const { app: teamView } = build({ ratings, isMember: true });
      const created = await post(teamView, ANALYZE, {});
      await post(teamView, PUBLISH, {
        generationId: (await created.json()).analysis.generationId,
      });

      const { app } = build({
        ratings,
        isMember: false,
        entitlements: {
          listEntitledWorkshopIds: async () => {
            hops += 1;
            return { workshopIds: ["ws-1"], truncated: false };
          },
        },
      });

      const res = await get(app, SUMMARY, asUser("rival", "PARTICIPANT"));

      expect(res.status).toBe(403);
      expect(hops, "a refused PARTICIPANT must cost no entitlement hop").toBe(0);
    });

    it("still admits the two roles the branch exists for", async () => {
      // The regression guard. A fix that simply closed branch 4 would pass every negative above
      // and break the judging and sponsor paths the branch was written for.
      for (const role of ["JUDGE", "EXECUTIVE"]) {
        const { app } = await publishedThenOutsiderView();
        const res = await get(app, SUMMARY, asUser("reader", role));
        expect(res.status, `${role} must still read a published summary`).toBe(200);
      }
    });

    it("still refuses a JUDGE who is not entitled to the snapshot's workshop", async () => {
      // The workshop half must keep working independently of the new role half — otherwise the
      // role check becomes the only gate and any judge reads every workshop.
      const ratings = new FakeRatings();
      const { app: teamView } = build({ ratings, isMember: true });
      const created = await post(teamView, ANALYZE, {});
      await post(teamView, PUBLISH, {
        generationId: (await created.json()).analysis.generationId,
      });

      const { app } = build({
        ratings,
        isMember: false,
        entitlements: {
          listEntitledWorkshopIds: async () => ({
            workshopIds: ["some-other-workshop"],
            truncated: false,
          }),
        },
      });

      const res = await get(app, SUMMARY, asUser("judge", "JUDGE"));

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("SUMMARY_NOT_ENTITLED");
    });

    it("keeps the 404 ordering — an unpublished snapshot is invisible before the role check", async () => {
      // Branch 2 must stay ahead of branch 4a. If the role refusal moved earlier, a participant
      // would get 403 where an outsider previously got 404, which leaks that a snapshot exists.
      const { app } = build({ isMember: false });
      const res = await get(app, SUMMARY, asUser("rival", "PARTICIPANT"));
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("SUMMARY_NOT_PUBLISHED");
    });
  });
});

describe("generation is bounded and refuses rather than guesses", () => {
  it("a read NEVER invokes the model", async () => {
    // The analyst throws if touched, so a 200 proves no invocation. Read as the EXECUTIVE,
    // since per-member reads are executive-only now.
    const { app } = build({ analyst: forbiddenAnalyst });
    expect((await get(app, ANALYSIS, EXEC_MEMBER)).status).toBe(200);
  });

  it("REFUSES when the counters could not be read — an empty list would invent a story", async () => {
    const { app } = build({
      counters: { byTeam: async () => "unavailable" },
      analyst: forbiddenAnalyst,
    });

    const res = await post(app, ANALYZE, {});

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("TEAM_ACTIVITY_UNAVAILABLE");
  });

  it("REFUSES when team chat could not be read", async () => {
    const { app } = build({
      chat: { recentByTeam: async () => "unavailable" },
      analyst: forbiddenAnalyst,
    });
    expect((await post(app, ANALYZE, {})).status).toBe(503);
  });

  it("REFUSES a team with no activity, WITHOUT invoking the model", async () => {
    // A summary of nothing is a hallucination you paid for.
    const { app } = build({ counters: { byTeam: async () => [] }, analyst: forbiddenAnalyst });
    const res = await post(app, ANALYZE, {});
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("NO_ACTIVITY");
  });

  /** N members with identical, minimal counters. */
  const membersOf = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      userId: `u${i}`,
      tasksCreated: 1,
      tasksCompleted: 1,
      messagesSent: 1,
      commitsPushed: 1,
      aiThreadsShared: 1,
      aiTurns: 1,
    }));

  it("REFUSES an oversized team rather than truncating it", async () => {
    /**
     * Silently omitting members is a wrong answer that looks right.
     *
     * THE CAP IS 10, LOWERED FROM 25 BECAUSE 25 WAS MEASURED AND DOES NOT WORK. Probing the
     * real model: 5 members takes 4.7s and is clean; 25 members takes 20-26s and fails with
     * "not JSON" — and before the truncation guard existed it returned 25 rows with EVERY
     * rationale empty. The cap is now the largest size the call is known to handle rather than
     * the largest a team is allowed to be.
     */
    const { app } = build({
      counters: { byTeam: async () => membersOf(11) },
      analyst: forbiddenAnalyst,
    });

    const res = await post(app, ANALYZE, {});

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("TEAM_TOO_LARGE");
    // The limit travels in the message, so an operator is not left guessing what it is.
    expect(body.error).toContain("11");
    expect(body.error).toContain("10");
  });

  it("ACCEPTS a team exactly AT the limit — the boundary is inclusive", async () => {
    // Off-by-one here would refuse a legitimate 10-person team, and the failure would look
    // like a broken feature rather than a bound. Analysed, not refused.
    const { app } = build({ counters: { byTeam: async () => membersOf(10) } });

    const res = await post(app, ANALYZE, {});

    // 201: a snapshot was CREATED. Not 200 — analyze is a write, and the distinction is the
    // route's own, so the boundary test asserts what the route actually promises.
    expect(res.status).toBe(201);
    expect((await res.json()).analysis.members).toHaveLength(10);
  });

  it("enforces a COOLDOWN and returns the existing analysis with it", async () => {
    const ratings = new FakeRatings();
    const { app } = build({ ratings });
    await post(app, ANALYZE, {});

    const res = await post(app, ANALYZE, {});

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("ANALYSIS_COOLDOWN");
    // Rides along so the UI still renders something rather than blanking.
    expect(body.analysis).toBeTruthy();
  });

  it("a MODEL FAILURE leaves the previous snapshot intact", async () => {
    const ratings = new FakeRatings();
    const good = build({ ratings });
    await post(good.app, ANALYZE, {});
    const before = ratings.rows.length;

    // Fresh app over the SAME store, past the cooldown by clearing it.
    ratings.rows[0].generatedAt = "2020-01-01T00:00:00.000Z";
    const { app } = build({ ratings, analyst: forbiddenAnalyst });
    const res = await post(app, ANALYZE, {});

    expect(res.status).toBe(503);
    expect(ratings.rows).toHaveLength(before);
    expect((await res.json()).analysis).toBeTruthy();
  });

  it("drops a HALLUCINATED member the model invented", async () => {
    // Answers about a member nobody asked about. The adapter forces the handle back, but the
    // route must ALSO drop an unknown one — two layers, because this is what decides whether a
    // fabricated person becomes a stored row.
    const inventing: RatingAnalyst = {
      assessKnowledge: async () => ({
        handle: "M99",
        aiKnowledgeScore: 99,
        rationale: "r",
        strengths: [],
        improvements: [],
      }),
      summariseTeam: async () => "fine",
    };
    const { app } = build({ analyst: inventing });

    const res = await post(app, ANALYZE, {});

    // The only member's assessment came back under a hallucinated handle, so nothing is
    // storable and the generation fails rather than storing an empty analysis.
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("MODEL_RESPONSE_INVALID");
  });

  it("assesses members ONE AT A TIME — one call per member, not one batch", async () => {
    /**
     * THE MEASURED FIX. A single prompt carrying the whole team did not work against the live
     * model: 5 members was clean in 4.7s, 10 members returned 1-2 of 10 rows with every score
     * 0, and 25 members failed after 20-26s (earlier, 25 rows with EVERY rationale empty).
     * None were clean errors — hollow coaching would have been stored and shown as considered.
     *
     * Per-member calls make the unit of work constant, so quality stops degrading with size.
     */
    const { app, analyst } = build({ counters: { byTeam: async () => membersOf(4) } });

    await post(app, ANALYZE, {});

    expect(analyst.knowledgeInputs).toHaveLength(4);
    // Each call carries exactly ONE member, and no `members` array survives anywhere.
    for (const input of analyst.knowledgeInputs) {
      expect(input).not.toHaveProperty("members");
      expect(typeof input.handle).toBe("string");
    }
    // Four distinct members, so nobody was assessed twice or skipped.
    expect(new Set(analyst.knowledgeInputs.map((i) => i.handle)).size).toBe(4);
  });

  it("keeps the OTHER members when one assessment fails", async () => {
    // One malformed answer must not discard three good ones. The alternative — failing the
    // whole generation — means a single member's odd response costs everyone their coaching.
    let n = 0;
    const flaky: RatingAnalyst = {
      assessKnowledge: async (input) => {
        if (++n === 2) throw new Error("MODEL_RESPONSE_INVALID: not JSON");
        return {
          handle: input.handle,
          aiKnowledgeScore: 60,
          rationale: "r",
          strengths: [],
          improvements: [],
        };
      },
      summariseTeam: async () => "fine",
    };
    const { app } = build({ counters: { byTeam: async () => membersOf(4) }, analyst: flaky });

    const res = await post(app, ANALYZE, {});

    expect(res.status).toBe(201);
    // 3 of 4 stored — a partial analysis, not a lost one.
    expect((await res.json()).analysis.members).toHaveLength(3);
  });

  it("REFUSES with 502 when every answer is unusable — and does NOT start the cooldown", async () => {
    // Nothing storable is a FAILED generation. Storing an empty snapshot would render as
    // "analysis complete, nobody assessed" AND begin the 10-minute cooldown, so the member
    // could not even retry. 502 not 503: retrying the same input reproduces it.
    const ratings = new FakeRatings();
    const wrongPerson: RatingAnalyst = {
      assessKnowledge: async () => ({
        handle: "M99",
        aiKnowledgeScore: 99,
        rationale: "r",
        strengths: [],
        improvements: [],
      }),
      summariseTeam: async () => "fine",
    };
    const { app } = build({ ratings, analyst: wrongPerson });

    const res = await post(app, ANALYZE, {});

    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("MODEL_RESPONSE_INVALID");
    expect(ratings.rows, "nothing stored, so a retry is still possible").toHaveLength(0);
  });

  it("reports EVERY call ERRORING as 503, not 502 — that one is transient", async () => {
    // The distinction matters operationally: all calls throwing is an outage a retry may fix,
    // whereas answers arriving unusable is deterministic. Collapsing them either tells an
    // operator to retry forever or sends them reading prompts during a Bedrock outage.
    const { app } = build({
      counters: { byTeam: async () => membersOf(3) },
      analyst: forbiddenAnalyst,
    });

    const res = await post(app, ANALYZE, {});

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("MODEL_FAILED");
  });

  it("clamps an out-of-range score", async () => {
    const wild: RatingAnalyst = {
      assessKnowledge: async (input) => ({
        handle: input.handle,
        aiKnowledgeScore: 300,
        rationale: "r",
        strengths: [],
        improvements: [],
      }),
      summariseTeam: async () => "fine",
    };
    const { app } = build({ analyst: wild });
    const res = await post(app, ANALYZE, {});
    expect((await res.json()).analysis.members[0].aiKnowledgeScore).toBe(100);
  });

  it("stores a SERVER-DERIVED workshopId, which is what gates judge access", async () => {
    // Never from the request: a caller could otherwise name a workshop they are entitled to
    // and read a foreign team's summary through it.
    const { app } = build();
    const res = await post(app, ANALYZE, { workshopId: "ws-ATTACKER" });
    expect((await res.json()).analysis.workshopId).toBe("ws-1");
  });

  it("carries COVERAGE caveats in the payload, not only in comments", async () => {
    // People are ranked by these numbers, so what the numbers miss travels to the screen.
    const { app } = build();
    const res = await post(app, ANALYZE, {});
    const coverage = (await res.json()).analysis.coverage as string[];
    expect(coverage.join(" ")).toMatch(/CLI/i);
    expect(coverage.join(" ")).toMatch(/activity, not quality/i);
  });
});

describe("publishing is a deliberate disclosure", () => {
  it("a PARTICIPANT cannot publish — it moved with analyze", async () => {
    /**
     * ⚠ THIS RULE INVERTED. It used to assert the opposite — that a read-only EXECUTIVE could
     * not publish — which was right while publish was a member write.
     *
     * Generating became executive-only, and publish had to follow or the
     * feature is incoherent: the person who can produce an assessment could not disclose it,
     * while a participant decided what judges read. Both guards now move together.
     */
    const ratings = new FakeRatings();
    const { app } = build({ ratings, isMember: true });
    const created = await post(app, ANALYZE, {});
    const generationId = (await created.json()).analysis.generationId;

    const res = await post(app, PUBLISH, { generationId }, asUser("alice", "PARTICIPANT"));

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("EXECUTIVE_ONLY");
  });

  it("an EXECUTIVE who is NOT a member cannot publish either", async () => {
    // Executive is a licence to assess and disclose a team you BELONG to, not any team.
    const ratings = new FakeRatings();
    const { app } = build({ ratings, isMember: true });
    const created = await post(app, ANALYZE, {});
    const generationId = (await created.json()).analysis.generationId;

    const { app: offTeam } = build({ ratings, isMember: false });
    const res = await post(offTeam, PUBLISH, { generationId });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_A_TEAM_MEMBER");
  });

  it("REFUSES to publish a superseded generation", async () => {
    // Publishing must apply to the snapshot the publisher was looking at, or a regeneration
    // landing mid-review publishes text nobody approved.
    const ratings = new FakeRatings();
    const { app } = build({ ratings });
    const first = await post(app, ANALYZE, {});
    const staleId = (await first.json()).analysis.generationId;
    ratings.rows[0].generatedAt = "2020-01-01T00:00:00.000Z";
    await post(app, ANALYZE, {});

    const res = await post(app, PUBLISH, { generationId: staleId });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("GENERATION_SUPERSEDED");
  });

  it("requires a generationId", async () => {
    const { app } = build();
    expect((await post(app, PUBLISH, {})).status).toBe(400);
  });
});

describe("an unwired deployment says so", () => {
  it("returns 503 RATINGS_UNAVAILABLE, not 403 or 404", async () => {
    // "This environment cannot do that" is not "you may not" and not "no such thing".
    // Conflating them sends an operator hunting for a permissions bug.
    const { app } = build({ wired: false });
    for (const path of [ANALYSIS, SUMMARY]) {
      const res = await get(app, path);
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("RATINGS_UNAVAILABLE");
    }
  });
});

describe("GENERATING is an EXECUTIVE action; READING stays member-wide", () => {
  /**
   * The rule: only executives generate insights, not other participants. This is the ONE route that inverts the platform read-only rule.
   *
   * ── WHY IT NEEDED A DEDICATED GUARD ──
   *
   * EXECUTIVE is the read-only role, so `requireTeamContentWrite` refuses exactly
   * the person now expected to press the button. Removing EXECUTIVE from READ_ONLY_ROLES would
   * have unblocked it — and also handed executives write access to ~35 routes across seven
   * services (chat, tasks, docs, commits, scores), contradicting the investigation model where
   * an executive reads a team's content and alters none of it. The narrow guard keeps that.
   *
   * ── THE ASYMMETRY IS THE POINT ──
   *
   * Generating costs billable model calls (one per member) and decides what everyone else then
   * reads, so it is the reviewer's action. Reading stays member-wide because the output is
   * coaching and the person it describes must be able to see it.
   */

  it("an EXECUTIVE member GENERATES", async () => {
    const { app } = build({ isMember: true });
    const res = await post(app, ANALYZE, {}, asUser("exec", "EXECUTIVE"));
    expect(res.status).toBe(201);
  });

  for (const role of ["PARTICIPANT", "ADMIN", "FACILITATOR", "JUDGE"]) {
    it(`a ${role} is REFUSED with EXECUTIVE_ONLY, even as a member`, async () => {
      // isMember: true so the refusal is provably about the ROLE, not about membership — a
      // test that failed for either reason would not pin this rule.
      const { app } = build({ isMember: true, analyst: forbiddenAnalyst });

      const res = await post(app, ANALYZE, {}, asUser("someone", role));

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("EXECUTIVE_ONLY");
    });
  }

  it("an EXECUTIVE who is NOT a member is REFUSED — executive is not a licence to mine any team", async () => {
    // Generating reads every member's private AI conversations and team chat. Belonging to the
    // team is what makes that legitimate, so BOTH conditions hold, not either.
    const { app } = build({ isMember: false, analyst: forbiddenAnalyst });

    const res = await post(app, ANALYZE, {}, asUser("exec", "EXECUTIVE"));

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_A_TEAM_MEMBER");
  });

  it("refuses a non-executive WITHOUT invoking the model or hitting the store", async () => {
    // The role check is local and FIRST, so a refused participant costs no east-west hop and no
    // billable call. `forbiddenAnalyst` throws if touched, so a 403 proves both.
    const { app, ratings } = build({ isMember: true, analyst: forbiddenAnalyst });

    await post(app, ANALYZE, {}, asUser("alice", "PARTICIPANT"));

    expect(ratings.rows, "nothing stored").toHaveLength(0);
  });

  it("READING MOVED TOO: a PARTICIPANT member is refused, including their own row", async () => {
    /**
     * ⚠ THIS ASSERTION INVERTED, and it is the consequential one.
     *
     * It used to assert that a participant still saw their own coaching, on the reasoning that
     * "if generating moved but reading followed it, the output would become a performance review
     * the subject cannot see". The rule then became exactly that: per-member insights are read by
     * executives only.
     *
     * So that IS now the design. Stated rather than hidden: every non-executive member cannot see
     * the coaching written about them, and the welcome-page disclosure was rewritten because it
     * promised the opposite. If the intent returns to self-improvement, the change is to let a
     * caller read THEIR OWN row — not to widen the guard back to membership.
     */
    const ratings = new FakeRatings();
    const { app } = build({ ratings, isMember: true });
    await post(app, ANALYZE, {}, EXEC_MEMBER);

    const res = await get(app, ANALYSIS, asUser("alice", "PARTICIPANT"));

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("EXECUTIVE_ONLY");
  });

  it("the TEAM SUMMARY is still the shared surface — a judge reads it once published", async () => {
    // The other half of the rule, and the reason narrowing per-member reads is
    // acceptable: there IS a view for everyone else, it just carries no per-person row.
    const ratings = new FakeRatings();
    const { app } = build({ ratings, isMember: true });
    const created = await post(app, ANALYZE, {}, EXEC_MEMBER);
    await post(app, PUBLISH, { generationId: (await created.json()).analysis.generationId }, EXEC_MEMBER);

    const { app: judgeView } = build({ ratings, isMember: false });
    const res = await get(judgeView, SUMMARY, asUser("judge", "JUDGE"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toBeTruthy();
    expect(body, "no per-member field reaches a judge").not.toHaveProperty("members");
  });
});

describe("aiTurns is the honest AI-usage signal, and it reaches the publishable summary", () => {
  /**
   * `aiThreadsShared` counts BUTTON PRESSES. Someone who worked with an assistant all day and
   * never pressed "share" scored zero, which is backwards for a figure meant to reflect AI usage.
   * `aiTurns` is fed by `ai.response-generated` from BOTH the in-app Bedrock path and the desktop
   * CLI sync — an event that was published and consumed by nothing until v0.3.2.
   *
   * It is safe for the PUBLISHABLE call for the same reason every other counter is: it is an
   * integer, carrying no message text and no per-person axis.
   */
  it("SUMS turns into the publishable totals, independently of shares", async () => {
    // The two must not track each other, or the new counter tells you nothing the old one didn't.
    const { app, analyst } = build({
      counters: {
        byTeam: async () => [
          {
            userId: "alice",
            tasksCreated: 0,
            tasksCompleted: 0,
            messagesSent: 0,
            commitsPushed: 0,
            aiThreadsShared: 0,
            aiTurns: 120,
          },
        ],
      },
    });

    await post(app, ANALYZE, {});

    const totals = analyst.summaryInputs[0].totals;
    expect(totals.aiTurns, "heavy assistant use").toBe(120);
    expect(totals.aiThreadsShared, "who never pressed share").toBe(0);
  });

  it("counts turns toward EFFORT, so a mostly-assistant member does not read as idle", async () => {
    // If turns were excluded from the spread calculation, a member whose contribution is
    // assistant-driven would look inactive and drag the distribution label the wrong way.
    const flat = (userId: string, aiTurns: number) => ({
      userId,
      tasksCreated: 1,
      tasksCompleted: 1,
      messagesSent: 1,
      commitsPushed: 1,
      aiThreadsShared: 0,
      aiTurns,
    });
    const { app, analyst } = build({
      counters: { byTeam: async () => [flat("a", 200), flat("b", 2)] },
    });

    await post(app, ANALYZE, {});

    // Identical on every other counter; only turns differ — so the label must react to them.
    expect(analyst.summaryInputs[0].distribution).toBe("highly uneven");
  });

  it("states in COVERAGE that turns predate nothing — earlier activity is absent, not zero", async () => {
    /**
     * The caveat this replaced said CLI work was "not yet reported as platform activity", which
     * became false the moment the sync route began publishing turn counts. Deleting it would
     * have overstated the data instead: everything before that release is still missing, and a
     * reader comparing an old team to a new one needs to know.
     */
    const { app } = build();

    const res = await post(app, ANALYZE, {});

    const coverage = ((await res.json()).analysis.coverage as string[]).join(" ");
    expect(coverage).toMatch(/absent, not zero/i);
    expect(coverage, "and shares are named as the weak signal").toMatch(/button press/i);
    // The stale claim must be gone.
    expect(coverage).not.toMatch(/not yet reported as platform activity/i);
  });
});

describe("TWO AUDIENCES: per-member is EXECUTIVE-only, the summary is shared", () => {
  /**
   * The rule, in full: per-member AI insights are read only by executives; the team summary is
   * read by executives and judges.
   *
   * The two halves have to be tested together, because narrowing per-member reads is only
   * defensible BECAUSE the summary exists for everyone else. A judge losing the summary too
   * would leave them nothing.
   */
  for (const role of ["PARTICIPANT", "ADMIN", "FACILITATOR", "JUDGE"]) {
    it(`a ${role} is REFUSED the per-member analysis, even as a member`, async () => {
      // isMember: true, so the refusal is provably about the ROLE. A test that could fail for
      // either reason would not pin this rule.
      const { app } = build({ isMember: true });
      await post(app, ANALYZE, {}, EXEC_MEMBER);

      const res = await get(app, ANALYSIS, asUser("someone", role));

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("EXECUTIVE_ONLY");
    });
  }

  it("an EXECUTIVE who is NOT on the team is refused — not any team", async () => {
    // The assessments derive from members' private AI conversations, so executive is a licence
    // to review a team you belong to.
    const { app } = build({ isMember: false });
    const res = await get(app, ANALYSIS, EXEC_MEMBER);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_A_TEAM_MEMBER");
  });

  it("refuses a non-executive WITHOUT an east-west hop", async () => {
    // The role check is local and first, so a refused participant costs nothing. `Access`
    // throwing if consulted would prove it; instead assert the cheaper observable — the refusal
    // arrives even when membership would have said yes.
    const { app } = build({ isMember: true });
    const res = await get(app, ANALYSIS, asUser("alice", "PARTICIPANT"));
    expect((await res.json()).code).toBe("EXECUTIVE_ONLY");
    expect(res.status).toBe(403);
  });

  it("READ and GENERATE share the same audience, so the two guards cannot drift", () => {
    /**
     * Structural, and it is the assertion that matters most here. Producing an assessment and
     * reading it are the same audience by design; if a future change moves one, this fails and
     * forces the other to be considered rather than silently diverging — which is exactly how
     * publish ended up member-write while analyze was executive-only.
     */
    const src = readFileSync(
      fileURLToPath(new URL("./routes.ts", import.meta.url)),
      "utf8"
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const guardFor = (path: string) => {
      const at = code.indexOf(`"/teams/:teamId/ratings/${path}"`);
      expect(at, `${path} route must exist`).toBeGreaterThan(-1);
      // Tolerates a multi-line call: requirePublishedSummaryRead takes five arguments and is
      // formatted across lines, so an anchored single-line pattern silently matched nothing.
      return /require(\w+)\(\s*c,\s*deps\.teamAccess/.exec(code.slice(at, at + 900))?.[1];
    };
    expect(guardFor("analysis")).toBe("AssessmentRead");
    expect(guardFor("analyze")).toBe("AssessmentGenerate");
    expect(guardFor("publish")).toBe("AssessmentGenerate");
    // The summary keeps its own, wider guard — that is the shared surface.
    expect(guardFor("summary")).toBe("PublishedSummaryRead");
    // And the per-member route must NOT be back on pure membership.
    expect(guardFor("analysis")).not.toBe("TeamContentRead");
  });
});

describe("THE GENERATION LEASE: two clicks must not become two generations", () => {
  /**
   * THE HOLE THE COOLDOWN CANNOT CLOSE, and it is a cost hole rather than a correctness one.
   *
   * The cooldown compares the STORED snapshot's age, and the store is written at the END of a
   * generation — up to RATING_TOTAL_TIMEOUT_MS (45s) after the check. Two requests entering that
   * window together both read the same old snapshot, both pass, and both run the full generation:
   * one Bedrock call per member plus a summary, TWICE. At MAX_RATED_MEMBERS = 10 that is 22 model
   * invocations for one intended analysis.
   *
   * ⚠ WHAT A FAKE CAN AND CANNOT PROVE. It cannot prove the conditional write is atomic — that is
   * a DynamoDB property, and this repository has been burned before by fakes that accepted an
   * illegal expression the real service rejects. What it DOES prove is the route's use of the port:
   * a refused claim short-circuits before any model call, the lease is released on every exit, and
   * a lapsed lease is reclaimable. The atomicity belongs to a live probe.
   */

  it("refuses a SECOND analyze while the first holds the lease", async () => {
    const ratings = new FakeRatings();
    // Pre-claimed by someone else, exactly as a concurrent request would leave it.
    await ratings.claimGeneration("team-1", "other-exec", Date.now());
    const { app, analyst } = build({ ratings });

    const res = await post(app, ANALYZE, {});

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code, "a DISTINCT code from the cooldown").toBe("ANALYSIS_IN_PROGRESS");
    expect(
      analyst.knowledgeInputs,
      "⚠ NOT ONE model call may happen — this is the entire point"
    ).toHaveLength(0);
    expect(analyst.summaryInputs).toHaveLength(0);
  });

  it("sets Retry-After IN SECONDS on the in-progress refusal", async () => {
    // Every generic HTTP client reads the header; `retryAfterMs` is ours alone. Both are sent.
    const ratings = new FakeRatings();
    await ratings.claimGeneration("team-1", "other-exec", Date.now());
    const { app } = build({ ratings });

    const res = await post(app, ANALYZE, {});

    expect(res.headers.get("Retry-After")).toBe(String(GENERATION_LEASE_MS / 1000));
    expect((await res.json()).retryAfterMs).toBe(GENERATION_LEASE_MS);
  });

  it("RELEASES the lease after a successful generation", async () => {
    /**
     * Otherwise the first analysis of the day would block the next one for the full lease — and
     * worse, an executive would see "already being generated" for something that had finished.
     */
    const ratings = new FakeRatings();
    const { app } = build({ ratings });

    const res = await post(app, ANALYZE, {});

    expect(res.status).toBe(201);
    expect(ratings.releaseCalls).toBe(1);
    expect(ratings.claims.has("team-1"), "lease must be gone").toBe(false);
  });

  it("releases the lease even when the generation FAILS", async () => {
    /**
     * ⚠ THE `finally` IS WHAT THIS PINS. A generation that fails at second three must not hold the
     * lease for the remaining fifty-seven: the executive's legitimate retry would be refused
     * because of OUR fault. Modelled with an unreadable input, which is a real 503 path.
     */
    const ratings = new FakeRatings();
    const { app } = build({
      ratings,
      counters: { byTeam: async () => "unavailable" as const },
    });

    const res = await post(app, ANALYZE, {});

    expect(res.status).toBe(503);
    expect(ratings.releaseCalls, "released despite the failure").toBe(1);
    expect(ratings.claims.has("team-1")).toBe(false);
  });

  it("a FAILED release does not turn a stored analysis into an error", async () => {
    // The release is a cleanup, not part of the result. Its failure is self-healing (the lease
    // expires), so it must never reach the caller who just successfully generated something.
    const ratings = new FakeRatings();
    ratings.releaseThrows = true;
    const { app } = build({ ratings });

    const res = await post(app, ANALYZE, {});

    expect(res.status).toBe(201);
  });

  it("does NOT claim before the authorization guard", async () => {
    /**
     * Claiming first would let an UNAUTHORIZED caller deny a team its generation by holding the
     * lease — a denial-of-service handed to exactly the person who was refused.
     */
    const ratings = new FakeRatings();
    const { app } = build({ ratings, isMember: false });

    const res = await post(app, ANALYZE, {});

    expect(res.status).toBe(403);
    expect(ratings.claimCalls, "no lease taken by a refused caller").toBe(0);
  });

  it("does NOT claim when the COOLDOWN already refuses", async () => {
    // No point taking a lease for work that is not going to happen, and a lease taken here would
    // briefly block the legitimate caller who arrives after the cooldown lapses.
    const ratings = new FakeRatings();
    await ratings.put({
      teamId: "team-1",
      generationId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      generatedAt: new Date().toISOString(),
      generatedById: "exec",
      members: [],
      teamSummary: "recent",
      schemaVersion: 1,
    } as never);
    const { app } = build({ ratings });

    const res = await post(app, ANALYZE, {});

    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("ANALYSIS_COOLDOWN");
    expect(ratings.claimCalls).toBe(0);
  });

  it("a LAPSED lease is reclaimable without waiting for TTL deletion", async () => {
    /**
     * The killed-Lambda case. DynamoDB's TTL deletion is asynchronous and documented as taking up
     * to 48 hours, so a lease whose only release was TTL would wedge this route for a day and a
     * half. The condition tests `expiresAt` explicitly, and this asserts that semantics.
     */
    const ratings = new FakeRatings();
    const longAgo = Date.now() - GENERATION_LEASE_MS - 1;
    await ratings.claimGeneration("team-1", "dead-lambda", longAgo);

    const reclaimed = await ratings.claimGeneration("team-1", "next-exec", Date.now());

    expect(reclaimed).toBe(true);
  });

  it("the lease is PER TEAM — one team's generation does not block another's", async () => {
    const ratings = new FakeRatings();
    await ratings.claimGeneration("team-1", "exec", Date.now());

    expect(await ratings.claimGeneration("team-2", "exec", Date.now())).toBe(true);
  });
});

describe("the COOLDOWN refusal is observable to a generic client", () => {
  it("sets Retry-After in seconds, rounded UP", async () => {
    /**
     * It was missing entirely — so the one route on the platform that already shed load did so
     * unobservably to everything except our own UI. Ceiling, not floor: rounding 1.4s down to 1
     * invites a retry that is still too early.
     */
    const ratings = new FakeRatings();
    await ratings.put({
      teamId: "team-1",
      generationId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      generatedAt: new Date().toISOString(),
      generatedById: "exec",
      members: [],
      teamSummary: "recent",
      schemaVersion: 1,
    } as never);
    const { app } = build({ ratings });

    const res = await post(app, ANALYZE, {});

    expect(res.status).toBe(429);
    const header = Number(res.headers.get("Retry-After"));
    expect(header).toBeGreaterThan(0);
    // Cooldown is 10 minutes; a snapshot written "now" leaves essentially all of it.
    expect(header).toBeLessThanOrEqual(600);
    expect(header).toBeGreaterThan(590);
  });
});

describe("the snapshot records WHICH MODEL judged people", () => {
  /**
   * ⚠ A DEFECT NO TEST CAUGHT — it surfaced in documentation review rather than by any check here.
   *
   * The route read `process.env.BEDROCK_MODEL_ID` — a name NOTHING sets. The chat model's variable
   * was `AI_MODEL_ID` and the assessment model's is `BEDROCK_RATINGS_MODEL_ID`, so the `?? "unknown"`
   * fallback fired on every generation, so every stored snapshot carried `modelId: "unknown"`.
   *
   * WHY IT MATTERS MORE THAN A WRONG STRING USUALLY WOULD. This field is the PROVENANCE of a
   * judgement about a person — which model produced the scores an executive reads and a judge
   * eventually sees. Without it, "why did this member score 40?" is unanswerable after a model
   * change, and a swap cannot be correlated with a shift in scores.
   *
   * The fakes could never have caught it: an env var name is not a behaviour any injected double
   * exercises. Same family as the illegal DynamoDB expression and the rejected `temperature` — real
   * external contracts that green suites sail past.
   */
  it("stores the RATINGS model id, not an unset variable", async () => {
    const previous = process.env.BEDROCK_RATINGS_MODEL_ID;
    process.env.BEDROCK_RATINGS_MODEL_ID = "arn:aws:bedrock:us-east-1:1234:profile/xyz";
    try {
      const { app, ratings } = build();

      await post(app, ANALYZE, {});

      expect(ratings.rows).toHaveLength(1);
      expect(ratings.rows[0].modelId).toBe("arn:aws:bedrock:us-east-1:1234:profile/xyz");
      expect(ratings.rows[0].modelId, "the bug's signature").not.toBe("unknown");
    } finally {
      if (previous === undefined) delete process.env.BEDROCK_RATINGS_MODEL_ID;
      else process.env.BEDROCK_RATINGS_MODEL_ID = previous;
    }
  });

  it('falls back to "unknown" rather than failing a successful generation', async () => {
    // A missing label must not discard an assessment that the model actually produced. The analyst
    // itself requires the variable, so in practice this is unreachable in a wired deployment — but
    // the ordering matters: store the work, degrade the metadata.
    const previous = process.env.BEDROCK_RATINGS_MODEL_ID;
    delete process.env.BEDROCK_RATINGS_MODEL_ID;
    try {
      const { app, ratings } = build();

      const res = await post(app, ANALYZE, {});

      expect(res.status).toBe(201);
      expect(ratings.rows[0].modelId).toBe("unknown");
    } finally {
      if (previous !== undefined) process.env.BEDROCK_RATINGS_MODEL_ID = previous;
    }
  });
});

describe("THE PROMPTS ARE DISCLOSED to the executive who presses the button", () => {
  /**
   * The assessment scores a named person's craft, and until now the model-generated half of the
   * insights page published nothing about how. The heuristic score beside it already publishes its
   * weights (see the portal's InsightsMethodology), which left the more consequential number as
   * the opaque one.
   *
   * ⚠ THE LOAD-BEARING PROPERTY IS THAT THE DISCLOSED STRING IS THE SENT STRING. Both the route
   * and the Bedrock adapter import `ratings-prompts.ts`, so drift is unrepresentable rather than
   * merely tested — the assertions below are about the AUDIENCE and about the route costing
   * nothing, which are the two things that could still regress.
   */

  it("an EXECUTIVE member reads both prompts, verbatim", async () => {
    const { app } = build({ isMember: true, analyst: forbiddenAnalyst });

    const res = await get(app, PROMPTS, EXEC_MEMBER);

    expect(res.status).toBe(200);
    const { prompts } = await res.json();
    expect(prompts.map((p: { key: string }) => p.key)).toEqual([
      "knowledge",
      "summary",
    ]);
    // The same constants the adapter sends, not a paraphrase of them.
    expect(prompts[0].system).toBe(KNOWLEDGE_SYSTEM);
    expect(prompts[1].system).toBe(SUMMARY_SYSTEM);
  });

  it("states what each call RECEIVES, not just what it is told", async () => {
    /**
     * A panel showing only "NEVER refer to an individual" credits the instruction with a property
     * the INPUT is holding: the summary call gets team totals, so it cannot name someone it never
     * saw. Disclosing the rule without the input shape would misdescribe where the guarantee
     * lives — which is worse than disclosing nothing.
     */
    const { app } = build({ isMember: true, analyst: forbiddenAnalyst });

    const { prompts } = await (await get(app, PROMPTS, EXEC_MEMBER)).json();

    const summary = prompts.find((p: { key: string }) => p.key === "summary");
    expect(summary.inputs.join(" ")).toMatch(/no per-member rows/i);
    expect(summary.audience).toMatch(/judges/i);

    const knowledge = prompts.find((p: { key: string }) => p.key === "knowledge");
    // The caps are quoted from the route's own constants, so this moves if they are tuned.
    expect(knowledge.inputs.join(" ")).toContain(String(40));
    expect(knowledge.inputs.join(" ")).toContain(String(600));
    // Per-member coaching has no publish path; saying otherwise would invert the member-only content rule.
    expect(knowledge.audience).not.toMatch(/judge/i);
  });

  for (const role of ["PARTICIPANT", "ADMIN", "FACILITATOR", "JUDGE"]) {
    it(`a ${role} is REFUSED with EXECUTIVE_ONLY, even as a member`, async () => {
      // isMember: true so the refusal is provably about the ROLE, not membership.
      const { app } = build({ isMember: true, analyst: forbiddenAnalyst });

      const res = await get(app, PROMPTS, asUser("someone", role));

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("EXECUTIVE_ONLY");
    });
  }

  it("an EXECUTIVE who is NOT a member is REFUSED", async () => {
    /**
     * The prompt text is identical for every team, so this is not about secrecy. `:teamId` is in
     * the path: answering 200 for an arbitrary team confirms that team exists and that this caller
     * is privileged over it. Refusing keeps the route indistinguishable from its siblings.
     */
    const { app } = build({ isMember: false, analyst: forbiddenAnalyst });

    const res = await get(app, PROMPTS, EXEC_MEMBER);

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("NOT_A_TEAM_MEMBER");
  });

  it("costs NO model call and NO store read, so it is safe on page load", async () => {
    /**
     * The route beside it spends one invoke per member per press. This one serves two constants,
     * which is why the portal may call it on render. `forbiddenAnalyst` throws if touched.
     */
    const { app, ratings } = build({ isMember: true, analyst: forbiddenAnalyst });

    const res = await get(app, PROMPTS, EXEC_MEMBER);

    expect(res.status).toBe(200);
    expect(ratings.rows).toHaveLength(0);
    // No lease taken and none released — the disclosure is outside the generation path entirely.
    expect(ratings.claimCalls).toBe(0);
    expect(ratings.releaseCalls).toBe(0);
  });

  it("answers even when the ratings store is UNWIRED", async () => {
    /**
     * It reads no table. Gating it on `deps.ratings` would withhold the explanation of what the
     * feature does during precisely the outage that makes an executive ask.
     */
    const { app } = build({ isMember: true, wired: false });

    expect((await get(app, PROMPTS, EXEC_MEMBER)).status).toBe(200);
  });

  it("PIN: EXECUTIVE is asserted directly, not via READ_ONLY_ROLES", () => {
    /**
     * ⚠ IF THIS FAILS, A SECOND READ-ONLY ROLE WAS ADDED — go and check `requireAssessmentGenerate`.
     *
     * That guard tests `isReadOnlyRole`, which today contains EXECUTIVE alone, so it decides
     * identically to this route. The two are not the same question: one asks "may you mutate", the
     * other "are you an executive". A new read-only role would silently inherit the Analyze button
     * AND, had the alias been reused, this disclosure. The prompt route asserts the role directly
     * so it cannot drift; this test is what makes the Analyze button's drift visible too.
     */
    for (const role of ["PARTICIPANT", "ADMIN", "FACILITATOR", "JUDGE"]) {
      expect(isReadOnlyRole(role)).toBe(false);
    }
    expect(isReadOnlyRole("EXECUTIVE")).toBe(true);
  });
});
