// ── THE UPLOAD ROUTE'S CONTRACT ──────────────────────────────────────────────────────────
//
// Validation is synchronous and its errors come back in the response; a valid file is
// acknowledged immediately; the outcome arrives by email.
//
// ⚠ THE MOST IMPORTANT TESTS HERE ARE THE REFUSALS, because they are the paths that RUN TODAY. The
// worker does not exist yet (the decision about where it lives is still open), so a valid file
// currently gets an honest 503 rather than a 202, and pinning that is what stops someone "fixing"
// the 503 into a 202 and promising an email nothing will send.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MAX_FILE_BYTES } from "@/lib/bulk-invite/contract";

/** The session the route sees. Reassigned per test. */
let session: unknown = null;

/**
 * The outbound bearer, mocked SEPARATELY from the session, and the split is the point.
 *
 * It used to arrive as `session.accessToken`, so one fixture drove both identity and credential.
 * The Cognito ID token is no longer copied onto the session object (it was being served to the
 * browser by `GET /api/auth/session`); routes read it from the
 * encrypted JWT cookie via `getAccessToken()`. Two sources in the route, so two fixtures here, which
 * is what keeps "signed in but holding no usable bearer" an expressible state below.
 */
let bearer: string | undefined = "tok";

vi.mock("@/lib/auth", () => ({
  auth: async () => session,
}));

vi.mock("@/lib/server-token", () => ({
  getAccessToken: async () => bearer,
}));

/** Swapped in the one test that needs a configured dispatcher. */
const dispatchMock = vi.fn();
let configured = false;

vi.mock("@/lib/bulk-invite/dispatch", () => ({
  isBulkDispatchConfigured: () => configured,
  dispatchBulkProvision: (req: unknown) => dispatchMock(req),
}));

const { POST } = await import("./[workshopId]/bulk-provision/route");

const HEADER = "team_name,email,platform_role,team_role";
const VALID = [HEADER, "Team Aurora,a@example.com,PARTICIPANT,LEAD"].join("\n");

function upload(body: string | ArrayBuffer, contentLength?: number) {
  const headers = new Headers();
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return POST(new Request("http://localhost/api/workshops/w1/bulk-provision", { method: "POST", body, headers }), {
    params: Promise.resolve({ workshopId: "w1" }),
  });
}

const asFacilitator = () => {
  session = { user: { id: "u1", email: "f@example.com", name: "Fac", role: "FACILITATOR" } };
  bearer = "tok";
};

beforeEach(() => {
  configured = false;
  dispatchMock.mockReset();
  asFacilitator();
});

describe("⚠ authorization comes first, before the body is even read", () => {
  /**
   * This is a privilege-amplification surface: one request that creates many accounts. A caller who
   * may not use it must not be able to make us spend a 64 KiB read and a parse, and must certainly
   * not learn whether their file was well-formed.
   */
  it.each(["PARTICIPANT", "EXECUTIVE", "JUDGE"])("403s a %s", async (role) => {
    session = { user: { id: "u", email: "e@example.com", role } };
    expect((await upload(VALID)).status).toBe(403);
  });

  it("401s an unauthenticated caller", async () => {
    session = null;
    expect((await upload(VALID)).status).toBe(401);
  });

  it("401s a session with no access token, even if the role looks right", async () => {
    // A session without a bearer cannot call any service, so proceeding would fail later and less
    // clearly. This is also the shape a FAILED TOKEN REFRESH produces: `getAccessToken()` returns
    // undefined when `refreshFailed` is set, which is the eviction mechanism the session callback
    // used to implement by withholding `session.accessToken`.
    session = { user: { id: "u", email: "e@example.com", role: "ADMIN" } };
    bearer = undefined;
    expect((await upload(VALID)).status).toBe(401);
  });

  it.each(["ADMIN", "FACILITATOR"])("lets a %s through to validation", async (role) => {
    session = { user: { id: "u", email: "e@example.com", role } };
    // 503 rather than 403: past the gate, valid file, no worker.
    expect((await upload(VALID)).status).toBe(503);
  });

  it("403s a role the app does not recognise, rather than defaulting open", async () => {
    session = { user: { id: "u", email: "e@example.com", role: "SUPERUSER" } };
    expect((await upload(VALID)).status).toBe(403);
  });
});

describe("⚠ the byte cap is enforced on the BYTES, not just the header", () => {
  it("413s when content-length claims too much, without reading the body", async () => {
    expect((await upload("small", MAX_FILE_BYTES + 1)).status).toBe(413);
  });

  /**
   * ⚠ THE HEADER IS A CLAIM. A chunked upload can omit it or lie, so the real enforcement is on the
   * received bytes. Trusting the header alone would let an oversized file through the one check that
   * exists to bound memory before a parse.
   */
  it("413s an oversized body that declared no content-length at all", async () => {
    const oversized = "x".repeat(MAX_FILE_BYTES + 10);
    expect((await upload(oversized)).status).toBe(413);
  });

  it("accepts a file at exactly the cap", async () => {
    // The boundary must pass, or the documented limit is a lie by one byte.
    const padding = "\n# ".padEnd(MAX_FILE_BYTES - VALID.length, "x");
    const atCap = VALID + padding;
    expect(new TextEncoder().encode(atCap).byteLength).toBeLessThanOrEqual(MAX_FILE_BYTES);
    expect((await upload(atCap)).status).toBe(503); // past the cap and validation
  });

  it("400s invalid UTF-8 rather than substituting replacement characters", async () => {
    // A U+FFFD inside an address would become a real invitation to a wrong address.
    const bad = new Uint8Array([...new TextEncoder().encode(HEADER + "\nTeam A,"), 0xff, 0xfe]);
    const res = await upload(bad.buffer as ArrayBuffer);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/UTF-8/);
  });
});

