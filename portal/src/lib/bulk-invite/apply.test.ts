// ── APPLYING A PLAN: THE ORDER, THE SKIPS, AND THE PARTIAL FAILURES ──────────────────────
//
// This module creates real teams, real Cognito accounts and sends real email, so the assertions that
// matter are about what happens when part of it goes wrong. A green "it invited everyone" test proves
// almost nothing here; the value is in the torn seams.

import { describe, it, expect, vi, beforeEach } from "vitest";

const backendFetch = vi.fn();
const provisionAccounts = vi.fn();

vi.mock("@/lib/backend", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend")>("@/lib/backend");
  return { backendFetch: (...a: unknown[]) => backendFetch(...a), BackendError: actual.BackendError };
});
vi.mock("@/lib/provision", () => ({
  provisionAccounts: (...a: unknown[]) => provisionAccounts(...a),
}));
// No real 1.1s waits: the pacing itself is tested in send-pacer.test.ts.
vi.mock("@/lib/send-pacer", () => ({
  runPaced: async (items: unknown[], task: (i: unknown) => Promise<unknown>) =>
    Promise.allSettled(items.map((i) => task(i))),
}));

/**
 * ⚠ SET BEFORE THE MODULE LOADS. `APP_URL` is resolved at import time, and `applyBulkPlan` REFUSES to
 * send when it looks local, so without this every test here fails on the guard rather than on the
 * behaviour it is testing. That the whole file failed the moment the guard was added is the guard
 * working: it is exactly the mistake it exists to prevent, caught by the tests first.
 */
process.env.NEXT_PUBLIC_APP_URL = "https://portal.example.com";

const { applyBulkPlan } = await import("./apply");

const member = (email: string, over: Record<string, unknown> = {}) => ({
  line: 2,
  teamName: "Aurora",
  teamKey: "aurora",
  email,
  platformRole: "PARTICIPANT" as const,
  ...over,
});

const plan = (emails: string[], teamName = "Aurora") => ({
  teams: [{ teamKey: teamName.toLowerCase(), teamName, memberCount: emails.length }],
  members: emails.map((e) => member(e, { teamName, teamKey: teamName.toLowerCase() })),
});

/** Wire the four backend calls this module makes, keyed by path + method. */
function wire(opts: {
  existingTeams?: Array<{ id: string; name: string }>;
  existingInvitations?: Array<{ email: string; status?: string }>;
  createTeam?: () => unknown;
  createInvitations?: (emails: string[]) => unknown;
  notify?: () => unknown;
} = {}) {
  backendFetch.mockReset();
  backendFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    if (path.includes("/teams") && path.includes("/workshops") && method === "GET") {
      return { teams: opts.existingTeams ?? [] };
    }
    if (path.includes("/workshops") && method === "POST") {
      return opts.createTeam ? opts.createTeam() : { team: { id: "t-new", name: "Aurora" } };
    }
    if (path.includes("/invitations") && method === "GET") {
      return { invitations: opts.existingInvitations ?? [] };
    }
    if (path.includes("/invitations") && method === "POST") {
      const emails: string[] = JSON.parse(init!.body!).emails;
      return opts.createInvitations
        ? opts.createInvitations(emails)
        : { invitations: emails.map((e) => ({ email: e, token: `tok-${e}` })) };
    }
    if (path.includes("/notify/")) return opts.notify ? opts.notify() : { sent: 1 };
    throw new Error(`unmocked ${method} ${path}`);
  });

  provisionAccounts.mockReset();
  provisionAccounts.mockImplementation(async (emails: string[]) =>
    emails.map((email) => ({ ok: true, email, result: { temporaryPassword: "P@ss", alreadyExisted: false } }))
  );
}

beforeEach(() => wire());

describe("resolving a team by name", () => {
  it("CREATES a team whose name does not exist", async () => {
    const r = await applyBulkPlan("w1", plan(["a@example.com"]), "tok");
    expect(r.teamsCreated).toBe(1);
    expect(r.teamsMatched).toBe(0);
  });

  /**
   * Design decision 3: a matching name ADDS members rather than creating a near-duplicate team. This
   * is also what makes re-uploading the same file a safe recovery path.
   */
  it("MATCHES an existing team instead of creating a second one", async () => {
    wire({ existingTeams: [{ id: "t-1", name: "Aurora" }] });
    const r = await applyBulkPlan("w1", plan(["a@example.com"]), "tok");
    expect(r.teamsMatched).toBe(1);
    expect(r.teamsCreated).toBe(0);
    expect(r.teams[0].teamId).toBe("t-1");
  });

  it("matches on the NORMALISED name, so spacing and case do not split a team", async () => {
    wire({ existingTeams: [{ id: "t-1", name: "  team   AURORA " }] });
    const r = await applyBulkPlan("w1", plan(["a@example.com"], "Team Aurora"), "tok");
    expect(r.teamsMatched).toBe(1);
  });

  /**
   * ⚠ AMBIGUITY IS A REFUSAL, NOT A GUESS. Nothing enforces team-name uniqueness, so two teams can
   * normalise equal. Picking one would put people on the WRONG team with no way to tell.
   */
  it("FAILS the team when two existing teams share a name, naming both ids", async () => {
    wire({ existingTeams: [{ id: "t-1", name: "Aurora" }, { id: "t-2", name: "aurora" }] });
    const r = await applyBulkPlan("w1", plan(["a@example.com"]), "tok");

    expect(r.teams[0].disposition).toBe("failed");
    expect(r.teams[0].error).toContain("t-1");
    expect(r.teams[0].error).toContain("t-2");
    expect(r.failed).toBe(1);
  });

  /**
   * ⚠ REFUSE THE WHOLE RUN IF THE TEAM LIST CANNOT BE READ. Without it every name looks new, so it
   * would DUPLICATE every existing team, the worst available outcome, and silent.
   */
  it("throws rather than proceeding when the existing teams cannot be listed", async () => {
    backendFetch.mockReset();
    backendFetch.mockRejectedValue(new Error("upstream down"));

    await expect(applyBulkPlan("w1", plan(["a@example.com"]), "tok")).rejects.toThrow(/nothing was created/i);
  });
});

