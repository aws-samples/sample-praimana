import type { Context } from "hono";
import { requireIdentity } from "@praimana/service-shared";

/**
 * AUTHORIZATION for the Evaluation service (authN already happened at the gateway).
 *
 * IMPORTANT boundary note: "is this user a MEMBER of this team?" is owned by the
 * TEAM service (it owns teamMembers), NOT by the Evaluation service. In a fully
 * decomposed world the Evaluation service answers that question one of two ways:
 *
 *   (a) call the Team service's `/teams/:id/access` endpoint (synchronous), or
 *   (b) keep a team-membership read-model fed by Team's `member.joined`/`member.left`
 *       events (asynchronous, no hot-path call).
 *
 * Both are injected via an interface so the route code doesn't care which. This
 * file defines that interface + role checks the Evaluation service CAN decide on
 * its own (it knows the caller's role from the edge identity).
 */

/** Roles that may read but not write. Mirrors the monolith's READ_ONLY_ROLES;
 *  in the real cutover this comes from @praimana/shared. */
const READ_ONLY_ROLES = new Set(["EXECUTIVE"]);

/**
 * Roles allowed to score a submission (judging is privileged).
 *
 * ⚠ JUDGE ALONE, AND ADMIN WAS REMOVED DELIBERATELY. It used to be
 * `["JUDGE", "ADMIN"]` on the reasonable-looking premise that an administrator can do
 * anything, which is no longer this platform's rule: an ADMIN is scoped to the experiences
 * they OWN (see ROLES.md), and inside those they are the OWNER rather than a judge.
 *
 * THE ASYMMETRY IS WHAT GAVE IT AWAY. A FACILITATOR has never been in this set, so an owner
 * who happened to be a facilitator could not score their own experience while an owner who
 * happened to be an admin could — the same person, the same experience, a different answer
 * decided by a platform role that says nothing about judging. Worse, ADMIN here was NOT
 * ownership-scoped, so an admin could score a submission in an experience belonging to
 * someone else, which is precisely the cross-experience reach the scoping change removed
 * everywhere else.
 *
 * WHAT IT COSTS, STATED PLAINLY: nobody can now score except an invited JUDGE. There is no
 * break-glass path for an experience whose judges never arrive — the owner cannot stand in.
 * That is the correct default for a ranking that will be published under judges' names, and
 * if a stand-in is ever wanted it needs to be its own explicit, attributed grant rather than
 * a side effect of holding the admin role.
 */
const SCORING_ROLES = new Set(["JUDGE"]);

/**
 * Roles that can OWN an experience. Used only to decide whether the "or owner" branch of the judging
 * list is worth a hop — the hop itself then checks actual ownership.
 *
 * ⚠ MEMBERSHIP OF THIS SET GRANTS NOTHING. A FACILITATOR who does not own the experience is refused
 * by the ownership comparison, exactly like a participant. It exists so a JUDGE's request does not
 * pay for a workshop read that could never admit them.
 */
const STAFF_ROLES = new Set(["FACILITATOR", "ADMIN"]);

/** Team-access decisions the Evaluation service must ASK the Team context for.
 *  Injected (DIP) so it can be an HTTP client or an event-fed read-model. */
