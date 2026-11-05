import {
  EAST_WEST_TIMEOUT_MS,
  forwardedIdentityHeaders,
  requireIdentity,
} from "@praimana/service-shared";
import type { AuthContext } from "./authz.js";
import type {
  DocsCatalog,
  PhaseNotes,
  SnapshotArtifact,
  SnapshotPhase,
  TeamDirectory,
  TeamRoster,
  WorkshopDirectory,
} from "./domain.js";

/**
 * ── THE TWO EAST-WEST READS A RELEASE NEEDS ─────────────────────────────────────────────
 *
 * A snapshot pins the team's phase notes (Workshop context) and artifact pointers (Docs context).
 * Neither is this service's data, so neither is read from its table: each is asked of the owning
 * service through its own public API, exactly as `HttpTeamAccess` asks Team about access.
 *
 * ── ⚠ THREE PROPERTIES THESE SHARE WITH `HttpTeamAccess`, AND EACH IS LOAD-BEARING ──
 *
 *   1. THE CALLER'S OWN IDENTITY IS RE-PRESENTED (`forwardedIdentityHeaders`). Both callee routes sit
 *      behind the Cognito JWT authorizer, so a tokenless "trusted internal hop" is 401'd by the
 *      gateway before the callee's Lambda runs. It also means the callee authorizes as the EXECUTIVE
 *      releasing — and both routes are MEMBER-ONLY (`requireTeamContentRead` on phases,
 *      `requireTeamRead` on docs), which the executive satisfies because the release route's P2
 *      step (`requireSubmissionRelease` in routes.ts) already required
 *      membership. This service gains no ambient power it could not exercise as that user.
 *
 *   2. BOUNDED IN TIME (`EAST_WEST_TIMEOUT_MS`). A callee answering slowly but successfully would pin
 *      this Lambda for the full 29s gateway timeout per waiter and fill reserved concurrency.
 *
 *   3. ⚠ A FAILURE IS `"unavailable"`, NEVER AN EMPTY LIST. This is the difference from
 *      `HttpTeamAccess`, which reads a non-2xx as "denied" because denial is the safe direction for
 *      an ACCESS question. For CONTENT it is not: `[]` would make the "≥1 artifact" precondition
 *      refuse a team that has artifacts, and — far worse — could write an EMPTY SNAPSHOT that judges
 *      then read as the team's entire submission. An unanswered question is not an answer.
 */

