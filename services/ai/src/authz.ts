import type { Context } from "hono";
import { requireIdentity } from "@praimana/service-shared";

/**
 * AUTHORIZATION for the AI service (authN already happened at the gateway).
 *
 * IMPORTANT boundary note: "is this user a MEMBER of this team?" is owned by the
 * TEAM service (it owns teamMembers), NOT by the AI service. In a fully decomposed
 * world the AI service answers that question one of two ways:
 *
 *   (a) call the Team service's `/teams/:id/access` endpoint (synchronous), or
 *   (b) keep a team-membership read-model fed by Team's `member.joined`/`member.left`
 *       events (asynchronous, no hot-path call).
 *
 * Both are injected via an interface so the route code doesn't care which. This
 * file defines that interface + a simple read-only-role check the AI service CAN
 * decide on its own (it knows the caller's role from the edge identity).
 */

/** Roles that may read but not write. Mirrors the monolith's READ_ONLY_ROLES;
 *  in the real cutover this comes from @praimana/shared. */
const READ_ONLY_ROLES = new Set(["EXECUTIVE"]);

/**
 * ── THE AUDIENCE FOR A PUBLISHED TEAM SUMMARY, OUTSIDE THE TEAM AND ITS ADMINISTRATORS ──────
 *
 * Exactly the two roles `requirePublishedSummaryRead`'s own header has always named for its
 * fourth branch: "JUDGE, and an EXECUTIVE who is not on the team". A judge reads it to score;
 * an off-team executive reads it as the sponsor of the programme it belongs to.
 *
 * ⚠ THIS SET IS THE HALF THAT WAS ORIGINALLY MISSING. Branch 4 asked
 * `entitlements.listEntitledWorkshopIds(role, c)` and then tested only whether the snapshot's
 * workshop was in the answer — the `role` was passed but never PREDICATED ON. And entitlement is
 * not role-restricted: Team's `GET /v1/entitlements/workshops` unions workshops from live
 * invitations with workshops reached through ANY team membership, for ANY role. So an ordinary
 * PARTICIPANT on team A in workshop W was "entitled to W" and could read the published summary
 * of every RIVAL team in W — mid-competition, with team ids visible from the workshop's own team
 * listing, so the path parameter was no secret either.
 *
 * ⚠ DELIBERATELY NOT `isScoringRole`. The evaluation service's equivalent set is JUDGE ALONE
 * (evaluation/src/authz.ts SCORING_ROLES), and reusing that name here would either silently
 * exclude the off-team EXECUTIVE this branch exists to serve, or — worse, if someone later
 * "aligned" the two — silently widen evaluation's scoring surface to executives. The two
 * questions are different: "may you score" and "may you read a published deliverable".
 *
 * ⚠ AND IT IS NOT `READ_ONLY_ROLES` either, which happens to contain EXECUTIVE today. That
 * constant answers "may you mutate", and a summary read is not a mutation question. Two sets
 * that coincide on one member are still two sets.
 */
const PUBLISHED_SUMMARY_AUDIENCE = new Set(["JUDGE", "EXECUTIVE"]);

/** Team-access decisions the AI service must ASK the Team context for. Injected
 *  (DIP) so it can be an HTTP client or an event-fed read-model. */
/**
 * FOUR METHODS, TWO PAIRS, mirroring GET /v1/teams/:teamId/access exactly:
 *
 *   canRead / canWrite               ADMINISTRATION — member, or staff who owns the
 *                                    workshop, or ADMIN.
 *   canReadContent / canWriteContent CONTENT — member of THIS team, full stop.
 *
 * EVERY ROUTE IN THIS SERVICE IS A CONTENT ROUTE. AI conversations are the most sensitive
 * thing the platform stores about a team's thinking, so the content pair is what routes.ts
 * uses — the thread-keyed routes included, via the team resolved from the thread.
 */