/**
 * FOUR METHODS, TWO PAIRS, mirroring GET /v1/teams/:teamId/access exactly:
 *
 *   canRead / canWrite               ADMINISTRATION — member, or staff who owns the
 *                                    workshop, or ADMIN.
 *   canReadContent / canWriteContent CONTENT — member of THIS team, full stop.
 *
 * THIS SERVICE USES BOTH, and it is the only one that does — see the per-route notes in
 * routes.ts. Submissions and scores are DELIVERABLES, judged by people outside the team,
 * so they stay on the administration pair. Ratings/insights are DERIVED from the board,
 * the chat, the AI threads and the commits, so they move to the content pair.
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
  /**
   * THE WRITE DECISION AND THE TEAM'S WORKSHOP, FROM ONE CALL.
   *
   * `Submission.workshopId` used to be `body.workshopId || null`: the CALLER wrote the
   * value the scope check in requireScoringScope now rests on, which violates the
   * server-derived-scope rule and makes any guard built on it worthless. The workshop must
   * therefore be derived SERVER-SIDE, and the only context that can answer "which
   * workshop does this team belong to?" is Team — it owns the teams table, whose
   * PARTITION KEY is `workshopId`.
   *
   * ONE METHOD RATHER THAN A SEPARATE `resolveWorkshopId`, because each method here is
   * one east-west round trip: a fifth boolean method plus a scope method would put TWO
   * hops on the submission-create path. The design mandate is explicitly "no new hop", so the
   * decision and the scope come back together from the probe the route already made.
   *
   * THREE-VALUED, AND THAT IS THE WHOLE POINT. The other four methods collapse every
   * failure to `false`, which is correct for them: a denial and an unanswerable
   * question both mean "do not proceed". Here they must NOT collapse, because
   * `workshopId` is about to be PERSISTED — a hop that could not answer must produce a
   * 503, never a row written with a null scope. A null-scoped row is precisely the
   * legacy shape requireScoringScope has to refuse forever afterwards, so manufacturing
   * new ones on a brownout would be creating tomorrow's SUBMISSION_SCOPE_UNKNOWN.
   *
   * `workshopId: null` inside a DETERMINED answer means the callee resolved the team and
   * it has no workshop — in practice "no such team", since `workshopId` is the teams
   * table's partition key and no row can lack it. That is distinct from "unavailable"
   * and the caller answers 404 rather than 503.
   */
  writeScope(
    teamId: string,
    userId: string,
    role: string,
    auth?: AuthContext
  ): Promise<TeamWriteScope | "unavailable">;
}

/** A DETERMINED answer from `writeScope`: may they write, and what is the team's scope? */
export interface TeamWriteScope {
  canWrite: boolean;
  /** The team's workshop, or null when the team could not be resolved at all. */
  workshopId: string | null;
}

/**
 * The caller's ENTITLED WORKSHOP IDS — `E(self)` — asked of the Team context.
 *
 * A DELIBERATE SIXTH COPY of the interface in workshop/src/authz.ts, for the same
 * reason TeamAccess above is a copy: these are bundled Lambdas that take no dependency
 * on a workspace package, and the composition roots differ. The CONTRACT is identical,
 * including the failure semantics, so the two must not drift — evaluation's
 * workshop-entitlements.http.ts and workshop's are the same client against the same
 * route (`GET /v1/entitlements/workshops`).
 *
 * THERE IS NO ENTITLEMENTS TABLE AND THIS IS NOT A LOOKUP INTO ONE. An earlier
 * Workshop-local entitlement store design was withdrawn and never built; the live
 * mechanism is the Team route, which computes the union from invitations
 * (`email-index`) and team membership (`userId-index` → `teams`/`id-index`).
 *
 * Three-valued for the same reason as `writeScope`: `"unavailable"` is not "you are
 * entitled to nothing". Reading a failed hop as an empty set would turn a Team brownout
 * into "every judge is refused every submission", reported as a 403 that says "not your
 * workshop" — a misleading answer that sends debugging in the wrong direction.
 *
 * NO userId AND NO email PARAMETER, deliberately: the callee keys both halves of the
 * union on the caller's own VERIFIED claims, so this client cannot ask about anybody
 * else. An entitlement probe that takes a subject is an enumeration oracle for "who can
 * see which workshop".
 */
export interface WorkshopEntitlements {
  listEntitledWorkshopIds(
    role: string,
    auth?: AuthContext
  ): Promise<{ workshopIds: string[]; truncated: boolean } | "unavailable">;
}

/**
 * No-op entitlement source: nobody is entitled to anything, said DEFINITIVELY.
 *
 * `{ workshopIds: [] }` rather than `"unavailable"` because wiring this is a
 * CONFIGURATION choice ("this deployment has no entitlement source"), which is a
 * definite if restrictive answer. Reporting "unavailable" would 503 every judge's every
 * scoring attempt forever and look like a permanent incident. Mirrors
 * NoWorkshopEntitlements in workshop/src/authz.ts exactly.
 *
 * Note what this means when wired: a JUDGE can score NOTHING, and only an ADMIN
 * (short-circuited before the hop) can score at all. That is the safe direction.
 */
export class NoWorkshopEntitlements implements WorkshopEntitlements {
  async listEntitledWorkshopIds(): Promise<{
    workshopIds: string[];
    truncated: boolean;
  }> {
    return { workshopIds: [], truncated: false };
  }
}