/** Shared fetch-with-deadline, so neither client can forget the bound. */
async function getJson(
  url: string,
  auth: AuthContext
): Promise<Record<string, unknown> | "unavailable"> {
  try {
    const res = await fetch(url, {
      // `forwardedIdentityHeaders` prefers the caller's own bearer token and falls back to the
      // internal identity headers, so the identity is read from the context it is forwarding.
      headers: forwardedIdentityHeaders(auth, requireIdentity(auth)),
      signal: AbortSignal.timeout(EAST_WEST_TIMEOUT_MS),
    });
    /**
     * ⚠ EVERY NON-2xx IS "unavailable", INCLUDING 403 AND 404.
     *
     * Tempting to map 403 to "no access" and 404 to "nothing there" — and wrong here. This call is
     * made only AFTER the release guard established that the caller is an executive member, so a 403
     * from the callee means the two services DISAGREE about membership, which is a fault and not an
     * answer about the team's work. A release must not proceed on a disagreement it cannot explain.
     */
    if (!res.ok) {
      console.warn("[snapshot] east-west read refused", { url, status: res.status });
      return "unavailable";
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.warn("[snapshot] east-west read failed", {
      url,
      error: (err as { name?: string })?.name ?? String(err),
    });
    return "unavailable";
  }
}

/** The Docs service's `GET /teams/:teamId/docs`. */
export class HttpDocsCatalog implements DocsCatalog {
  constructor(
    private readonly baseUrl = process.env.DOCS_SERVICE_URL ||
      process.env.DOCS_BASE_URL ||
      "http://localhost:4000/v1"
  ) {}

  async listByTeam(
    teamId: string,
    auth?: AuthContext
  ): Promise<SnapshotArtifact[] | "unavailable"> {
    // No context ⇒ no caller token to re-present, so the gateway would 401 this. Reported as
    // unavailable rather than as "no artifacts", for the reason in the header.
    if (!auth) return "unavailable";

    const data = await getJson(
      `${this.baseUrl}/teams/${encodeURIComponent(teamId)}/docs`,
      auth
    );
    if (data === "unavailable") return "unavailable";

    const files = data.files;
    /**
     * ⚠ A MISSING `files` KEY IS "unavailable", NOT ZERO FILES. A shape this client does not
     * recognise means it is talking to something it does not understand — a deployed version skew, a
     * proxy error page with a 200. Treating that as "the team uploaded nothing" would release an
     * empty snapshot.
     */
    if (!Array.isArray(files)) {
      console.warn("[snapshot] docs answered without a files array", { teamId });
      return "unavailable";
    }

    return files.map((f) => {
      const file = f as Record<string, unknown>;
      return {
        path: String(file.path ?? ""),
        // `versionId` is nullable in `DocPointer` itself (a pre-versioning row), so null here is a
        // real value and not a parse failure. It is pinned into the manifest as-is; nothing serves
        // file BODIES any more (see the note where that route used to be in routes.ts).
        versionId: typeof file.versionId === "string" ? file.versionId : null,
        lastAuthorName:
          typeof file.lastAuthorName === "string"
            ? file.lastAuthorName
            : typeof file.lastAuthor === "string"
              ? file.lastAuthor
              : null,
        updatedAt: String(file.updatedAt ?? ""),
      };
    });
  }

}

/** The Workshop service's `GET /workshops/teams/:teamId/phases?workshopId=…`. */
export class HttpPhaseNotes implements PhaseNotes {
  constructor(
    private readonly baseUrl = process.env.WORKSHOP_SERVICE_URL ||
      "http://localhost:4000/v1"
  ) {}

  async listByTeam(
    teamId: string,
    workshopId: string,
    auth?: AuthContext
  ): Promise<SnapshotPhase[] | "unavailable"> {
    if (!auth) return "unavailable";

    /**
     * ⚠ `workshopId` IS REQUIRED BY THE CALLEE AND IS THE SERVER-DERIVED ONE. It comes from the
     * stored submission, not from the request — the callee gates it separately
     * (`requireWorkshopRead`), so passing a caller-supplied value would be handing them a second
     * scope-selection this platform deliberately denies them.
     */
    const data = await getJson(
      `${this.baseUrl}/workshops/teams/${encodeURIComponent(teamId)}/phases` +
        `?workshopId=${encodeURIComponent(workshopId)}`,
      auth
    );
    if (data === "unavailable") return "unavailable";

    const phases = data.phases;
    if (!Array.isArray(phases)) {
      console.warn("[snapshot] workshop answered without a phases array", { teamId });
      return "unavailable";
    }

    return phases.map((p) => {
      const phase = p as Record<string, unknown>;
      return {
        // The callee calls it `id`; the snapshot calls it `phaseId`, because inside a Snapshot an
        // unqualified `id` would read as the snapshot's own.
        phaseId: String(phase.id ?? ""),
        order: typeof phase.order === "number" ? phase.order : 0,
        name: String(phase.name ?? ""),
        content: String(phase.content ?? ""),
        aiGenerated: phase.aiGenerated === true,
        editedByName: typeof phase.editedByName === "string" ? phase.editedByName : null,
        editedAt: typeof phase.editedAt === "string" ? phase.editedAt : null,
      };
    });
  }
}

/**
 * The team's display name, read at RELEASE time through Team's `GET /workshops/:id/teams`.
 *
 * ⚠ IT WORKS ONLY BECAUSE THE CALLER IS A MEMBER. That route filters to the caller's own teams for
 * anyone who is not an ADMIN or the workshop owner — which is exactly why a JUDGE cannot use it, and
 * exactly why the name is captured here (by an executive member) and pinned into the snapshot.
 *
 * ⚠ EVERY FAILURE IS `null`, NOT `"unavailable"` — deliberately unlike the other clients in this file.
 * A name is display metadata, and blocking a deadline release because a name lookup was slow would be
 * a worse failure than showing a team id. The release route treats null as "no name" and proceeds.
 */
export class HttpTeamDirectory implements TeamDirectory {
  constructor(
    private readonly baseUrl = process.env.TEAM_SERVICE_URL || "http://localhost:4000/v1"
  ) {}

  async nameOf(teamId: string, workshopId: string, auth?: AuthContext): Promise<string | null> {
    if (!auth) return null;

    const data = await getJson(
      `${this.baseUrl}/workshops/${encodeURIComponent(workshopId)}/teams`,
      auth
    );
    if (data === "unavailable") return null;

    const teams = data.teams;
    if (!Array.isArray(teams)) return null;

    const found = teams.find((t) => (t as Record<string, unknown>).id === teamId) as
      | Record<string, unknown>
      | undefined;
    const name = found?.name;
    return typeof name === "string" && name !== "" ? name : null;
  }

  async teamsOf(
    workshopId: string,
    auth?: AuthContext
  ): Promise<Array<{ id: string; name: string | null; memberCount: number | null }> | "unavailable"> {
    if (!auth) return "unavailable";

    /**
     * `withMembers=1` folds each team's members and a `_count` into the response, so the member
     * count costs no extra request per team. The callee built that flag precisely to avoid the N+1.
     */
    const data = await getJson(
      `${this.baseUrl}/workshops/${encodeURIComponent(workshopId)}/teams?withMembers=1`,
      auth
    );
    if (data === "unavailable") return "unavailable";

    const teams = data.teams;
    // A shape this client does not recognise is NOT "zero teams" — see the port's note.
    if (!Array.isArray(teams)) {
      console.warn("[teams] answered without a teams array", { workshopId });
      return "unavailable";
    }

    return teams.map((t) => {
      const team = t as Record<string, unknown>;
      const count = (team._count as Record<string, unknown> | undefined)?.members;
      const members = team.members;
      return {
        id: String(team.id ?? ""),
        name: typeof team.name === "string" ? team.name : null,
        /**
         * ⚠ NULL WHEN THE CALLEE DID NOT SAY, never 0. A team with no members and a team whose count
         * was not returned are different facts, and "0 members" on screen would send a facilitator
         * looking for a problem that does not exist.
         */
        memberCount:
          typeof count === "number"
            ? count
            : Array.isArray(members)
              ? members.length
              : null,
      };
    });
  }
}

/**
 * WHO IS ON A TEAM — through Team's `GET /teams/:teamId/members`.
 *
 * ⚠ NO NEW TEAM ENDPOINT, AND THAT IS A DELIBERATE CONSTRAINT RATHER THAN LAZINESS. Every route this
 * platform exposes has to be wired in the API Gateway template, which does not live in this repo
 * (see identity's infra-guardrails test). A client added here against a route that exists is
 * deployable on its own; a new callee route is not verifiable from here and would ship broken.
 * `GET /teams/:teamId/members` is already routed, already authorized the way this needs, and is what
 * `HttpTeamAccess` and `HttpTeamDirectory` in this service already talk to.
 *
 * ⚠ IT ANSWERS ONLY FOR A CALLER WHO COULD HAVE ASKED IT THEMSELVES. `forwardedIdentityHeaders`
 * re-presents the CALLER's own token, and the callee gates on `requireTeamRead` — member of this
 * team, staff who owns its workshop, or ADMIN. The rating route's guard has already established
 * membership, so a 403 here means the two services disagree, which is a fault rather than an answer.
 *
 * ⚠ IDS ONLY, AND THE DISCARDING IS THE POINT. That response carries members' EMAIL ADDRESSES (opted
 * in by the callee for the team's own People list) and, for removed rows, the removing operator's
 * sub. This service needs none of it: it is answering "is this id on the team", so everything else is
 * dropped at this boundary and never reaches a route, a log or a row. The alternative — passing the
 * roster inward and letting a caller pick fields off it — is how PII spreads.
 */
export class HttpTeamRoster implements TeamRoster {
  constructor(
    private readonly baseUrl = process.env.TEAM_SERVICE_URL || "http://localhost:4000/v1"
  ) {}

  async isActiveMember(
    teamId: string,
    userId: string,
    auth?: AuthContext
  ): Promise<boolean | "unavailable"> {
    // No Context ⇒ we cannot ask at all. "unavailable", never `false`: `false` is a real answer
    // meaning "not on this team", and reporting a missing context that way would refuse every
    // legitimate rating as though the member had named a stranger.
    if (!auth) {
      console.warn("[roster] isActiveMember: no request context to forward");
      return "unavailable";
    }

    const data = await getJson(
      `${this.baseUrl}/teams/${encodeURIComponent(teamId)}/members`,
      auth
    );
    if (data === "unavailable") return "unavailable";

    const members = data.members;
    // A shape this client does not recognise is NOT "no such member" — see the port's note.
    if (!Array.isArray(members)) {
      console.warn("[roster] members answered without a members array", { teamId });
      return "unavailable";
    }

    /**
     * ⚠ THE MATCH IS MADE HERE AND NOTHING ELSE ESCAPES. Everything else on those rows — the email
     * addresses the callee opts into for the team's own People list, and the removing operator's sub
     * on inactive rows — dies with this function. Only the boolean crosses the port.
     *
     * ⚠ ACTIVE ONLY, TESTED AS `!== "INACTIVE"` RATHER THAN `=== "ACTIVE"`. The callee normalises the
     * field — its projection states `status` is "ALWAYS PRESENT AND NEVER ABSENT" — so a row without
     * one means a callee older than that normalisation, and an absent status has always MEANT active
     * on the stored row. Reading the unknown as active matches the callee's own interpretation
     * instead of silently refusing ratings against a service one deploy behind.
     */
    return members.some((entry) => {
      const member = entry as Record<string, unknown>;
      return member.userId === userId && member.status !== "INACTIVE";
    });
  }
}

/**
 * The experience — who OWNS it and what state it is in — through Workshop's `GET /workshops/:id`.
 *
 * Two callers need it and the entitlements probe serves neither: the judging list's "or owner" branch,
 * and publishing places, which must move the experience to COMPLETED.
 * `GET /entitlements/workshops` is built from INVITATIONS and MEMBERSHIPS, so a facilitator who owns
 * an experience with neither is entitled to nothing by it — the gap this closes.
 *
 * ⚠ `null` (does not exist) IS NOT `"unavailable"` (could not find out). One is a 404; the other must
 * never be reported as "you do not own this".
 */
export class HttpWorkshopDirectory implements WorkshopDirectory {
  constructor(
    private readonly baseUrl = process.env.WORKSHOP_SERVICE_URL || "http://localhost:4000/v1"
  ) {}

  async get(
    workshopId: string,
    auth?: AuthContext
  ): Promise<{ id: string; ownerId: string | null; status: string } | null | "unavailable"> {
    if (!auth) return "unavailable";

    const data = await getJson(`${this.baseUrl}/workshops/${encodeURIComponent(workshopId)}`, auth);
    if (data === "unavailable") return "unavailable";

    /**
     * ⚠ NESTED OR BARE, BOTH ACCEPTED. Reading only one shape would make this silently
     * `"unavailable"` against the other — which presents to a facilitator as "you do not own this
     * experience" when they do.
     */
    const workshop = (data.workshop ?? data) as Record<string, unknown>;
    if (typeof workshop.id !== "string") {
      console.warn("[workshop] answered without an id", { workshopId });
      return "unavailable";
    }

    return {
      id: workshop.id,
      ownerId: typeof workshop.ownerId === "string" ? workshop.ownerId : null,
      status: typeof workshop.status === "string" ? workshop.status : "",
    };
  }

  /**
   * `PATCH /workshops/:id/status` — the experience's own lifecycle route, called AS THE CALLER.
   *
   * ⚠ SO THIS SERVICE CANNOT MOVE AN EXPERIENCE THE CALLER COULD NOT MOVE THEMSELVES. That route is
   * already owner-or-ADMIN gated, and the caller's identity is what is presented — no ambient
   * authority is added by routing the write through here.
   *
   * ⚠ RETURNS A BOOLEAN RATHER THAN THROWING. The caller publishes the results row FIRST, so by the
   * time this runs the authoritative fact is already stored; a throw here would turn a succeeded
   * publication into a 500 and invite the owner to publish again.
   */
  async setStatus(workshopId: string, status: string, auth?: AuthContext): Promise<boolean> {
    if (!auth) return false;
    try {
      const res = await fetch(
        `${this.baseUrl}/workshops/${encodeURIComponent(workshopId)}/status`,
        {
          method: "PATCH",
          headers: {
            ...forwardedIdentityHeaders(auth, requireIdentity(auth)),
            "content-type": "application/json",
          },
          body: JSON.stringify({ status }),
          signal: AbortSignal.timeout(EAST_WEST_TIMEOUT_MS),
        }
      );
      if (!res.ok) {
        console.warn("[workshop] status transition refused", { workshopId, status, http: res.status });
        return false;
      }
      return true;
    } catch (err) {
      console.warn("[workshop] status transition failed", {
        workshopId,
        status,
        error: (err as { name?: string })?.name ?? String(err),
      });
      return false;
    }
  }
}