export interface TeamAccess {
  canRead(teamId: string, userId: string, role: string, auth?: AuthContext): Promise<boolean>;
  canWrite(teamId: string, userId: string, role: string, auth?: AuthContext): Promise<boolean>;
  /** May the caller read what this team AUTHORED? Membership only — no role branch. */
  canReadContent(
    teamId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<boolean>;
  /** Content read AND not a read-only role. */
  canWriteContent(
    teamId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<boolean>;
}

/**
 * The Hono Context an east-west implementation needs in order to re-present the
 * CALLER's own Bearer token (see forwardedIdentityHeaders). Optional on the
 * interface so in-memory/read-model implementations — and tests — can ignore it.
 */
export type AuthContext = Context;

/**
 * Which workshops this caller is entitled to. Mirrors the evaluation service's port of the
 * same name, deliberately — a judge's reach is one platform-wide question and the two
 * services must not develop different answers to it.
 *
 * Three-valued: "unavailable" is NOT "you have none". Returning an empty list on a failed
 * lookup would 403 a legitimate judge and read as a permissions problem rather than an
 * outage, sending them to support instead of showing a retry.
 */
export interface WorkshopEntitlements {
  listEntitledWorkshopIds(
    role: string,
    auth?: AuthContext
  ): Promise<{ workshopIds: string[]; truncated: boolean } | "unavailable">;
}

export function isReadOnlyRole(role: string): boolean {
  return READ_ONLY_ROLES.has(role);
}

/** Guard: caller must be able to read the team (ADMINISTRATION scope). Returns a
 *  Response to short-circuit with, or null to proceed. */
export async function requireTeamRead(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);
  const ok = await teamAccess.canRead(teamId, id, role, c);
  return ok ? null : c.json({ error: "Forbidden" }, 403);
}

/** Guard: caller must be able to write the team (ADMINISTRATION scope: readable AND not
 *  a read-only role). */
export async function requireTeamWrite(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);
  if (isReadOnlyRole(role)) return c.json({ error: "Read-only role" }, 403);
  const ok = await teamAccess.canWrite(teamId, id, role, c);
  return ok ? null : c.json({ error: "Forbidden" }, 403);
}

// ─── TEAM CONTENT: member-only ───────────────────────────────

/**
 * Guard: caller must be a MEMBER of the team to read its CONTENT.
 *
 * Distinct from requireTeamRead, which an ADMIN and a workshop-owning FACILITATOR both
 * pass. Team-authored content is the team's own, so a non-member gets 403 whatever their
 * platform role.
 *
 * FAIL-CLOSED IS INHERITED, not re-implemented: HttpTeamAccess reads a non-2xx, a timeout,
 * a connect error, a non-JSON body and an ABSENT FIELD all as false. So a Team service that
 * is down, slow, or older than this consumer 403s a content read — never 200s it.
 */
export async function requireTeamContentRead(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);
  const ok = await teamAccess.canReadContent(teamId, id, role, c);
  return ok ? null : c.json({ error: "Forbidden" }, 403);
}

/** Guard: caller must be a MEMBER and not a read-only role to write the team's CONTENT.
 *  The read-only check is local and first, so an EXECUTIVE costs no east-west hop. */
export async function requireTeamContentWrite(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);
  if (isReadOnlyRole(role)) return c.json({ error: "Read-only role" }, 403);
  const ok = await teamAccess.canWriteContent(teamId, id, role, c);
  return ok ? null : c.json({ error: "Forbidden" }, 403);
}

/**
 * Guard: may the caller READ a team's PER-MEMBER assessments?
 *
 * ── EXECUTIVE-ONLY, AND A MEMBER. ──
 *
 * Per-member AI insights are read only by executives; the team summary is read by executives
 * and judges. So this is the SAME guard shape as generating — `requireAssessmentGenerate` —
 * and the two are deliberately identical rather than shared by accident: reading a team's
 * per-member coaching and producing it are the same audience, so if one moves the other must.
 *
 * ── WHAT THIS TIGHTENS, AND WHY IT IS NOT requireTeamContentRead ──
 *
 * It used to be pure membership (`requireTeamContentRead`), so every teammate read every
 * other member's score, rationale and improvements. That was the earlier rule and the whole
 * feature was framed around it ("your team sees your insights"). Under the current rule the
 * other members see nothing, including their own row, and only the executive reads the page.
 *
 * ⚠ THE CONSEQUENCE, STATED RATHER THAN SMOOTHED OVER: a participant can no longer see the
 * coaching written about them. That makes this a REVIEW instrument rather than a
 * self-improvement one, and the welcome-page disclosure had to be rewritten because it
 * promised the opposite. If the intent ever returns to "help them improve", the change is to
 * let a caller read THEIR OWN row — not to widen this guard back to membership.
 *
 * MEMBERSHIP IS STILL REQUIRED. An executive who is not on this team is refused: the
 * assessments derive from members' private AI conversations and team chat, so executive is a
 * licence to review a team you belong to, not any team. An ADMIN, FACILITATOR or JUDGE has no
 * path here at all — the team SUMMARY is their surface (requirePublishedSummaryRead).
 */
