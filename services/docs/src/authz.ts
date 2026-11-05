import type { Context } from "hono";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { requireIdentity, type DocClient } from "@praimana/service-shared";

/**
 * AUTHORIZATION for the Docs service (authN already happened at the gateway).
 *
 * DELIBERATE DIVERGENCE from the Source service's authz/team-access modules:
 * the Source service asks the Team service over HTTP (`/teams/:id/access`) whether
 * a user may read/write a team. The Docs Lambda CANNOT do that — it runs in a
 * private VPC subnet with NO NAT gateway, so it has no route to the internet-facing
 * API. Instead it resolves membership LOCALLY by reading the team-members table
 * (PK teamId, SK userId) directly, which it reaches over the DynamoDB *gateway* VPC
 * endpoint. Read access requires membership; write access additionally forbids the
 * read-only (EXECUTIVE) role. Executives can therefore view every doc but not push.
 *
 * This is a bounded-context read of one Team table justified by the VPC constraint;
 * DocsRole grants ONLY dynamodb:Query/GetItem on praimana-team-members.
 *
 * ── THIS SERVICE IS THE REFERENCE BEHAVIOUR, NOT AN OUTLIER, AND NEEDS NO CHANGE ──
 *
 * Docs are the fifth team-content surface, and this file has ALWAYS been member-only:
 * `isMember` is a single GetItem on (teamId, userId) with NO role branch at all — no ADMIN
 * short-circuit, no workshop-ownership fallback, nothing the other four services had. So an
 * ADMIN, FACILITATOR or JUDGE already got 403 on every docs route, and the member-only rule is the rest
 * of the platform being brought into line with what this service already did.
 *
 * VERIFIED by reading this file rather than assumed from the comment above it. The
 * consequence worth stating: nothing here is touched by that change, which is why docs
 * is a surface whose behaviour is UNCHANGED while the other four narrow. If a
 * role branch is ever added here, it would silently re-widen the one surface that never
 * leaked — authz.test.ts pins that.
 *
 * ── BUT IT IS AN OUTLIER FOR MEMBERSHIP *STATUS*, AND THAT DID NEED A CHANGE ──
 *
 * The reasoning above is about ROLES and still holds in full. A SECOND, independent question
 * arrived with reactivation: member removal is no longer a
 * hard delete. The row survives with `status: INACTIVE` so the removal can be reversed and so
 * the roster can show who was removed.
 *
 * Every OTHER reader of that table goes through the Team service's `TeamMemberRepository.get()`,
 * which returns NULL for a deactivated row — so they need no filter and got none. THIS SERVICE
 * READS THE TABLE ITSELF (see below), so it is the one place that must know about `status`, and
 * the one way a removed person could have kept access to a team surface. `isMember` now checks
 * it. See the note on DynamoTeamMembership.
 */

const READ_ONLY_ROLES = new Set(["EXECUTIVE"]);
const TABLE_TEAM_MEMBERS =
  process.env.TABLE_TEAM_MEMBERS || "praimana-team-members";

/**
 * A DEACTIVATED membership — the status a REMOVED member's row carries.
 *
 * A deliberate LOCAL COPY of MEMBERSHIP_INACTIVE in the team service's domain module, the
 * same idiom (and the same reason) as the invitation statuses copied into the Cognito
 * pre-signup trigger: bundled Lambdas take no dependency on a workspace package, and this
 * service cannot call the Team service at all — it runs in a private subnet with no NAT, which
 * is why it reads the table directly in the first place.
 *
 * ⚠ IF THE TWO COPIES EVER DISAGREE, THIS SURFACE SILENTLY GRANTS A REMOVED PERSON ACCESS —
 * it does not fail loudly. That is why the comparison below is case-INSENSITIVE and why it
 * tests for the DENY value rather than for equality with "ACTIVE". Change both together.
 */
const MEMBERSHIP_INACTIVE = "INACTIVE";

export function isReadOnlyRole(role: string): boolean {
  return READ_ONLY_ROLES.has(role);
}

/** True if the user has a membership row in the team. */
export interface TeamMembership {
  isMember(teamId: string, userId: string): Promise<boolean>;
}

/**
 * ── THE ONE PLACE ON THE PLATFORM WHERE A REMOVAL COULD LEAK ──
 *
 * Every other reader of `praimana-team-members` goes through
 * `TeamMemberRepository.get()` in the Team service, which returns NULL for a deactivated row
 * — so an inactive membership grants nothing at those call sites with no filter of their own.
 * THIS CLASS IS THE EXCEPTION: it issues its own GetCommand against the table, bypassing that
 * repository entirely, because the Docs Lambda has no route to the Team API (private subnet,
 * no NAT — see the header). It is therefore the only reader that has to know about `status`
 * itself, and the only way a removed person could keep access to a team surface.
 *
 * Member removal used to be a HARD DELETE, and `return !!res.Item` was correct for exactly
 * that reason: no row meant no access, with nothing to filter. The removal now KEEPS the row
 * so that it can be reversed, which makes the bare truthiness check WRONG here — it would
 * read a deactivated row as a live membership and hand a removed person every docs route.
 *
 * `authz.test.ts` pins this. Deleting the status check makes a NAMED test fail rather than
 * leaving the regression to be found in production.
 */
export class DynamoTeamMembership implements TeamMembership {
  constructor(private readonly db: DocClient) {}

  async isMember(teamId: string, userId: string): Promise<boolean> {
    const res = await this.db.send(
      new GetCommand({
        TableName: TABLE_TEAM_MEMBERS,
        Key: { teamId, userId },
      })
    );
    const row = res.Item as { status?: unknown } | undefined;
    if (!row) return false;
    // A DEACTIVATED ROW IS NOT A MEMBERSHIP. Tests for the DENY value, and tolerates a
    // non-string: ABSENT status means ACTIVE, because every row written before the field
    // existed carries no attribute and treating those as inactive would 403 every team on the
    // platform from every docs route. Same forced polarity as the Team service's
    // isInactiveMembership — a lockout is worse than a leak that does not exist yet.
    const status =
      typeof row.status === "string" ? row.status.trim().toUpperCase() : "";
    return status !== MEMBERSHIP_INACTIVE;
  }
}

/** Guard: caller must be a member of the team. Returns a Response to short-circuit
 *  with, or null to proceed. */
export async function requireTeamRead(
  c: Context,
  membership: TeamMembership,
  teamId: string
): Promise<Response | null> {
  const { id } = requireIdentity(c);
  const ok = await membership.isMember(teamId, id);
  return ok ? null : c.json({ error: "Forbidden" }, 403);
}

/** Guard: caller must be a member AND not a read-only role. */
export async function requireTeamWrite(
  c: Context,
  membership: TeamMembership,
  teamId: string
): Promise<Response | null> {
  const { id, role } = requireIdentity(c);
  if (isReadOnlyRole(role)) return c.json({ error: "Read-only role" }, 403);
  const ok = await membership.isMember(teamId, id);
  return ok ? null : c.json({ error: "Forbidden" }, 403);
}


/**
 * ⚠ THERE IS NO INTERNAL-CALLER GUARD, AND THE FILE'S HEADER IS TRUE AGAIN. `requireInternalCaller`
 * lived here briefly so `evaluation` could serve a judge a released file. It compared
 * `INTERNAL_SERVICE_TOKEN`, which is set on NO function deliberately — so it refused everything, and
 * the feature it enabled was dropped rather than rebuilt on a new service-to-service dependency.
 *
 * Every route in this service is member-only again: `isMember` is a GetItem with no role branch, no
 * ADMIN short-circuit, no workshop-ownership fallback. `authz.test.ts` pins that.
 */
