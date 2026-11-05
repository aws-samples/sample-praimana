import { describe, it, expect } from "vitest";
import {
  FEEDBACK_MESSAGE_BOUNDS,
  FEEDBACK_SUBJECT_BOUNDS,
  countWords,
} from "@praimana/shared";
import { createIdentityRoutes, MAX_FEEDBACK_MESSAGE } from "./routes.js";
import type {
  FeedbackPage,
  FeedbackReport,
  FeedbackRepository,
  User,
  UserPage,
  UserRepository,
} from "./domain.js";

/**
 * ── FEEDBACK AND BUG REPORTS ───────────────────────────────────────────────────────────────
 *
 * THE RULE: feedback and bug reports are not emailed; they are stored in the database, and facilitators and
 * admins are notified and can see them under Administration.
 *
 * The two rules that matter most and would be easy to get backwards:
 *
 *   · ANY signed-in person may FILE one — a PARTICIPANT hitting a bug is the most important reporter
 *     there is. Gating the create behind `canManageUsers` would mean only administrators could report.
 *   · Only ADMIN + FACILITATOR may READ the inbox, and that gate is middleware on the whole /v1/admin
 *     router so a route added later cannot forget it.
 */

const INTERNAL_TOKEN = "test-internal-token";
process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;

function asUser(identity: { id: string; email?: string; role: string }) {
  return {
    "content-type": "application/json",
    "x-internal-token": INTERNAL_TOKEN,
    "x-identity-id": identity.id,
    "x-identity-role": identity.role,
    ...(identity.email ? { "x-identity-email": identity.email } : {}),
  };
}

/** Records what the notifier was asked to send, so the recipient rule is assertable. */
class FakeNotifier {
  calls: Array<{ reportId: string; recipients: string[] }> = [];
  constructor(private readonly behaviour: "ok" | "throws" = "ok") {}
  async notifyNewReport(report: FeedbackReport, recipients: string[]) {
    this.calls.push({ reportId: report.id, recipients });
    // ⚠ A NOTIFIER THAT THROWS IS THE CASE THAT MATTERS. The real one swallows its own failures, but a
    // future one might not — and the route must survive either way, because the report is already stored.
    if (this.behaviour === "throws") throw new Error("notify unreachable");
    return recipients.length;
  }
}

class NoUsers implements UserRepository {
  /** Staff accounts the notification should be addressed to. Empty by default. */
  constructor(private readonly staff: User[] = []) {}
  async getById() {
    return null;
  }
  async getByEmail() {
    return null;
  }
  async put(u: User) {
    return u;
  }
  /** Never exercised here — this stub exists for routes that do not touch the profile. */
  async updateProfile(): Promise<User> {
    throw new Error("updateProfile is not exercised by this suite");
  }
  async list(opts: { visibleRoles?: readonly string[] } = {}): Promise<UserPage> {
    // Honours visibleRoles, as the real repository does: a fake that ignored it would let the route stop
    // filtering while the recipient assertions still passed.
    return {
      users: opts.visibleRoles
        ? this.staff.filter((u) => opts.visibleRoles!.includes(u.role))
        : this.staff,
    };
  }
  async listByIds(): Promise<User[]> {
    return [];
  }
}

/**
 * In-memory feedback store.
 *
 * ⚠ IT MODELS THE SPARSE KEY, because that is where the real repository can go wrong: `unread` is
 * DELETED on acknowledge rather than set to null (DynamoDB rejects a NULL index key outright), and the
 * count is derived from its presence. A fake that tracked only `status` would let the route pass while the
 * badge stayed permanently non-zero in production.
 */
class FakeFeedback implements FeedbackRepository {
  rows: FeedbackReport[] = [];
  async create(report: FeedbackReport) {
    this.rows.push(report);
    return report;
  }
  async list(opts: { limit?: number } = {}): Promise<FeedbackPage> {
    const items = [...this.rows]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, opts.limit ?? 50);
    return { items, unreadCount: await this.unreadCount() };
  }
  async unreadCount() {
    return this.rows.filter((r) => r.unread === "NEW").length;
  }
  async acknowledge(id: string, adminId: string, at: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    row.status = "ACKNOWLEDGED";
    row.acknowledgedById = adminId;
    row.acknowledgedAt = at;
    // ⚠ DELETED, not nulled — see the class note.
    delete row.unread;
    return row;
  }
}