/**
 * ── AI CONVERSATION WRITE: a participant's OWN chat, where an EXECUTIVE MAY take part ──────
 *
 * The motivating failure, from the desktop's own log:
 *
 *     [cli-assistant] sync failed (ai-chat): thread create failed: HTTP 403 —
 *     {"error":"Read-only role"}
 *
 * ⚠ THAT WAS SILENT DATA LOSS, not a permissions inconvenience. An EXECUTIVE could hold a full
 * conversation with the assistant on the desktop — it is written to local SQLite and answered
 * normally — and every push to the server was refused, so the transcript existed on one laptop and
 * nowhere else. The portal showed the thread as absent. `content length: 6522` in that log line is a
 * real conversation that had nowhere to go.
 *
 * ⚠ THIS IS THE THIRD PLACE THIS RULE APPLIES, and the shape is now settled:
 *   · `collaboration/src/authz.ts` — chat and the task board.
 *   · `workshop/src/authz.ts`      — the team's phase notes.
 *   · here                                     — the participant's own AI conversation.
 * Each is a narrow guard at the routes that are conversation and planning, and `isReadOnlyRole` is
 * untouched, so nothing else in this service or any other inherits the grant.
 *
 * ⚠ WHY NOT RELAX `requireTeamContentWrite` ABOVE. In THIS service it also gates nothing else — but
 * across the platform it gates twelve routes including the evaluation writes (submissions and SCORES)
 * and the source/repository writes. Keeping the relaxation local is what stops an executive gaining a
 * judging score by way of a chat fix.
 *
 * ⚠ MEMBERSHIP IS STILL THE WHOLE PROTECTION. `canReadContent` is pure membership of THIS team with
 * no role branch, so an executive can only write into a conversation belonging to a team they are in.
 * ADMIN and FACILITATOR still have no path to team content.
 *
 * ⚠ AND IT IS NOT A LICENCE OVER THE TEAM'S WORK PRODUCT. Submissions, scores, docs and commits
 * remain closed, and `requireAssessmentGenerate` below is a separate, deliberately EXECUTIVE-ONLY
 * rule for a different action — the two must not be confused.
 */
export async function requireAiConversationWrite(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);

  /**
   * Deliberately NOT `canWriteContent` — that folds the read-only refusal into the membership answer,
   * which is precisely the part being relaxed. Membership is asked with the READ predicate and the role
   * rule applied locally, so the two decisions stay separable. Same as the other two guards.
   */
  const isMember = await teamAccess.canReadContent(teamId, id, role, c);
  if (!isMember) return c.json({ error: "Forbidden" }, 403);

  // Every read-only role EXCEPT executive is still refused, so a read-only role added later does not
  // silently inherit this grant.
  if (isReadOnlyRole(role) && role !== "EXECUTIVE") {
    return c.json({ error: "Read-only role" }, 403);
  }

  return null;
}

export async function requireAssessmentRead(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);

  // Local check first, so a refused participant costs no east-west hop.
  if (!isReadOnlyRole(role)) {
    return c.json(
      {
        error:
          "Per-member AI assessments are visible to executives on this team. The team summary is the shared view.",
        code: "EXECUTIVE_ONLY",
      },
      403
    );
  }

  const ok = await teamAccess.canReadContent(teamId, id, role, c);
  return ok
    ? null
    : c.json(
        { error: "You are not a member of this team.", code: "NOT_A_TEAM_MEMBER" },
        403
      );
}

/**
 * Guard: may the caller GENERATE a team's AI assessment?
 *
 * ── EXECUTIVE-ONLY, AND IT IS THE ONE EXCEPTION TO THE READ-ONLY RULE ──
 *
 * The rule: only executives generate insights, not other participants. So this route does NOT use `requireTeamContentWrite` — that guard refuses
 * every read-only role, and EXECUTIVE is the read-only role, which is exactly
 * backwards for this one operation.
 *
 * WHY A DEDICATED GUARD RATHER THAN REMOVING EXECUTIVE FROM READ_ONLY_ROLES. That constant
 * gates roughly 35 write routes across seven services — chat, tasks, docs, commits, scores.
 * Widening it to unblock one button would hand executives write access to all of them and
 * contradict the investigation model the platform is built on, where an executive is precisely the
 * role that can READ a team's content and alter none of it. The narrow guard keeps that intact.
 *
 * ── WHAT IT STILL REQUIRES, AND WHY MEMBERSHIP IS NOT OPTIONAL ──
 *
 * MEMBERSHIP FIRST, via `canReadContent` — the same pure-membership predicate every other
 * content route uses. An executive who is NOT on this team is refused, because generating reads
 * every member's private AI conversations and team chat. "Executive" is not a licence to mine
 * an arbitrary team's messages; it is a licence to do so for a team they belong to. A platform
 * ADMIN or FACILITATOR is refused for the same reason and has no path here at all.
 *
 * So the rule is: EXECUTIVE **and** a member. Both, not either.
 *
 * ── WHY GENERATION IS GATED MORE TIGHTLY THAN READING ──
 *
 * Reading an assessment is member-wide, deliberately: the output is coaching, and the person it
 * describes must be able to see it. GENERATING costs billable model calls (one per member) and
 * decides what everyone else then reads, so it is the reviewer's action rather than the
 * reviewed's. That asymmetry is the point, not an oversight.
 */
