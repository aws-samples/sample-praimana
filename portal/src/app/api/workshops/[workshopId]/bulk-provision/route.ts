// ── BULK TEAM UPLOAD: VALIDATE, THEN APPLY, THEN REPORT ──────────────────────────────────
//
//   1. VALIDATION IS SYNCHRONOUS. Every problem with the file comes back in THIS response, with line
//      numbers, so the operator fixes it and re-uploads. Nothing is created.
//   2. A VALID FILE IS APPLIED and the response carries the real per-team, per-row outcome.
//
// ⚠ THIS WAS ORIGINALLY "ACKNOWLEDGE WITH 202, EMAIL THE RESULT LATER", and the change
// is recorded rather than quietly made. Building the worker showed the async design needed more than
// a Lambda: the portal has NO AWS SDK, services own AWS, the BFF orchestrates over HTTP, so it
// cannot publish an event; and the three-step invite sequence spans THREE bounded contexts
// (invitation rows are Team's write, the account is user-access's, the email is notify's), so no
// single service can own it either. A BFF is the legitimate cross-context orchestrator; it just
// cannot run after responding.
//
// At the expected scale, 3 teams, 18 members, that trade is small: ~20s of paced sending rather
// than the 80+ the async design was priced for. So the work runs here and the response is the
// outcome, which is strictly MORE informative than a 202 plus an email.
//
// ⚠ THE SEAM SURVIVES: `dispatchBulkProvision` still owns the hand-off, so making it asynchronous
// later changes one function rather than this route or the orchestration.
//
// ⚠ AND ATOMICITY IS NOT CLAIMED. No transaction spans the teams, so if team 2 of 3 fails, 1 and 3
// exist. Re-uploading is the recovery path, which is why a matching name ADDS to an existing team and
// an already-invited address is SKIPPED rather than re-invited.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAccessToken } from "@/lib/server-token";
import { MAX_FILE_BYTES } from "@/lib/bulk-invite/contract";
import { validateBulkCsv } from "@/lib/bulk-invite/validate";
import { dispatchBulkProvision, isBulkDispatchConfigured } from "@/lib/bulk-invite/dispatch";
import { auditLog } from "@/lib/audit-logger";