describe("⚠ an address already invited is SKIPPED, not re-invited", () => {
  /**
   * THE ASSERTION THAT MAKES RE-UPLOAD SAFE. `invitations.put` is an unconditional overwrite, so
   * re-inviting re-mints the token and INVALIDATES the link already in that person's inbox, and
   * emails them a second time. Skipping is what turns "upload it again" into a recovery path rather
   * than a way to break the first attempt.
   */
  it("skips a pending invitation and reports it as skipped, not failed", async () => {
    wire({
      existingTeams: [{ id: "t-1", name: "Aurora" }],
      existingInvitations: [{ email: "a@example.com", status: "PENDING" }],
    });

    const r = await applyBulkPlan("w1", plan(["a@example.com"]), "tok");

    expect(r.skipped).toBe(1);
    expect(r.invited).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.teams[0].members[0]).toMatchObject({ status: "skipped" });
  });

  it("does NOT skip a REVOKED invitation, that person needs a fresh one", async () => {
    wire({
      existingTeams: [{ id: "t-1", name: "Aurora" }],
      existingInvitations: [{ email: "a@example.com", status: "REVOKED" }],
    });
    const r = await applyBulkPlan("w1", plan(["a@example.com"]), "tok");
    expect(r.invited).toBe(1);
  });

  it("matches the existing invitation case-insensitively", async () => {
    wire({
      existingTeams: [{ id: "t-1", name: "Aurora" }],
      existingInvitations: [{ email: "A@EXAMPLE.COM", status: "PENDING" }],
    });
    expect((await applyBulkPlan("w1", plan(["a@example.com"]), "tok")).skipped).toBe(1);
  });

  /**
   * ⚠ FAILS OPEN, AND THE COMMENT IN THE SOURCE EXPLAINS WHY THAT IS THE LESSER EVIL: if the read
   * fails we cannot know who was invited. Skipping everyone would invite NOBODY and report success -
   * silent and unrecoverable. A duplicate invite is visible and fixable.
   */
  it("still invites when the existing-invitations read fails", async () => {
    wire({ existingTeams: [{ id: "t-1", name: "Aurora" }] });
    const orig = backendFetch.getMockImplementation()!;
    backendFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path.includes("/invitations") && (init?.method ?? "GET") === "GET") throw new Error("read failed");
      return orig(path, init);
    });

    expect((await applyBulkPlan("w1", plan(["a@example.com"]), "tok")).invited).toBe(1);
  });
});

describe("⚠ the three steps stay in their forced order", () => {
  /**
   * Row → account → email is non-negotiable: the pre-signup gate reads the row during
   * AdminCreateUser, and the email must carry the password that provisioning returns.
   */
  it("writes the invitation row BEFORE provisioning, and emails last", async () => {
    const order: string[] = [];
    wire({ existingTeams: [{ id: "t-1", name: "Aurora" }] });
    const orig = backendFetch.getMockImplementation()!;
    backendFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path.includes("/invitations") && init?.method === "POST") order.push("row");
      if (path.includes("/notify/")) order.push("email");
      return orig(path, init);
    });
    provisionAccounts.mockImplementation(async (emails: string[]) => {
      order.push("account");
      return emails.map((email) => ({ ok: true, email, result: { temporaryPassword: "P@ss" } }));
    });

    await applyBulkPlan("w1", plan(["a@example.com"]), "tok");
    expect(order).toEqual(["row", "account", "email"]);
  });

  it("does not provision or email when the invitation rows fail to write", async () => {
    wire({
      existingTeams: [{ id: "t-1", name: "Aurora" }],
      createInvitations: () => {
        throw new Error("table unavailable");
      },
    });

    const r = await applyBulkPlan("w1", plan(["a@example.com"]), "tok");

    expect(provisionAccounts).not.toHaveBeenCalled();
    expect(r.failed).toBe(1);
    expect(r.teams[0].members[0]).toMatchObject({ status: "failed" });
  });

  /**
   * ⚠ NO ACCOUNT WITHOUT A LINK. An account whose token never came back is a credential nobody can
   * act on, so provisioning is limited to addresses that got one.
   */
  it("fails an address whose row stored but returned no token, and does not provision it", async () => {
    wire({
      existingTeams: [{ id: "t-1", name: "Aurora" }],
      createInvitations: () => ({ invitations: [{ email: "a@example.com" }] }), // no token
    });

    const r = await applyBulkPlan("w1", plan(["a@example.com"]), "tok");

    expect(provisionAccounts).toHaveBeenCalledWith([], "tok");
    expect(r.teams[0].members[0].status).toBe("failed");
  });
});