/**
 * The Hono Context an east-west implementation needs in order to re-present the
 * CALLER's own Bearer token (see forwardedIdentityHeaders). Optional on the
 * interface so in-memory/read-model implementations — and tests — can ignore it.
 */
export type AuthContext = Context;

export function isReadOnlyRole(role: string): boolean {
  return READ_ONLY_ROLES.has(role);
}

export function isScoringRole(role: string): boolean {
  return SCORING_ROLES.has(role);
}

export function isStaffRole(role: string): boolean {
  return STAFF_ROLES.has(role);
}

/**
 * Guard: may the caller RELEASE this team's submission?
 *
 * ── THE FOURTH NARROW EXECUTIVE GRANT ──
 *
 * Release is an EXECUTIVE action and only an executive's: the team authors the draft, the executive
 * hands it over to be judged. Modelled on `ai/src/authz.ts`'s `requireAssessmentGenerate`, the
 * existing grant of the same shape — read-only role, one privileged verb, membership still required.
 *
 * ⚠ `role === "EXECUTIVE"` RATHER THAN `isReadOnlyRole(role)`, WHICH IS WHAT THE MODEL USES.
 * `READ_ONLY_ROLES` happens to contain exactly `EXECUTIVE` today, so the two are equivalent right
 * now — and they stop being equivalent the moment a second read-only role is added (an auditor, an
 * observer, a sponsor). That role would silently inherit the power to release every team's work.
 * Naming the role costs nothing and cannot acquire a member by accident.
 *
 * ⚠ NO `ADMIN` BREAK-GLASS. Taken literally from "only executives can submit". An
 * ADMIN is refused here exactly like a participant. The consequence is real and accepted: a team
 * whose executive is unreachable at the deadline has no path, mitigated by bulk provisioning
 * requiring an executive per team. It is recorded as an assumption rather than smuggled in as an
 * exception, because the alternative — an admin override nobody decided on — is the thing that
 * makes "only executives" untrue.
 *
 * LOCAL CHECK FIRST, so a refused participant costs NO east-west hop. The membership probe is
 * the CONTENT predicate (`canReadContent`), not the wide one: releasing publishes this team's phases
 * and artifacts to judges, which is a decision only someone inside the team should take.
 */
export async function requireSubmissionRelease(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);

  if (role !== "EXECUTIVE") {
    return c.json(
      {
        error:
          "Releasing a submission is an executive action. Ask an executive on this team to release it.",
        code: "EXECUTIVE_ONLY",
      },
      403
    );
  }

  const ok = await teamAccess.canReadContent(teamId, id, role, c);
  return ok
    ? null
    : c.json({ error: "You are not a member of this team.", code: "NOT_A_TEAM_MEMBER" }, 403);
}