/** Only these two may set up a workshop, identical to the gate on team creation. */
const MAY_BULK_UPLOAD = new Set(["ADMIN", "FACILITATOR"]);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ workshopId: string }> }
) {
  const { workshopId } = await params;

  /**
   * ⚠ THE BEARER COMES FROM THE JWE COOKIE, NOT FROM THE SESSION OBJECT. It used to read
   * `session?.accessToken`, which required copying the Cognito ID token onto the session, and in
   * Auth.js v5 the session object is also the body of the public `GET /api/auth/session` that every
   * page fetches. Same value, read one tier lower.
   */
  const [session, token] = await Promise.all([auth(), getAccessToken(req)]);
  /**
   * ⚠ BOTH, EXPLICITLY. The old `if (!session?.accessToken)` made the session's presence implicit
   * in the token's, one read, so one check. Now that identity and bearer come from two calls, the
   * bearer alone must not authorize: everything below reads `session.user` for the role gate.
   */
  if (!token || !session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  /**
   * ⚠ ROLE FIRST, BEFORE THE BODY IS EVEN READ. This is a privilege-amplification surface, one
   * request that creates many accounts, so a caller who may not use it must not be able to make us
   * spend a 64 KiB read and a parse. `ownsWorkshop` is NOT checked here and cannot be: it needs the
   * Workshop service, and the Team service re-checks it as the authority.
   */
  const role = session.user?.role;
  if (!role || !MAY_BULK_UPLOAD.has(role)) {
    auditLog({
      event: "authz.bulk_provision.denied",
      actor: { id: session.user?.id, role },
      target: { workshopId },
      outcome: "denied",
      reason: `Role "${role}" is not permitted to bulk upload teams`,
    });
    return NextResponse.json(
      { error: "Only an admin or the facilitator who owns this experience can bulk upload teams." },
      { status: 403 }
    );
  }

  /**
   * ⚠ THE BYTE CAP IS APPLIED BEFORE DECODING, which is the whole reason this lives in the route
   * handler rather than in the validator. `Content-Length` is a claim and is checked first as a cheap
   * rejection; the real enforcement is on the received bytes, because a chunked upload can omit the
   * header or lie about it.
   */
  const claimed = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(claimed) && claimed > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: `That file is larger than ${MAX_FILE_BYTES / 1024} KB.` },
      { status: 413 }
    );
  }

  const raw = await req.arrayBuffer();
  if (raw.byteLength > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: `That file is larger than ${MAX_FILE_BYTES / 1024} KB.` },
      { status: 413 }
    );
  }

  // `fatal: true`, invalid UTF-8 must be REPORTED, not silently turned into replacement characters.
  // A U+FFFD inside an address would otherwise become a real invitation to a wrong address.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return NextResponse.json(
      { error: "That file is not valid UTF-8 text. Export it as CSV and try again." },
      { status: 400 }
    );
  }

  // ── PART 1: VALIDATE THE WHOLE FILE. Nothing is created if anything is wrong. ──
  const result = validateBulkCsv(text);
  if (!result.valid) {
    return NextResponse.json(
      {
        valid: false,
        rowCount: result.rowCount,
        errors: result.errors,
        truncated: result.truncated,
      },
      { status: 400 }
    );
  }

  /**
   * ⚠ REFUSE RATHER THAN ACKNOWLEDGE WHEN NOTHING CAN DO THE WORK.
   *
   * The 202 below promises an email. If no dispatcher is configured, that promise cannot be kept, and
   * an operator who receives it will assume their fifteen participants were invited. 503 with a plain
   * reason is the honest answer, and `Retry-After` is deliberately ABSENT, this is not transient,
   * it needs a deploy.
   */
  if (!isBulkDispatchConfigured()) {
    return NextResponse.json(
      {
        error:
          "Bulk upload is not enabled on this environment yet. Your file is valid, " +
          `${result.plan.teams.length} teams and ${result.plan.members.length} members, ` +
          "but nothing has been created. Invite these teams individually, or ask an administrator " +
          "to finish enabling bulk upload.",
        code: "BULK_DISPATCH_UNAVAILABLE",
        valid: true,
        teams: result.plan.teams.length,
        members: result.plan.members.length,
      },
      { status: 503 }
    );
  }

  // ── PART 2: HAND IT OFF AND ACKNOWLEDGE. ──
  //
  // ⚠ 202, NOT 200 WITH A REPORT, and this is a deliberate reversal of the previous version. The work
  // now runs in a worker because the requirement is that nobody waits for it: processing is
  // entirely backend, fire-and-forget from the front end. So the honest
  // answer here is "accepted", and the OUTCOME arrives by email.
  //
  // ⚠ THE ACKNOWLEDGEMENT MUST SET BOTH EXPECTATIONS: you may leave, and an email will follow. An
  // "accepted" with neither would leave the operator watching a page that will never change.
  try {
    const { batchId } = await dispatchBulkProvision({
      workshopId,
      plan: result.plan,
      requestedBy: {
        id: session.user?.id ?? "",
        email: session.user?.email ?? "",
        name: session.user?.name ?? undefined,
        role,
      },
      token,
    });

    auditLog({
      event: "account.bulk_provision.accepted",
      actor: { id: session.user?.id, role },
      target: { workshopId, batchId },
      outcome: "success",
      metadata: {
        teams: result.plan.teams.length,
        members: result.plan.members.length,
      },
    });

    return NextResponse.json(
      {
        accepted: true,
        batchId,
        teams: result.plan.teams.length,
        members: result.plan.members.length,
        message:
          `Your file is valid and is being processed: ${result.plan.teams.length} teams and ` +
          `${result.plan.members.length} members. You can leave this page, we will email you a ` +
          `report when it finishes, including anything that failed.`,
      },
      { status: 202 }
    );
  } catch (err) {
    /**
     * ⚠ NOTHING WAS CREATED, AND THE MESSAGE MUST SAY SO. The hand-off is the FIRST side effect, so a
     * failure here means the job never started, and the operator's instinct after any error is to
     * wonder whether half of it happened. Leaving that open invites either a duplicate upload or an
     * abandoned workshop.
     *
     * ⚠ A 404 HERE HAS A SPECIFIC MEANING WORTH SURFACING: the Team service's enqueue route is not
     * deployed, so bulk upload is not enabled on this environment. That is an operator problem, not a
     * problem with their file, and conflating the two sends them hunting a mistake that is not there.
     */
    const status = (err as { status?: number })?.status;
    const notDeployed = status === 404;

    console.error("[bulk-provision] failed to enqueue", {
      workshopId,
      status,
      error: err instanceof Error ? err.message : err,
    });

    return NextResponse.json(
      {
        error: notDeployed
          ? `Your file is valid, ${result.plan.teams.length} teams and ${result.plan.members.length} ` +
            `members, but bulk upload is not enabled on this environment yet, so nothing was created.`
          : "Your file is valid, but we could not start processing it. Nothing was created, " +
            "please try uploading it again.",
        code: notDeployed ? "BULK_NOT_ENABLED" : "BULK_ENQUEUE_FAILED",
        valid: true,
        teams: result.plan.teams.length,
        members: result.plan.members.length,
      },
      { status: notDeployed ? 503 : 502 }
    );
  }
}