describe("part 1, validation errors come back in THIS response", () => {
  it("400s with per-line errors and creates nothing", async () => {
    const res = await upload([HEADER, "Team A,not-an-email,PARTICIPANT,"].join("\n"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.errors[0]).toMatchObject({ line: 2, column: "email" });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("⚠ never dispatches a file with even one bad row", async () => {
    configured = true;
    await upload([HEADER, "Team A,a@example.com,PARTICIPANT,", "Team B,bad,PARTICIPANT,"].join("\n"));
    // Validate-all-then-reject: the hand-off must not see a partially-valid plan.
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("400s a JUDGE row, the amplification control, at the route level", async () => {
    const res = await upload([HEADER, "Team A,a@example.com,JUDGE,"].join("\n"));
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].code).toBe("ROLE");
  });
});

describe("⚠ 'not enabled here' must not read as 'your file is wrong'", () => {
  /**
   * A 404 from the Team enqueue route means one specific thing: bulk upload is not deployed on this
   * environment. That is an OPERATOR problem, and reporting it as an upload error would send a
   * facilitator hunting a mistake in a spreadsheet that is already correct.
   *
   * This replaces the old "no dispatcher configured" 503. The BFF can no longer answer the
   * availability question itself, whether a worker exists depends on `EnableBulkProvision` in the
   * deployed stack, which it cannot see, so the truth comes from the attempt.
   */
  it("503s with BULK_NOT_ENABLED when the enqueue route is not deployed", async () => {
    configured = true;
    const { BackendError } = await import("@/lib/backend");
    dispatchMock.mockRejectedValue(new BackendError(404, "Not Found"));

    const res = await upload(VALID);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.code).toBe("BULK_NOT_ENABLED");
    // It still says the file is GOOD, so the work of fixing the CSV is not repeated.
    expect(body.valid).toBe(true);
    expect(body.teams).toBe(1);
    expect(body.error).toMatch(/not enabled/i);
    expect(body.error).toMatch(/nothing was created/i);
  });

  it("502s any other enqueue failure, and says nothing was created", async () => {
    configured = true;
    dispatchMock.mockRejectedValue(new Error("bus unavailable"));

    const res = await upload(VALID);
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.code).toBe("BULK_ENQUEUE_FAILED");
    // The hand-off is the FIRST side effect, so a failure here genuinely means nothing happened.
    expect(body.error).toMatch(/nothing was created/i);
  });
});

describe("part 2, a valid file is ACKNOWLEDGED, not applied", () => {
  beforeEach(() => {
    configured = true;
    dispatchMock.mockResolvedValue({ batchId: "01KZBATCH" });
  });

  /**
   * ⚠ 202, A REVERSAL OF THE PREVIOUS VERSION, AND THE REQUIREMENT: processing is entirely backend,
   * fire-and-forget from the front end. The work now runs in a worker, so the
   * honest answer here is "accepted" and the outcome arrives by email.
   */
  it("202s with the batch id and the counts", async () => {
    const res = await upload(VALID);

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      accepted: true,
      batchId: "01KZBATCH",
      teams: 1,
      members: 1,
    });
  });

  /**
   * ⚠ THE MESSAGE MUST SET BOTH EXPECTATIONS. "Accepted" alone would leave the operator watching a
   * page that will never change, they need to know they may leave AND that an email is coming.
   */
  it("tells them they can leave the page and that an email will follow", async () => {
    const body = await (await upload(VALID)).json();
    expect(body.message).toMatch(/leave this page/i);
    expect(body.message).toMatch(/email/i);
  });

  it("hands the worker the plan, the workshop and who asked", async () => {
    await upload(VALID);

    const req = dispatchMock.mock.calls[0][0];
    expect(req.workshopId).toBe("w1");
    expect(req.plan.members).toHaveLength(1);
    // The uploader is both the audit subject and the report's recipient.
    expect(req.requestedBy).toMatchObject({ email: "f@example.com", role: "FACILITATOR" });
    expect(req.token).toBe("tok");
  });

  /**
   * ⚠ NO CREDENTIAL AND NO BEARER IN THE RESPONSE. The 202 carries counts and an id, there is no
   * report to leak addresses through any more, which is a small side benefit of the switch.
   */
  it("leaks no credential and no bearer", async () => {
    const body = JSON.stringify(await (await upload(VALID)).json());
    expect(body.toLowerCase()).not.toContain("password");
    expect(body).not.toContain("tok");
  });
});