export async function requireAssessmentGenerate(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);

  // LOCAL CHECK FIRST, so a refused participant costs no east-west hop — the same ordering
  // requireTeamContentWrite uses for the inverse reason.
  if (!isReadOnlyRole(role)) {
    return c.json(
      {
        error:
          "Generating a team assessment is an executive action. Ask an executive on this team to run it.",
        code: "EXECUTIVE_ONLY",
      },
      403
    );
  }

  // Then membership. Reading the whole team's private messages requires belonging to it.
  const ok = await teamAccess.canReadContent(teamId, id, role, c);
  return ok
    ? null
    : c.json(
        {
          error: "You are not a member of this team.",
          code: "NOT_A_TEAM_MEMBER",
        },
        403
      );
}

/**
 * Guard: may the caller read the PROMPTS behind a team's AI assessment?
 *
 * Same answer as generating — EXECUTIVE **and** a member of this team — because the disclosure
 * sits beside the Analyze button and describes what that button is about to do. If one audience
 * moves, the other must.
 *
 * ── ⚠ WHY THIS IS NOT `requireAssessmentGenerate`, WHICH TODAY DECIDES IDENTICALLY ──
 *
 * That guard tests `isReadOnlyRole(role)`, and `READ_ONLY_ROLES` contains EXECUTIVE *today* — the
 * set answers "may you mutate", which coincides with "are you an executive" only by accident of
 * there being one read-only role. This file's own header already warns about exactly that
 * coincidence for `PUBLISHED_SUMMARY_AUDIENCE`: two sets that agree on one member are still two
 * sets.
 *
 * Adding a second read-only role — an OBSERVER, or JUDGE losing write access — would silently
 * admit it to both the button and this disclosure. Generating is a judgement call about how tight
 * that route should be; the prompts were made EXECUTIVE-ONLY as a stated requirement, so the role
 * is asserted DIRECTLY here and pinned by a test that fails if `READ_ONLY_ROLES` grows. The
 * requirement then survives a change to a constant it never should have depended on.
 *
 * ⚠ MEMBERSHIP IS STILL THE SECOND HALF, and it is not ceremony even though the prompts are
 * identical for every team. An off-team executive learning nothing secret from the text is not the
 * point: `:teamId` is in the path, so answering 200 for an arbitrary team confirms that team
 * exists and that this caller is treated as privileged over it. Refusing keeps the surface
 * indistinguishable from every other per-team route, and it is what lets a per-team prompt land
 * later without widening anything.
 */
export async function requireAssessmentPromptRead(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);

  // LOCAL CHECK FIRST, so a refused participant costs no east-west hop.
  if (role !== "EXECUTIVE") {
    return c.json(
      {
        error:
          "The assessment prompts are visible to executives on this team, who are the only role that can generate an assessment.",
        code: "EXECUTIVE_ONLY",
      },
      403
    );
  }

  const ok = await teamAccess.canReadContent(teamId, id, role, c);
  return ok
    ? null
    : c.json(
        {
          error: "You are not a member of this team.",
          code: "NOT_A_TEAM_MEMBER",
        },
        403
      );
}