/**
 * ── ⚠ WRITING THE DRAFT IS AN EXECUTIVE ACTION TOO — THE FIFTH NARROW GRANT ────────────────
 *
 * THE RULE: only executives submit. Before this guard existed, an executive
 * opening the Submit tab was told *"This team hasn't started a submission yet — a team member needs to
 * open this tab first."*
 *
 * ── ⚠ THAT INSTRUCTION WAS IMPOSSIBLE TO FOLLOW, AND THE DESIGN SAYS SO IN TWO PLACES ──
 *
 * The design held that "authoring stays with the team": members create and patch the draft, the
 * executive only releases. The very same section then observes that `/w/<id>/t/<teamId>/submit` is a
 * STAFF screen — `isForbiddenPath` sends every non-staff role to `/welcome` — and concludes that an
 * executive is *"the only role that can both reach the tab and hold a membership row"*.
 *
 * Both statements are true and together they are a deadlock: the only person who can REACH the form is
 * the one role forbidden from USING it. With the desktop Deliverables panel dropped there
 * is no other client for `POST`/`PATCH` at all — so no draft could be created, no `demoUrl` could ever
 * be set, and release precondition P4 was unsatisfiable by anybody. The flow was complete and unusable,
 * and the message a user finally saw was the deadlock surfacing as advice.
 *
 * ── ⚠ STILL A DEDICATED GUARD, NOT A RELAXATION OF `READ_ONLY_ROLES` ──
 *
 * `EXECUTIVE` stays in that constant. That reasoning is unchanged and is the reason this is a fifth
 * narrow grant rather than a one-word edit: the constant gates ~35 write routes across seven services,
 * and the workshop service names what a blanket relaxation would cost — *"Relaxing it would also hand
 * executives the evaluation writes (submissions and SCORES). An executive writing judging scores is a
 * competition-integrity problem"*. **Scores are untouched.** Only the draft's own create and patch move.
 *
 * ── ⚠ EXECUTIVE *AND* A MEMBER OF THIS TEAM. BOTH. ──
 *
 * Same shape as `requireSubmissionRelease`, and for the same reason: "executive" is not a licence over
 * an arbitrary team's submission. `canReadContent` is the CONTENT predicate deliberately — what is being
 * created here becomes the thing judges read.
 *
 * ⚠ AND THIS TAKES A WRITE PATH AWAY FROM MEMBERS, which is a real narrowing and is the rule. It has
 * no client to break: the desktop panel that would have used it was never built, and the portal's Submit
 * tab is staff-only. A PARTICIPANT now receives the same `EXECUTIVE_ONLY` refusal they would have got
 * from `release`, which is at least coherent — previously they could create a draft they could not reach.
 *
 * ⚠ RESIDUAL RISK, RECORDED RATHER THAN DISCOVERED: a team with NO executive member cannot submit at
 * all. That is the same exposure already flagged for release ("a team whose executive is
 * unreachable at the deadline with no path"), now widened from one action to three. If an ADMIN
 * break-glass is wanted it should be added deliberately, to release and these together.
 */