describe("partial failure is reported per address, never as a whole-batch success", () => {
  it("reports a provisioning failure against its own address and still invites the others", async () => {
    wire({ existingTeams: [{ id: "t-1", name: "Aurora" }] });
    provisionAccounts.mockImplementation(async (emails: string[]) =>
      emails.map((email) =>
        email === "bad@example.com"
          ? { ok: false, email, failure: { reason: "InvalidParameterException" } }
          : { ok: true, email, result: { temporaryPassword: "P@ss" } }
      )
    );

    const r = await applyBulkPlan("w1", plan(["good@example.com", "bad@example.com"]), "tok");

    expect(r.invited).toBe(1);
    expect(r.failed).toBe(1);
    const bad = r.teams[0].members.find((m) => m.email === "bad@example.com")!;
    expect(bad.status).toBe("failed");
  });

  /**
   * ⚠ THE MOST EXPENSIVE PARTIAL FAILURE, and the message has to say what to DO. The row and the
   * account exist but the temporary password went out with an email that never sent, and it is
   * stored nowhere. "Resend" cannot work; only re-inviting mints a fresh one.
   */
  it("tells the operator to RE-INVITE when the email fails after the account was made", async () => {
    wire({
      existingTeams: [{ id: "t-1", name: "Aurora" }],
      notify: () => {
        throw new Error("SES rejected");
      },
    });

    const r = await applyBulkPlan("w1", plan(["a@example.com"]), "tok");

    expect(r.failed).toBe(1);
    expect((r.teams[0].members[0] as { reason: string }).reason).toMatch(/re-invite/i);
  });

  it("omits the temporary password for an account that ALREADY existed", async () => {
    // Sending it hands someone a credential that was never applied and silently does not work.
    wire({ existingTeams: [{ id: "t-1", name: "Aurora" }] });
    provisionAccounts.mockImplementation(async (emails: string[]) =>
      emails.map((email) => ({ ok: true, email, result: { temporaryPassword: "P@ss", alreadyExisted: true } }))
    );

    await applyBulkPlan("w1", plan(["a@example.com"]), "tok");

    const notifyCall = backendFetch.mock.calls.find((c) => String(c[0]).includes("/notify/"))!;
    expect(JSON.parse((notifyCall[1] as { body: string }).body)).not.toHaveProperty("temporaryPassword");
  });

  it("continues to the NEXT team after one team fails outright", async () => {
    wire({ existingTeams: [{ id: "t-1", name: "Dup" }, { id: "t-2", name: "dup" }] });
    const two = {
      teams: [
        { teamKey: "dup", teamName: "Dup", memberCount: 1 },
        { teamKey: "fine", teamName: "Fine", memberCount: 1 },
      ],
      members: [
        member("a@example.com", { teamName: "Dup", teamKey: "dup" }),
        member("b@example.com", { teamName: "Fine", teamKey: "fine" }),
      ],
    };

    const r = await applyBulkPlan("w1", two, "tok");

    // The ambiguous team fails; the other still gets created and invited.
    expect(r.teams[0].disposition).toBe("failed");
    expect(r.teams[1].disposition).toBe("created");
    expect(r.invited).toBe(1);
  });
});

describe("roles", () => {
  it("groups members by role so an EXECUTIVE and participants can share a team", async () => {
    wire({ existingTeams: [{ id: "t-1", name: "Aurora" }] });
    const mixed = {
      teams: [{ teamKey: "aurora", teamName: "Aurora", memberCount: 2 }],
      members: [
        member("exec@example.com", { platformRole: "EXECUTIVE" }),
        member("dev@example.com", { platformRole: "PARTICIPANT", teamRole: "BUILDER" }),
      ],
    };

    await applyBulkPlan("w1", mixed, "tok");

    const posts = backendFetch.mock.calls
      .filter((c) => String(c[0]).includes("/invitations") && (c[1] as { method?: string })?.method === "POST")
      .map((c) => JSON.parse((c[1] as { body: string }).body));

    // Two requests, because the endpoint takes ONE role per call.
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => p.platformRole).sort()).toEqual(["EXECUTIVE", "PARTICIPANT"]);
  });
});