/**
 * Guard: may the caller read a team's PUBLISHED AI summary?
 *
 * ── THE TWO-AUDIENCE RULE THIS ENFORCES ──
 *
 * There are two model outputs with two audiences, and this guard is the whole of the wider
 * one. Per-member assessments (call A) are derived from members' actual message text and use
 * `requireTeamContentRead` with NO publish path anywhere in the code. The team summary (call
 * B) is derived from five integers per member — no text ever entered its prompt — so it can
 * be shown outside the team without risking disclosure of anything anyone wrote.
 *
 * ── WHY PUBLICATION, RATHER THAN A WIDER PREDICATE ──
 *
 * Publication is the platform's only mechanism for turning team-private material into
 * something an outsider may read — it is what makes a submission judge-readable. Reusing it
 * means disclosure requires a deliberate member action with a recorded actor, and an
 * UNPUBLISHED snapshot is invisible outside the team rather than merely unrendered.
 *
 * ── ORDER OF CHECKS, AND WHY ──
 *
 *  1. MEMBERSHIP FIRST, and it settles the common case locally-ish with one hop. This is
 *     also what makes an EXECUTIVE who is ON the team see everything a teammate sees:
 *     `canReadContent` is pure membership and ignores `role` deliberately, so no special
 *     case is needed for them — and none is wanted, because a special case is a thing to
 *     get wrong later.
 *  2. UNPUBLISHED ⇒ 404 for everyone else. Not 403: a 403 confirms a snapshot exists, which
 *     is itself information about a team an outsider is not part of.
 *  3. ADMINISTRATION reach (ADMIN, workshop-owning FACILITATOR) — a published deliverable is
 *     not what the member-only rule withdrew, which was ambient access to UNPUBLISHED content.
 *  4. Everyone else with a legitimate reason — JUDGE, and an EXECUTIVE who is not on the
 *     team — is admitted only on the snapshot's OWN stored workshopId. Server-derived at
 *     generation time, never read from the request, so a caller cannot name a workshop they
 *     happen to be entitled to and read a foreign team's summary through it.
 */
export async function requirePublishedSummaryRead(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string,
  snapshot: { workshopId: string | null; publishedAt: string | null } | null,
  entitlements?: WorkshopEntitlements
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);

  // 1. Members — including an EXECUTIVE on this team.
  if (await teamAccess.canReadContent(teamId, id, role, c)) return null;

  // 2. Nothing published ⇒ indistinguishable from nothing generated.
  if (!snapshot?.publishedAt) {
    return c.json(
      { error: "No published summary for this team", code: "SUMMARY_NOT_PUBLISHED" },
      404
    );
  }

  // 3. Administration scope.
  if (await teamAccess.canRead(teamId, id, role, c)) return null;

  // 4. Judges and off-team executives — admitted ONLY on the snapshot's OWN workshopId,
  //    which was server-derived at generation time. A caller cannot name a workshop they
  //    happen to be entitled to and read a foreign team's summary through it.
  //
  //    Reached only after membership and administration have both failed, so the entitlement
  //    hop costs nothing for the common case.

  // ── 4a. ⚠ THE ROLE HALF, WHICH WAS MISSING ──────────────────────────────────────────────
  //
  // ENTITLEMENT IS NOT A READING CREDENTIAL. Team's entitlement endpoint unions workshops from
  // live invitations with workshops reached through ANY team membership, for ANY role — so every
  // PARTICIPANT in workshop W is "entitled to W" and, without this predicate, could read every
  // RIVAL team's published summary in W. The branch's own header always said the audience was
  // "JUDGE, and an EXECUTIVE who is not on the team"; only the comment enforced it.
  //
  // The sibling service fixed the identical defect on the identical shape and its comment states
  // the rule this now follows — "ENTITLEMENT IS NOT A JUDGING CREDENTIAL … any PARTICIPANT or
  // EXECUTIVE on any team in workshop W is entitled to W" (evaluation/src/routes.ts).
  //
  // ⚠ LOCAL CHECK BEFORE THE EAST-WEST HOP, mirroring evaluation/src/authz.ts's ordering. A
  // refused participant costs no call to Team — which matters here because that is now the
  // overwhelmingly common way this branch is reached.
  if (!PUBLISHED_SUMMARY_AUDIENCE.has(role)) {
    return c.json({ error: "Forbidden", code: "SUMMARY_NOT_ENTITLED" }, 403);
  }

  if (!entitlements || !snapshot.workshopId) {
    // No way to establish entitlement ⇒ refuse. Fail closed, and say which of the two it is
    // so an operator is not left guessing whether it is configuration or permission.
    return c.json({ error: "Forbidden", code: "SUMMARY_NOT_ENTITLED" }, 403);
  }

  const entitled = await entitlements.listEntitledWorkshopIds(role, c);
  if (entitled === "unavailable") {
    // NOT a 403. An outage that reads as "you do not have access" sends a legitimate judge to
    // support instead of showing them a retry.
    c.header("Retry-After", "2");
    return c.json(
      { error: "Could not verify your access — try again shortly.", code: "ENTITLEMENTS_UNAVAILABLE" },
      503
    );
  }
  if (entitled.workshopIds.includes(snapshot.workshopId)) return null;

  return c.json({ error: "Forbidden", code: "SUMMARY_NOT_ENTITLED" }, 403);
}