export async function requireSubmissionDraftWrite(
  c: Context,
  teamAccess: TeamAccess,
  teamId: string
): Promise<Response | TeamWriteScope> {
  const { id, role } = requireIdentity(c);

  // ── STEP 1: LOCAL, so a refused non-executive costs NO east-west hop.
  if (role !== "EXECUTIVE") {
    return c.json(
      {
        error:
          "Filling in and submitting this team's demo is an executive action. Ask an executive on this team to do it.",
        code: "EXECUTIVE_ONLY",
      },
      403
    );
  }

  /**
   * ── ⚠ STEP 2: `writeScope` FIRST, AND IT IS HERE FOR ITS THREE-VALUED ANSWER ───────────────
   *
   * NOT for `canWrite`, which is useless to an executive (it conflates membership with the read-only
   * rule and returns false either way). It is here because it is the ONLY predicate on this interface
   * that can say **"unavailable"**.
   *
   * ⚠ A TEST CAUGHT THIS, AND IT WOULD HAVE BEEN A VIOLATION OF THE UNAVAILABLE-NOT-AN-ANSWER RULE. The first version of this guard
   * asked only `canReadContent` — which is BOOLEAN, and whose client returns `DENY_ALL` on any failure
   * (`team-access.http.ts`: `catch { return DENY_ALL }`). So a Team-service brownout would have told an
   * executive **"You are not a member of this team"** on their own team, and `PATCH` would have lost the
   * `503 TEAM_SCOPE_UNAVAILABLE` it used to return. That is exactly "an unanswered question reported as
   * an answer", and the existing test `503s with Retry-After when team scope is unavailable — never a
   * guess` failed on it rather than my noticing.
   *
   * ⚠ NOTE THE SAME FLAW EXISTS IN `requireSubmissionRelease` ABOVE, which asks `canReadContent` alone —
   * so a brownout makes RELEASE answer `NOT_A_TEAM_MEMBER` instead of a 503. Recorded here rather than
   * fixed silently in the same change: it is a separate defect on a separate route with its own tests.
   */
  const scope = await teamAccess.writeScope(teamId, id, role, c);
  if (scope === "unavailable") {
    console.warn("[submissions] team scope unavailable — refusing rather than guessing at membership", {
      teamId,
      userId: id,
    });
    c.header("Retry-After", "2");
    return c.json(
      {
        error:
          "Your submission can't be saved right now. This is a temporary problem, not a change to your access.",
        code: "TEAM_SCOPE_UNAVAILABLE",
      },
      503
    );
  }

  /**
   * ── STEP 3: MEMBERSHIP. `canReadContent` is the CONTENT predicate deliberately — what is being
   * written becomes the thing judges read, so the question is "are you inside this team", not "may you
   * administer it".
   *
   * A `false` HERE IS TRUSTWORTHY in a way it was not in step 2: Team has already answered once on this
   * request, so it is reachable, and a denial is a real denial rather than a swallowed failure. Not
   * airtight — Team could fail between the two calls — but the difference between "usually right" and
   * "wrong on every brownout" is the whole point.
   */
  const ok = await teamAccess.canReadContent(teamId, id, role, c);
  if (!ok) {
    return c.json({ error: "You are not a member of this team.", code: "NOT_A_TEAM_MEMBER" }, 403);
  }

  // The team's workshop, for the caller that needs to store it. PATCH ignores it.
  return scope;
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

/**
 * Guard: caller must be able to write the team (ADMINISTRATION scope: readable AND not
 * a read-only role).
 *
 * ⚠ NO LONGER CALLED BY A ROUTE IN THIS SERVICE, and kept deliberately rather than deleted.
 * Its one caller was `POST /teams/:teamId/submissions`, which now uses `TeamAccess.writeScope`
 * instead — it needs the SAME decision plus the team's workshop from ONE hop,
 * and calling this guard as well would double the east-west traffic on the create path to
 * learn nothing new. The route reproduces this function's two answers exactly: the local
 * read-only 403 first, then the `{ error: "Forbidden" }` 403 on a refusal.
 *
 * Retained because it is the reference shape every other service's write guard mirrors, it is
 * asserted by authz.test.ts (including the property that an EXECUTIVE is refused WITHOUT a
 * hop), and the next write route added here should use it rather than reinvent the ladder.
 */
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
 * Guard: caller must hold a scoring role — which now means JUDGE and nothing
 * else. See SCORING_ROLES for why ADMIN left.
 *
 * ROLE ONLY, AND THAT IS NOW CORRECT RATHER THAN A GAP. This used to be the WHOLE of the
 * scoring gate — any JUDGE scored any submission in any workshop, and this function's own
 * comment conceded it ("which submissions a judge may score is backlog step 8 …
 * Deliberately left as role-only for now"). It is no longer the whole gate: it is the
 * cheap LOCAL half, and requireScoringScope below is the resource-aware half (BACKLOG P0-3).
 *
 * The split is deliberate and the ORDER is load-bearing. This decides from the token
 * alone, so a PARTICIPANT is refused with no store read and no east-west hop — which also
 * means a non-judge cannot use the difference between 404, 403-scope and 201 to probe
 * which submission ids exist, or which workshop one belongs to.
 */
export function requireScoringRole(c: Context): Response | null {
  const { role } = requireIdentity(c);
  return isScoringRole(role) ? null : c.json({ error: "Judge role required" }, 403);
}

// ─── WORKSHOP SCOPE ON SCORING (BACKLOG P0-3) ──────────────────

/**
 * The four outcomes of "may this caller act on this submission's workshop?".
 *
 * FOUR AND NOT TWO, because the three refusals have genuinely different causes and an
 * operator paged at 3am must be able to tell them apart from the response body alone:
 *
 *   deny           the caller is not entitled to that workshop. An authorization answer.
 *   scope-unknown  the SUBMISSION carries no workshop. A DATA problem, not an access one.
 *   unavailable    we could not find out. Neither an answer nor a denial — a 503.
 *
 * Collapsing `unavailable` into `deny` is the specific mistake this shape prevents, and it
 * is not hypothetical on this platform: a fail-closed catch reporting an infrastructure
 * fault as an authorization answer told a workshop's owner they were not its owner.
 * A judge told "not your workshop" mid-judging, when the truth
 * is "Team is briefly unreachable", is the same defect on the same platform.
 */
type ScopeDecision = "allow" | "deny" | "scope-unknown" | "unavailable";

/**
 * The scope predicate itself, shared by the WRITE guard and the read widening so the
 * two cannot drift into disagreeing about which submissions a judge may touch. A judge who
 * may score a submission must be able to read it; that property is only guaranteed if both
 * paths evaluate the SAME function.
 *
 * THE ORDER IS THE DESIGN — every local branch precedes the one hop:
 *
 *   1. submission.workshopId absent → scope-unknown. From the row already loaded. NO HOP.
 *   2. entitled to that workshop?  → ONE bounded hop, reached only when 1 misses.
 *
 * ⚠ THERE WAS A STEP 0 — `if (role === "ADMIN") return "allow"` — AND REMOVING IT WAS THE POINT
 * OF THE OWNERSHIP-SCOPING PASS. Its comment called it "A DOCUMENTED CONDITION, not an optimisation"
 * (the original condition 2: "ADMIN and owner short-circuit before any hop, asserted by a test that
 * fails if the injected entitlement is called for either"), and described the admin as "the
 * operator escape hatch" whose path "must survive a Team brownout that would 503 everyone else".
 *
 * ⚠ IT WAS ALSO THE LAST WAY INTO A STRANGER'S EXPERIENCE, and it would have SILENTLY DEFEATED
 * the fix applied to `GET /workshops/:workshopId/submissions` in the same pass. That route now
 * admits a staff caller only when `workshop.ownerId === callerId` and otherwise falls through to
 * `requireScoringScope` — i.e. to THIS function. Had step 0 survived, a non-owning admin would
 * have been refused by the owner check and then allowed by the scope predicate one line later.
 * Two changes, either of which is inert without the other; both are pinned by a mutation-checked
 * test in routes.test.ts.
 *
 * An ADMIN now resolves exactly like anyone else: entitled or not. Since entitlements are built
 * from invitations and memberships, and an admin holds neither, in practice a non-owning admin is
 * denied — which is the rule. ⚠ The original condition 2 is wrong as written and needs amending.
 *
 * STEP 1 BEFORE STEP 2 IS ALSO DELIBERATE. A submission with no workshop cannot be inside
 * anyone's entitlement set, so asking would spend a hop to reach a foregone conclusion —
 * and it would report the answer as `deny`, hiding a data defect behind a permission
 * message. Legacy null-scoped rows exist IN PRINCIPLE (the field was client-supplied and
 * defaulted to null until this change) even though the table holds zero rows today, and
 * `SUBMISSION_SCOPE_UNKNOWN` is what tells an operator which of the two they are looking at.
 */
async function decideSubmissionScope(
  c: Context,
  entitlements: WorkshopEntitlements,
  submissionWorkshopId: string | null | undefined,
  role: string
): Promise<ScopeDecision> {
  // 1 — local, from the row the caller already loaded.
  if (typeof submissionWorkshopId !== "string" || submissionWorkshopId === "") {
    return "scope-unknown";
  }

  // 2 — the one hop.
  const entitled = await entitlements.listEntitledWorkshopIds(role, c);
  if (entitled === "unavailable") return "unavailable";

  // `includes` over an array the callee caps at 50 ids (MAX_WORKSHOP_IDS in Team's
  // GET /entitlements/workshops), so this is a bounded linear scan, not an unbounded one.
  // Deliberately NOT a Set: building one costs an allocation per request to search at most
  // 50 short strings, which is slower than the scan it would replace.
  //
  // NOTE ON `truncated`: a truncated set can only make this UNDER-grant (a judge entitled
  // to more than 50 workshops is refused the 51st), never over-grant. Refusing the request
  // outright on truncation would deny the 50 they can legitimately score in order to be
  // precise about the one they cannot, so the cap is accepted here exactly as the workshop
  // LIST accepts it — and the callee already logs it.
  return entitled.workshopIds.includes(submissionWorkshopId) ? "allow" : "deny";
}

/**
 * Guard: may this caller SCORE this submission? — the fix for P0-3.
 *
 * THE DEFECT THIS CLOSES. Scoring was gated on requireScoringRole alone, so any JUDGE
 * scored any submission in ANY workshop: a judge invited to nothing, on no team, whom the
 * Team context refused everything, got 201 CREATED, the Score row landed against a foreign
 * workshop's deliverable, and `submission.scored` was published for it. The scoping
 * decision consulted NOTHING — proven by a recon spec asserting the injected port recorded
 * zero predicate calls.
 *
 * CALLED WITH THE SUBMISSION ALREADY LOADED, deliberately. The route resolves it for the
 * integrity check (a score must not be written against an id that does not exist), so the
 * scope is decided on the STORED record — never on the request. That is the same rule the
 * two read routes follow, and it is what stops a caller naming their own workshop.
 */
export async function requireScoringScope(
  c: Context,
  entitlements: WorkshopEntitlements,
  submissionWorkshopId: string | null | undefined
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);
  const decision = await decideSubmissionScope(c, entitlements, submissionWorkshopId, role);

  switch (decision) {
    case "allow":
      return null;

    case "scope-unknown":
      // A DATA problem reported as one. 403 rather than 500 because the caller genuinely
      // may not proceed, and rather than a plain "Forbidden" because an operator seeing
      // this needs to look at the ROW, not at the judge's invitations. Refused and not
      // silently allowed: this row's scope is unknown, so no scope check can pass on it.
      console.warn("[authz] submission has no workshop scope — refusing the score", {
        judgeId: id,
        role,
      });
      return c.json(
        {
          error:
            "This submission is not linked to a workshop, so it cannot be scored. Please report it.",
          code: "SUBMISSION_SCOPE_UNKNOWN",
        },
        403
      );

    case "unavailable":
      // 503, NEVER 403, and never a pass (the central rule). Retry-After 2s
      // matches every other east-west 503 on this platform: long enough that a retry
      // lands after a transient blip rather than adding to it.
      console.warn("[authz] entitlements unavailable — 503, not a denial and not a pass", {
        judgeId: id,
        role,
      });
      c.header("Retry-After", "2");
      return c.json(
        {
          error:
            "Your judging access can't be verified right now. This is a temporary problem, not a change to your access.",
          code: "ENTITLEMENTS_UNAVAILABLE",
        },
        503
      );

    case "deny":
      return c.json(
        {
          error: "Forbidden: you are not judging this workshop",
          code: "WORKSHOP_NOT_ENTITLED",
        },
        403
      );
  }
}

/**
 * Guard for the two submission READ routes.
 *
 * `(team read) OR (scoring role AND entitled to the submission's workshop)`.
 *
 * WHY IT HAD TO WIDEN. A JUDGE is not a member of the teams they judge, so
 * `requireTeamRead` refused them BOTH reads — they could POST a score and could not read
 * the submission they were scoring, nor the resulting scores. The design states that scoping the
 * write without widening the read "produces judges who can score but not read", which is a
 * functional dead end. The recon suite pinned that asymmetry as the CURRENT answer and this
 * is the deliberate change it predicted.
 *
 * WIDENED EXACTLY AS FAR AS THE RULE STATES AND NO FURTHER. The judge branch requires BOTH a
 * scoring role AND entitlement to that submission's workshop — the same predicate as the
 * write, so a judge can read precisely what they can score. It does not widen to any other
 * role, to unscoped rows, or to a scoring role alone (which would be the neighbouring P0-3
 * hole reopened on the read side: any JUDGE reading any workshop's deliberations).
 *
 * THE TEAM PREDICATE IS ASKED FIRST, and that ordering is what makes this change inert for
 * everybody who already had access. A participant, executive, facilitator or admin who
 * passes `canRead` is answered exactly as before — same predicate, same single hop, no
 * entitlement call. The second hop exists only on the path that was previously a 403.
 *
 * COST, stated rather than hidden: a JUDGE's read is now TWO SEQUENTIAL east-west hops
 * (canRead, then entitlements), so the worst bounded case is 2 × EAST_WEST_TIMEOUT_MS =
 * 5000ms — inside the 15s function timeout and the 29s gateway timeout, but no longer
 * inside a 2.6s page budget. Accepted for a judging path a handful of people walk a handful
 * of times, and deliberately NOT optimised by short-circuiting the team hop for judges:
 * that would make the read predicate diverge from every other route in this service.
 */
export async function requireSubmissionRead(
  c: Context,
  teamAccess: TeamAccess,
  entitlements: WorkshopEntitlements,
  submission: { teamId: string; workshopId: string | null }
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);

  // Branch 1 — unchanged for every caller who already had access.
  if (await teamAccess.canRead(submission.teamId, id, role, c)) return null;

  // Branch 2 — the read widening. Role first, because it is local: a refused
  // PARTICIPANT gets today's 403 with no second hop.
  if (!isScoringRole(role)) return c.json({ error: "Forbidden" }, 403);

  return requireScoringScope(c, entitlements, submission.workshopId);
}