const build = (
  feedback?: FeedbackRepository,
  extra: { notifier?: FakeNotifier; staff?: User[] } = {}
) =>
  createIdentityRoutes({
    users: new NoUsers(extra.staff ?? []),
    ...(feedback ? { feedback } : {}),
    ...(extra.notifier ? { notifier: extra.notifier } : {}),
  });

/** A staff account for the recipient tests. */
const staffUser = (over: Partial<User>): User => ({
  id: "s1",
  email: "staff@example.com",
  name: "Staff",
  role: "ADMIN",
  authProvider: "COGNITO",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

/**
 * ── ⚠ FIXTURES DERIVED FROM THE BOUNDS, NOT WRITTEN OUT ─────────────────────────────────────
 *
 * Every report in this file used to be `message: "x"`. A 20-word floor
 * invalidated all of them at once, which is a useful warning: a fixture that happens to satisfy today's
 * rule is a test that silently changes meaning when the rule moves. `words(n)` builds exactly n words, so
 * the boundary cases below still sit ON the boundary if the numbers are revised — and a revision that
 * broke them would be a real failure rather than a fixture to patch.
 */
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

/** A report that passes both fields — the shape most tests here are not about. */
const VALID = {
  kind: "BUG" as const,
  subject: words(FEEDBACK_SUBJECT_BOUNDS.minWords),
  message: words(FEEDBACK_MESSAGE_BOUNDS.minWords),
};

const file = (
  app: ReturnType<typeof build>,
  body: unknown,
  who = { id: "u1", email: "p@example.com", role: "PARTICIPANT" }
) =>
  app.request("/v1/auth/feedback", { method: "POST", headers: asUser(who), body: JSON.stringify(body) });

describe("POST /v1/auth/feedback — anyone signed in may report", () => {
  it("⚠ ACCEPTS A PARTICIPANT — the most important reporter there is", async () => {
    const feedback = new FakeFeedback();
    const res = await file(build(feedback), VALID);

    expect(res.status).toBe(201);
    expect(feedback.rows).toHaveLength(1);
    expect(feedback.rows[0]).toMatchObject({
      kind: "BUG",
      status: "NEW",
      unread: "NEW",
      subject: VALID.subject,
    });
  });

  it("requires authentication", async () => {
    const res = await build(new FakeFeedback()).request("/v1/auth/feedback", {
      method: "POST",
      body: JSON.stringify(VALID),
    });
    expect(res.status).toBe(401);
  });

  it("⚠ takes WHO from the verified identity, never the body", async () => {
    // A client-supplied reporter would let anyone file as somebody else, and "who hit this" being
    // trustworthy is the entire value of an inbox over an email folder.
    const feedback = new FakeFeedback();
    await file(
      build(feedback),
      {
        ...VALID,
        kind: "FEEDBACK",
        reportedById: "somebody-else",
        reportedByEmail: "spoof@example.com",
        reportedByRole: "ADMIN",
        status: "ACKNOWLEDGED",
      },
      { id: "real-user", email: "real@example.com", role: "PARTICIPANT" }
    );

    expect(feedback.rows[0]).toMatchObject({
      reportedById: "real-user",
      reportedByEmail: "real@example.com",
      reportedByRole: "PARTICIPANT",
      // And a caller cannot file something pre-acknowledged to keep it out of the badge.
      status: "NEW",
    });
  });

  it("refuses an empty message rather than storing one", async () => {
    // An empty report is indistinguishable from a misclick and costs an administrator a read to find out
    // it says nothing.
    const feedback = new FakeFeedback();
    for (const message of ["", "   ", "\n\t"]) {
      const res = await file(build(feedback), { ...VALID, message });
      expect(res.status, JSON.stringify(message)).toBe(400);
      expect((await res.json()).code).toBe("MESSAGE_REQUIRED");
    }
    expect(feedback.rows).toHaveLength(0);
  });

  it("refuses an over-long PASTE on characters, not on words", async () => {
    /**
     * ⚠ THE CHARACTER CAP AND THE WORD CEILING MEASURE DIFFERENT THINGS AND BOTH ARE NEEDED. This input is
     * ONE word — under the 200-word ceiling and, by word count alone, too SHORT. Only the character cap
     * refuses it, and without that a single paste becomes a 400KB item at the storage layer.
     */
    const feedback = new FakeFeedback();
    const paste = "x".repeat(MAX_FEEDBACK_MESSAGE + 1);
    expect(countWords(paste), "one unbroken token").toBe(1);

    const res = await file(build(feedback), { ...VALID, message: paste });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("MESSAGE_TOO_LONG");
    expect(feedback.rows).toHaveLength(0);
  });

  it("accepts a message exactly at the character cap — the boundary is inclusive", async () => {
    // At the ceiling on BOTH axes at once: the maximum word count, padded to exactly the character cap.
    const filled = words(FEEDBACK_MESSAGE_BOUNDS.maxWords);
    const message = filled + "x".repeat(MAX_FEEDBACK_MESSAGE - filled.length);
    expect(message.length).toBe(MAX_FEEDBACK_MESSAGE);
    expect(countWords(message)).toBe(FEEDBACK_MESSAGE_BOUNDS.maxWords);

    const res = await file(build(new FakeFeedback()), { ...VALID, message });
    expect(res.status).toBe(201);
  });

  it("refuses an unrecognised kind rather than defaulting one", async () => {
    // BUG and FEEDBACK are triaged differently, so guessing would file a bug as a suggestion.
    const feedback = new FakeFeedback();
    for (const kind of [undefined, "bug", "OTHER", 7]) {
      const res = await file(build(feedback), { ...VALID, kind });
      expect(res.status, String(kind)).toBe(400);
      expect((await res.json()).code).toBe("KIND_INVALID");
    }
  });

  it("400s a malformed body rather than 500ing", async () => {
    const res = await build(new FakeFeedback()).request("/v1/auth/feedback", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_BODY");
  });

  it("⚠ BOUNDS every context field, so they cannot be used as unbounded storage", async () => {
    // Without caps a caller could put the payload the message limit refused into `location` instead.
    const feedback = new FakeFeedback();
    await file(build(feedback), {
      ...VALID,
      location: "/".repeat(5000),
      version: "v".repeat(500),
      workshopId: "w".repeat(500),
      teamId: "t".repeat(500),
    });
    const row = feedback.rows[0];
    expect(row.location!.length).toBe(200);
    expect(row.version!.length).toBe(40);
    expect(row.workshopId!.length).toBe(64);
    expect(row.teamId!.length).toBe(64);
  });

  it("normalises an unknown surface to portal, and keeps desktop", async () => {
    const feedback = new FakeFeedback();
    await file(build(feedback), { ...VALID, surface: "desktop" });
    await file(build(feedback), { ...VALID, surface: "mainframe" });
    expect(feedback.rows.map((r) => r.surface)).toEqual(["desktop", "portal"]);
  });

  it("503s when reporting is not wired, rather than throwing", async () => {
    const res = await file(build(undefined), VALID);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("FEEDBACK_UNAVAILABLE");
  });
});

/**
 * ── ⚠ HOW LONG A REPORT MAY BE, AND HOW SHORT ───────────────────────────────────────────────
 *
 * THE BOUNDS: subject 5–15 words, description 20–200 — ONE rule
 * for both kinds rather than a ceiling that changes with the kind.
 *
 * ⚠ EVERY BOUNDARY IS DERIVED FROM THE SHARED CONSTANT, never written as 5 / 15 / 20 / 200. These tests are
 * about the boundary being INCLUSIVE and about the refusal being specific — not about today's figures, which
 * have already moved once on the phase gate (100 → 50) and can move again. Hardcoding them would turn a
 * deliberate revision into four red tests to be "fixed" by editing the numbers back.
 *
 * ⚠ AND THIS IS THE ENFORCEMENT THAT COUNTS. Both forms and the desktop's main process run the same
 * validator, but a POST to this route need not come from any of them.
 */
describe("the word bounds on a report", () => {
  const S = FEEDBACK_SUBJECT_BOUNDS;
  const M = FEEDBACK_MESSAGE_BOUNDS;

  const codeFor = async (body: unknown) => {
    const feedback = new FakeFeedback();
    const res = await file(build(feedback), body);
    return { status: res.status, code: (await res.json()).code, stored: feedback.rows.length };
  };

  it("⚠ REQUIRES a subject — the field is not decoration", async () => {
    // It is the email's subject line and the inbox card's heading. A report without one is a wall of prose
    // that a triager can only tell apart from the next one by reading both.
    for (const subject of [undefined, "", "   "]) {
      const r = await codeFor({ ...VALID, subject });
      expect(r.status, JSON.stringify(subject)).toBe(400);
      expect(r.code).toBe("SUBJECT_REQUIRED");
      expect(r.stored).toBe(0);
    }
  });

  it("refuses a subject under the floor, and accepts it AT the floor", async () => {
    expect(await codeFor({ ...VALID, subject: words(S.minWords - 1) })).toMatchObject({
      status: 400,
      code: "SUBJECT_TOO_SHORT",
      stored: 0,
    });
    expect(await codeFor({ ...VALID, subject: words(S.minWords) })).toMatchObject({ status: 201 });
  });

  it("refuses a subject over the ceiling, and accepts it AT the ceiling", async () => {
    expect(await codeFor({ ...VALID, subject: words(S.maxWords) })).toMatchObject({ status: 201 });
    expect(await codeFor({ ...VALID, subject: words(S.maxWords + 1) })).toMatchObject({
      status: 400,
      code: "SUBJECT_TOO_LONG",
      stored: 0,
    });
  });

  it("refuses a description under the floor, and accepts it AT the floor", async () => {
    expect(await codeFor({ ...VALID, message: words(M.minWords - 1) })).toMatchObject({
      status: 400,
      code: "MESSAGE_TOO_SHORT",
      stored: 0,
    });
    expect(await codeFor({ ...VALID, message: words(M.minWords) })).toMatchObject({ status: 201 });
  });

  it("refuses a description over the ceiling, and accepts it AT the ceiling", async () => {
    expect(await codeFor({ ...VALID, message: words(M.maxWords) })).toMatchObject({ status: 201 });
    expect(await codeFor({ ...VALID, message: words(M.maxWords + 1) })).toMatchObject({
      status: 400,
      code: "MESSAGE_TOO_LONG",
      stored: 0,
    });
  });

  it("⚠ names the SUBJECT first when both fields are wrong", async () => {
    // It is the field above. Complaining about the lower one while the one above it is also wrong makes a
    // form feel like it is refusing at random, and the reporter fixes the wrong thing first.
    const r = await codeFor({ kind: "BUG", subject: "too short", message: "also too short" });
    expect(r.code).toBe("SUBJECT_TOO_SHORT");
  });

  it("counts words the way the SHARED counter does — not by splitting on single spaces", async () => {
    /**
     * ⚠ THE REGRESSION THIS CATCHES IS A SECOND IMPLEMENTATION OF "how many words is that". A newline- or
     * double-space-separated report is normal prose (steps on their own lines), and a naive `split(" ")`
     * counts the blank runs between them as words — so a report of 12 real words would pass a 20-word floor
     * the shared counter refuses, and the two ends of the same rule would disagree.
     */
    const spaced = Array.from({ length: M.minWords - 1 }, (_, i) => `w${i}`).join("\n\n");
    expect(countWords(spaced)).toBe(M.minWords - 1);
    expect(await codeFor({ ...VALID, message: spaced })).toMatchObject({
      status: 400,
      code: "MESSAGE_TOO_SHORT",
    });
  });

  it("trims before counting, so trailing whitespace is not a word", async () => {
    const r = await codeFor({ ...VALID, message: `  ${words(M.minWords)}  \n  ` });
    expect(r.status).toBe(201);
  });
});

describe("GET /v1/admin/feedback — the inbox is ADMIN + FACILITATOR", () => {
  const seed = (feedback: FakeFeedback, n: number) => {
    for (let i = 0; i < n; i += 1) {
      feedback.rows.push({
        id: `f${i}`,
        kind: "BUG",
        status: "NEW",
        subject: `subject of report ${i}`,
        message: `report ${i}`,
        reportedById: "u1",
        reportedByEmail: "p@example.com",
        reportedByRole: "PARTICIPANT",
        surface: "portal",
        version: null,
        location: null,
        workshopId: null,
        teamId: null,
        createdAt: `2026-08-1${i}T00:00:00.000Z`,
        unread: "NEW",
        acknowledgedAt: null,
        acknowledgedById: null,
      });
    }
  };

  for (const role of ["ADMIN", "FACILITATOR"]) {
    it(`serves a ${role}`, async () => {
      const feedback = new FakeFeedback();
      seed(feedback, 2);
      const res = await build(feedback).request("/v1/admin/feedback", {
        headers: asUser({ id: "a1", role }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as FeedbackPage;
      expect(body.items).toHaveLength(2);
      expect(body.unreadCount).toBe(2);
    });
  }

  for (const role of ["PARTICIPANT", "JUDGE", "EXECUTIVE"]) {
    it(`⚠ 403s a ${role} — the inbox is the privileged half`, async () => {
      const feedback = new FakeFeedback();
      seed(feedback, 1);
      const res = await build(feedback).request("/v1/admin/feedback", {
        headers: asUser({ id: "x", role }),
      });
      expect(res.status).toBe(403);
    });
  }

  it("returns NEWEST FIRST — an inbox is read from the top", async () => {
    const feedback = new FakeFeedback();
    seed(feedback, 3);
    const res = await build(feedback).request("/v1/admin/feedback", {
      headers: asUser({ id: "a1", role: "ADMIN" }),
    });
    const body = (await res.json()) as FeedbackPage;
    expect(body.items.map((r) => r.id)).toEqual(["f2", "f1", "f0"]);
  });

  it("clamps an absurd limit rather than honouring it", async () => {
    const feedback = new FakeFeedback();
    seed(feedback, 3);
    const res = await build(feedback).request("/v1/admin/feedback?limit=99999", {
      headers: asUser({ id: "a1", role: "ADMIN" }),
    });
    expect(res.status).toBe(200);
  });

  /**
   * ── ⚠ THE VISIBILITY MATRIX APPLIES TO THE INBOX TOO ─────────────────────────────────────
   *
   * This read previously returned stored rows VERBATIM, and every row carries the
   * reporter's raw Cognito sub, email and role. The router admits FACILITATOR as well as ADMIN,
   * so a facilitator opening the inbox learned the address and sub of any ADMIN who had filed a
   * report — the exact fact `USER_VISIBILITY_GRANTS` exists to withhold, because "knowing WHICH
   * accounts hold full platform access is itself the reconnaissance step".
   *
   * Every neighbouring read on this router already applied the matrix. The inbox did not.
   */
  describe("the reporter's identity is filtered per row", () => {
    /** One report filed BY an account holding `reporterRole`. */
    const filedBy = (reporterRole: string): FeedbackReport => ({
      id: "f1",
      kind: "BUG",
      status: "NEW",
      subject: "the deploy button is lying to me",
      message: "details",
      reportedById: "admin-sub-9",
      reportedByEmail: "boss@corp.example",
      reportedByRole: reporterRole,
      surface: "portal",
      version: null,
      location: null,
      workshopId: null,
      teamId: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      unread: "NEW",
      acknowledgedAt: null,
      acknowledgedById: null,
    });

    it("HIDES an ADMIN reporter's email and sub from a FACILITATOR", async () => {
      const feedback = new FakeFeedback();
      feedback.rows.push(filedBy("ADMIN"));

      const res = await build(feedback).request("/v1/admin/feedback", {
        headers: asUser({ id: "fac", role: "FACILITATOR" }),
      });

      expect(res.status).toBe(200);
      // Asserted against the RAW BODY as well as the parsed row: a field nested somewhere else in
      // the response would satisfy a per-key check and still leak.
      const raw = await res.clone().text();
      expect(raw).not.toContain("boss@corp.example");
      expect(raw).not.toContain("admin-sub-9");

      const body = (await res.json()) as FeedbackPage;
      const row = body.items[0] as unknown as Record<string, unknown>;
      expect(row.reportedByHidden).toBe(true);
      expect(row.reportedById).toBeUndefined();
      expect(row.reportedByEmail).toBeUndefined();
      // The ROLE stays: a triager has to know a report came from staff, and a role identifies
      // nobody on its own.
      expect(row.reportedByRole).toBe("ADMIN");
      // And the report itself is still fully readable — hiding the row would have lost a real bug.
      expect(row.subject).toBe("the deploy button is lying to me");
      expect(row.message).toBe("details");
    });

    it("shows an ADMIN reporter to another ADMIN", async () => {
      const feedback = new FakeFeedback();
      feedback.rows.push(filedBy("ADMIN"));

      const res = await build(feedback).request("/v1/admin/feedback", {
        headers: asUser({ id: "a1", role: "ADMIN" }),
      });

      const row = ((await res.json()) as FeedbackPage).items[0] as unknown as Record<string, unknown>;
      expect(row.reportedByEmail).toBe("boss@corp.example");
      expect(row.reportedById).toBe("admin-sub-9");
      expect(row.reportedByHidden).toBeUndefined();
    });

    it("shows every role a FACILITATOR is entitled to see", async () => {
      // The regression guard. A filter that hid everyone would pass the negative above and make
      // the inbox useless for the reports facilitators actually triage.
      for (const reporterRole of ["FACILITATOR", "JUDGE", "EXECUTIVE", "PARTICIPANT"]) {
        const feedback = new FakeFeedback();
        feedback.rows.push(filedBy(reporterRole));

        const res = await build(feedback).request("/v1/admin/feedback", {
          headers: asUser({ id: "fac", role: "FACILITATOR" }),
        });

        const row = ((await res.json()) as FeedbackPage).items[0] as unknown as Record<string, unknown>;
        expect(row.reportedByEmail, `reporter=${reporterRole}`).toBe("boss@corp.example");
        expect(row.reportedByHidden, `reporter=${reporterRole}`).toBeUndefined();
      }
    });

    it("applies the SAME filter on acknowledge, so it is not a one-click bypass", async () => {
      // The acknowledge route returns the same row shape. Filtering only the list would make
      // "mark as read" the way to read the reporter the list had just hidden.
      const feedback = new FakeFeedback();
      feedback.rows.push(filedBy("ADMIN"));

      const res = await build(feedback).request("/v1/admin/feedback/f1/acknowledge", {
        method: "POST",
        headers: asUser({ id: "fac", role: "FACILITATOR" }),
      });

      expect(res.status).toBe(200);
      const raw = await res.clone().text();
      expect(raw).not.toContain("boss@corp.example");
      expect(raw).not.toContain("admin-sub-9");
      const { report } = (await res.json()) as { report: Record<string, unknown> };
      expect(report.reportedByHidden).toBe(true);
    });
  });
});

describe("acknowledging clears the badge", () => {
  const one = (): FeedbackReport => ({
    id: "f1",
    kind: "BUG",
    status: "NEW",
    subject: "the board dropped a task",
    message: "x",
    reportedById: "u1",
    reportedByEmail: "p@example.com",
    reportedByRole: "PARTICIPANT",
    surface: "portal",
    version: null,
    location: null,
    workshopId: null,
    teamId: null,
    createdAt: "2026-08-17T00:00:00.000Z",
    unread: "NEW",
    acknowledgedAt: null,
    acknowledgedById: null,
  });

  it("⚠ REMOVES the sparse key, which is what actually decrements the counter", async () => {
    // Setting the status is cosmetic; the badge counts rows carrying `unread`. Forgetting the removal
    // leaves a permanently non-zero counter no amount of clicking can clear.
    const feedback = new FakeFeedback();
    feedback.rows.push(one());

    const res = await build(feedback).request("/v1/admin/feedback/f1/acknowledge", {
      method: "POST",
      headers: asUser({ id: "admin-1", role: "ADMIN" }),
    });

    expect(res.status).toBe(200);
    expect(feedback.rows[0]).toMatchObject({ status: "ACKNOWLEDGED", acknowledgedById: "admin-1" });
    expect(feedback.rows[0].unread).toBeUndefined();
    expect(await feedback.unreadCount()).toBe(0);
  });

  it("is IDEMPOTENT — two admins clicking at once is the normal case", async () => {
    const feedback = new FakeFeedback();
    feedback.rows.push(one());
    const app = build(feedback);
    const ack = () =>
      app.request("/v1/admin/feedback/f1/acknowledge", {
        method: "POST",
        headers: asUser({ id: "admin-1", role: "ADMIN" }),
      });

    expect((await ack()).status).toBe(200);
    expect((await ack()).status).toBe(200);
  });

  it("404s a report that does not exist", async () => {
    const res = await build(new FakeFeedback()).request("/v1/admin/feedback/nope/acknowledge", {
      method: "POST",
      headers: asUser({ id: "admin-1", role: "ADMIN" }),
    });
    expect(res.status).toBe(404);
  });

  it("403s a non-admin trying to acknowledge", async () => {
    const feedback = new FakeFeedback();
    feedback.rows.push(one());
    const res = await build(feedback).request("/v1/admin/feedback/f1/acknowledge", {
      method: "POST",
      headers: asUser({ id: "u1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(403);
    expect(feedback.rows[0].status).toBe("NEW");
  });
});

/**
 * ── ⚠ TELLING STAFF, WITHOUT THAT ABLE TO FAIL THE REPORT ──────────────────────────────────
 *
 * THE RULE: the backend emails the current experience facilitators and admins.
 *
 * The report is written BEFORE the notification is attempted, and the notification cannot change the
 * answer. Two of these tests are about that ordering, because getting it backwards would tell somebody
 * their bug report failed while it sat in the inbox — and they would file it again.
 */
describe("a new report notifies staff", () => {
  const message = VALID;

  it("addresses every ADMIN and FACILITATOR, and nobody else", async () => {
    /**
     * ⚠ THE RECIPIENT RULE IS THE ASSERTION. The ask named "facilitators and admins"; this service cannot
     * resolve one EXPERIENCE's owner (that id lives in the workshop context, which identity has no client
     * for), so all staff are told and the report's workshopId travels in the email.
     */
    const feedback = new FakeFeedback();
    const notifier = new FakeNotifier();
    const app = build(feedback, {
      notifier,
      staff: [
        staffUser({ id: "a1", email: "admin@example.com", role: "ADMIN" }),
        staffUser({ id: "f1", email: "fac@example.com", role: "FACILITATOR" }),
        // Present in the table and NOT a recipient: an inbox notification is staff business.
        staffUser({ id: "p1", email: "participant@example.com", role: "PARTICIPANT" }),
        staffUser({ id: "j1", email: "judge@example.com", role: "JUDGE" }),
      ],
    });

    const res = await file(app, message);

    expect(res.status).toBe(201);

    /**
     * ── ⚠ ONE SEND PER ROLE, WHICH THIS USED TO ASSERT THE OPPOSITE OF ────────────────────────
     *
     * It expected a SINGLE call carrying both addresses. That is the leak a security finding
     * reported (low): one SES send puts every address in Destination.ToAddresses, so every
     * facilitator reads every admin's address out of the header — the exact fact
     * USER_VISIBILITY_GRANTS.FACILITATOR withholds, and which the notifier already takes care to
     * withhold from the message BODY.
     *
     * The recipient RULE is unchanged and still the point of this test: all staff are told, and
     * non-staff are not. Only the delivery is split, so no list spans two visibility tiers.
     */
    expect(notifier.calls).toHaveLength(2);
    const lists = notifier.calls.map((c) => [...c.recipients].sort());
    expect(lists).toEqual(
      expect.arrayContaining([["admin@example.com"], ["fac@example.com"]])
    );
    // The property that matters, stated directly rather than inferred from the shape above: no
    // single send mixes an admin address with a non-admin one.
    for (const list of lists) {
      const admins = list.filter((e) => e === "admin@example.com");
      expect(admins.length === 0 || list.length === admins.length).toBe(true);
    }
    // And nobody outside staff was told, in any of the sends.
    const everyone = lists.flat();
    expect(everyone).not.toContain("participant@example.com");
    expect(everyone).not.toContain("judge@example.com");
  });

  it("⚠ STILL STORES AND STILL ANSWERS 201 WHEN THE NOTIFIER THROWS", async () => {
    // The row is already written. A notification failure must not be reported to the person who filed it,
    // or they will file it again and the inbox fills with duplicates of a report that landed.
    const feedback = new FakeFeedback();
    const notifier = new FakeNotifier("throws");
    const app = build(feedback, {
      notifier,
      staff: [staffUser({ email: "admin@example.com" })],
    });

    const res = await file(app, message);

    expect(res.status).toBe(201);
    expect(feedback.rows).toHaveLength(1);
  });

  it("⚠ NOTIFIES *AFTER* STORING, so a report is never announced before it exists", async () => {
    /**
     * The ordering, asserted rather than assumed. Notifying first would let an admin open the inbox from
     * the email and find nothing — and on a create failure, an email about a report that does not exist.
     */
    const order: string[] = [];
    const feedback = new FakeFeedback();
    const realCreate = feedback.create.bind(feedback);
    feedback.create = async (r) => {
      order.push("store");
      return realCreate(r);
    };
    const notifier = new FakeNotifier();
    const realNotify = notifier.notifyNewReport.bind(notifier);
    notifier.notifyNewReport = async (r, to) => {
      order.push("notify");
      return realNotify(r, to);
    };

    await file(build(feedback, { notifier, staff: [staffUser({ email: "a@example.com" })] }), message);

    expect(order).toEqual(["store", "notify"]);
  });

  it("sends nothing when there are no staff accounts, and still succeeds", async () => {
    // A platform with no admin accounts is a configuration state, not a failed report.
    const feedback = new FakeFeedback();
    const notifier = new FakeNotifier();
    const res = await file(build(feedback, { notifier, staff: [] }), message);

    expect(res.status).toBe(201);
    // ⚠ NO CALL AT ALL NOW, where this used to assert one call with an empty list. Sending per
    // role means no roles is no sends, which is a tidier expression of the same intent — and the
    // notifier's own "no addresses ⇒ nothing to do, and NOT an error" guard still covers the case
    // where a group somehow arrives empty.
    expect(notifier.calls).toHaveLength(0);
  });

  it("stores the report even with no notifier wired at all", async () => {
    // The notifier is optional; the record is not.
    const feedback = new FakeFeedback();
    const res = await file(build(feedback), message);
    expect(res.status).toBe(201);
    expect(feedback.rows).toHaveLength(1);
  });

  it("⚠ does NOT notify on an acknowledge — only on arrival", async () => {
    // Acknowledging is staff telling themselves they have seen it. Emailing them about their own click
    // would train them to filter the address the real reports arrive on.
    const feedback = new FakeFeedback();
    const notifier = new FakeNotifier();
    const app = build(feedback, { notifier, staff: [staffUser({ email: "a@example.com" })] });

    await file(app, message);
    const before = notifier.calls.length;
    await app.request(`/v1/admin/feedback/${feedback.rows[0].id}/acknowledge`, {
      method: "POST",
      headers: asUser({ id: "a1", role: "ADMIN" }),
    });

    expect(notifier.calls.length).toBe(before);
  });
});
