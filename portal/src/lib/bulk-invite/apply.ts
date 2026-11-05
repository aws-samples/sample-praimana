// ── APPLYING A VALIDATED PLAN, ⚠ NO LONGER ON THE LIVE PATH ─────────────────────────────
//
// ⚠ NOTHING CALLS THIS ANY MORE. The BFF now ENQUEUES (see ./dispatch.ts) and the work runs in the
// bulk-provision worker, per the requirement that nobody waits for it.
//
// It is RETAINED ON PURPOSE rather than deleted: it works, it has 17 tests, and the worker has never
// run against real AWS. Deleting the proven path in the same change that stops using it would leave no
// way back if the worker turns out to be wrong. It comes out once the worker is verified live, and
// when it does, `the bulk-provision service's `apply.ts`` is the copy that survives.
//
// ⚠ ONE BUG WORTH FIXING BEFORE ANY REVIVAL: this version reads a team's existing invitations INSIDE
// the per-role-group call, so a team mixing an EXECUTIVE with PARTICIPANTs reads it twice and the
// second read cannot see the first group's writes. The worker's copy reads it ONCE per team and shares
// the set. Harmless here only by timing, not by design.
//
// ── ORIGINAL NOTES ──────────────────────────────────────────────────────────────────────
//
// Resolve or create each team, write its invitation rows, provision the Cognito accounts, and email
// each invitee their link. One team at a time, so a failure is reported against a NAMED team.
//
// ⚠ WHY THIS RUNS IN THE REQUEST RATHER THAN IN AN EventBridge WORKER (a change of plan, recorded).
//
// Building a worker was the original plan, so the upload could be acknowledged instantly and the
// outcome emailed. It turned out to need more than a Lambda: the portal has NO AWS SDK (services own AWS, the
// BFF orchestrates over HTTP), so it cannot publish an event; and the three-step invite sequence
// spans THREE bounded contexts, invitation rows are Team's write, the account is user-access's, the
// email is notify's, so no single service can own it either. A BFF is the legitimate
// cross-context orchestrator; it simply cannot run after responding.
//
// At the expected scale that trade is small: 18 invitations is ~20s of paced sending, not the
// 80+ the async design was priced for. So the work runs synchronously and the response carries the
// real per-row outcome, which is strictly MORE informative than a 202 plus an email.
//
// ⚠ THE SEAM IS PRESERVED, WHICH IS THE POINT. `dispatchBulkProvision` still owns the hand-off, so
// making it asynchronous later means changing ONE function and not this orchestration. Nothing here
// assumes it is inside a request.
//
// ⚠ AND ATOMICITY IS STILL NOT CLAIMED. There is no transaction: if team 2 of 3 fails,
// teams 1 and 3 exist. Re-uploading the same file is the recovery path, which is why matching an
// existing team by name ADDS to it and why an address already invited is SKIPPED rather than
// re-invited, a re-invite would re-mint the token and invalidate a link already sent.

import { backendFetch, BackendError } from "@/lib/backend";
import { provisionAccounts } from "@/lib/provision";
import { runPaced } from "@/lib/send-pacer";
import { normalizeTeamName } from "./contract";
import { APP_URL, buildInviteUrl, isLocalAppUrl } from "./invite-url";
import type { BulkPlan, BulkPlannedMember } from "./validate";

/** What happened to one address. `skipped` is a success: they already had a live invitation. */
export type MemberOutcome =
  | { email: string; status: "invited" }
  | { email: string; status: "skipped"; reason: string }
  | { email: string; status: "failed"; reason: string };

export interface TeamOutcome {
  teamName: string;
  /** "created" a new team, or "matched" an existing one by normalised name. */
  disposition: "created" | "matched" | "failed";
  teamId?: string;
  members: MemberOutcome[];
  error?: string;
}

export interface ApplyReport {
  teamsCreated: number;
  teamsMatched: number;
  invited: number;
  skipped: number;
  failed: number;
  teams: TeamOutcome[];
}

interface ExistingTeam {
  id: string;
  name: string;
  inviteCode?: string;
}

function reason(err: unknown): string {
  if (err instanceof BackendError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve a planned team name to an existing team, or create it.
 *
 * ⚠ AMBIGUITY IS A REFUSAL, NOT A GUESS. Nothing enforces team-name uniqueness in a
 * workshop, so two teams can normalise to the same name. Picking one would put people on the wrong
 * team with no way to tell, so this fails the team instead.
 */
async function resolveTeam(
  workshopId: string,
  rawName: string,
  existing: ExistingTeam[],
  token: string
): Promise<{ team: ExistingTeam; disposition: "created" | "matched" }> {
  const key = normalizeTeamName(rawName);
  const matches = existing.filter((t) => normalizeTeamName(t.name) === key);

  if (matches.length > 1) {
    throw new Error(
      `More than one existing team is called "${rawName}" (${matches
        .map((m) => m.id)
        .join(", ")}). Rename one and upload again.`
    );
  }
  if (matches.length === 1) return { team: matches[0], disposition: "matched" };

  const created = await backendFetch(`/v1/workshops/${encodeURIComponent(workshopId)}/teams`, {
    method: "POST",
    body: JSON.stringify({ name: rawName }),
    token,
  });
  const team = created?.team;
  if (!team?.id) throw new Error("The team was created but the service returned no id.");

  // Added to the local list so a LATER row naming the same team matches it rather than creating a
  // second one, the file is grouped by team, but this keeps that from being load-bearing.
  existing.push({ id: team.id, name: team.name, inviteCode: team.inviteCode });
  return { team, disposition: "created" };
}

/** Addresses on this team that already hold a live invitation, lowercased. */
async function alreadyInvited(teamId: string, token: string): Promise<Set<string>> {
  try {
    const data = await backendFetch(
      `/v1/teams/${encodeURIComponent(teamId)}/invitations`,
      { token }
    );
    const rows: Array<{ email?: string; status?: string }> = data?.invitations ?? [];
    return new Set(
      rows
        .filter((r) => !!r.email && r.status !== "REVOKED")
        .map((r) => r.email!.toLowerCase())
    );
  } catch {
    /**
     * ⚠ FAIL OPEN HERE, DELIBERATELY, AND IT IS THE LESSER EVIL. If this read fails we cannot tell
     * who was already invited. Skipping everybody would silently invite nobody and report success;
     * inviting everybody risks a duplicate email to someone who already has one. A duplicate invite
     * is recoverable and visible; silently inviting nobody is neither.
     */
    return new Set();
  }
}

/** Invite one team's members: rows → accounts → emails, in that forced order. */
async function inviteMembers(
  team: ExistingTeam,
  members: BulkPlannedMember[],
  workshopId: string,
  token: string,
  inviterName: string | undefined
): Promise<MemberOutcome[]> {
  const outcomes: MemberOutcome[] = [];
  const seen = await alreadyInvited(team.id, token);

  const fresh = members.filter((m) => {
    if (seen.has(m.email)) {
      outcomes.push({
        email: m.email,
        status: "skipped",
        reason: "already has a pending invitation to this team",
      });
      return false;
    }
    return true;
  });
  if (fresh.length === 0) return outcomes;

  // ── STEP 1: the invitation ROWS. The response carries each raw token, the only time it is
  // readable, so the links must be built from it and nowhere else.
  let created: Array<{ email?: string; token?: string }> = [];
  try {
    const stored = await backendFetch(
      `/v1/teams/${encodeURIComponent(team.id)}/invitations`,
      {
        method: "POST",
        body: JSON.stringify({
          emails: fresh.map((m) => m.email),
          // One platform role per request, so rows are grouped by it below.
          platformRole: fresh[0].platformRole,  // nosemgrep: no-stringify-keys
          teamRole: fresh[0].teamRole,  // nosemgrep: no-stringify-keys
        }),
        token,
      }
    );
    created = stored?.invitations ?? [];
  } catch (err) {
    // The rows are the source of truth for everything downstream, so if they fail nothing else runs.
    return [
      ...outcomes,
      ...fresh.map((m) => ({ email: m.email, status: "failed" as const, reason: reason(err) })),
    ];
  }

  const tokenByEmail = new Map(
    created
      .filter((i): i is { email: string; token: string } => !!i.email && !!i.token)
      .map((i) => [i.email.toLowerCase(), i.token])
  );

  // ── STEP 2: the Cognito accounts, at the existing bounded concurrency (4). Only addresses with a
  // token are provisioned: an account whose link never arrived is a credential nobody can use.
  const sendable = fresh.filter((m) => tokenByEmail.has(m.email));
  for (const m of fresh) {
    if (!tokenByEmail.has(m.email)) {
      outcomes.push({
        email: m.email,
        status: "failed",
        reason: "the invitation was stored but no link token came back",
      });
    }
  }

  const provisioned = await provisionAccounts(sendable.map((m) => m.email), token);
  const accountByEmail = new Map(
    provisioned
      .filter((p) => p.ok)
      .map((p) => [p.email.toLowerCase(), (p as { result: { temporaryPassword?: string; alreadyExisted?: boolean } }).result])
  );
  for (const p of provisioned) {
    if (!p.ok) {
      outcomes.push({
        email: p.email,
        status: "failed",
        reason: `the account could not be created (${p.failure.reason ?? "unknown"})`,
      });
    }
  }

  // ── STEP 3: the emails, PACED. `runPaced` keeps ~1/sec against SES's sandbox rate; firing these
  // in parallel is what silently lost invitations before (see lib/send-pacer.ts).
  const emailable = sendable.filter((m) => accountByEmail.has(m.email));
  const results = await runPaced(emailable, (m) =>
    backendFetch("/v1/notify/team-invite", {
      method: "POST",
      body: JSON.stringify({
        to: m.email,
        actionUrl: buildInviteUrl(tokenByEmail.get(m.email)!),
        teamName: team.name,
        roleLabel: m.teamRole ? `${m.platformRole} (${m.teamRole})` : m.platformRole,
        inviterName,
        // ⚠ OMITTED WHEN THE ACCOUNT ALREADY EXISTED, the same rule /api/invite documents: the
        // generated password was never applied, so sending it hands someone a credential that
        // silently does not work.
        ...(accountByEmail.get(m.email)?.alreadyExisted
          ? {}
          : { temporaryPassword: accountByEmail.get(m.email)?.temporaryPassword }),
      }),
      token,
    })
  );

  results.forEach((r, i) => {
    const email = emailable[i].email;
    if (r.status === "fulfilled") {
      outcomes.push({ email, status: "invited" });
    } else {
      // ⚠ The row and the account EXIST; only the email failed, and the temporary password went
      // with it. The operator must RE-INVITE rather than resend, which the reason has to say.
      outcomes.push({
        email,
        status: "failed",
        reason: "the account was created but the email did not send, re-invite this address",
      });
    }
  });

  return outcomes;
}

/** Apply a validated plan. Never throws: every failure is reported in the returned shape. */
export async function applyBulkPlan(
  workshopId: string,
  plan: BulkPlan,
  token: string,
  inviterName?: string
): Promise<ApplyReport> {
  /**
   * ⚠ REFUSE TO BULK-SEND FROM A DEV MACHINE, BEFORE ANYTHING IS CREATED.
   *
   * The invitations would be real, the addresses real, and every link would point at localhost, so
   * every recipient gets an unopenable link, and because each token is SINGLE-USE the only recovery is
   * revoking and re-inviting all of them. A warning in a log is not enough for an action whose damage
   * lands in other people's inboxes.
   *
   * Deliberately NOT gated on NODE_ENV: what matters is where the LINK points, which is a different
   * question from how the app was built. A production build pointed at localhost is just as broken.
   */
  if (isLocalAppUrl()) {
    throw new Error(
      `Invite links would point at ${APP_URL}, which only works on this machine, so nothing was ` +
        `created. Set NEXT_PUBLIC_APP_URL to the real portal URL, or run this from the deployed ` +
        `portal instead.`
    );
  }

  const teams: TeamOutcome[] = [];

  // Read the workshop's teams ONCE, so name resolution costs one hop rather than one per team.
  let existing: ExistingTeam[] = [];
  try {
    const data = await backendFetch(`/v1/workshops/${encodeURIComponent(workshopId)}/teams`, {
      token,
    });
    existing = (data?.teams ?? []).map((t: ExistingTeam) => ({
      id: t.id,
      name: t.name,
      inviteCode: t.inviteCode,
    }));
  } catch (err) {
    // Without this list every name would look new and duplicate every existing team. Refuse.
    throw new Error(`Could not read this experience's teams, so nothing was created: ${reason(err)}`);
  }

  for (const planned of plan.teams) {
    const members = plan.members.filter((m) => m.teamKey === planned.teamKey);

    let resolved;
    try {
      resolved = await resolveTeam(workshopId, planned.teamName, existing, token);
    } catch (err) {
      teams.push({
        teamName: planned.teamName,
        disposition: "failed",
        members: [],
        error: reason(err),
      });
      continue;
    }

    /**
     * Members are grouped by (platformRole, teamRole) because the invitations endpoint takes ONE
     * role per request. Grouping rather than one call per member keeps the hop count down while
     * still letting a team mix an EXECUTIVE with participants.
     */
    const byRole = new Map<string, BulkPlannedMember[]>();
    for (const m of members) {
      const k = `${m.platformRole}|${m.teamRole ?? ""}`;
      byRole.set(k, [...(byRole.get(k) ?? []), m]);
    }

    const memberOutcomes: MemberOutcome[] = [];
    for (const group of byRole.values()) {
      memberOutcomes.push(
        ...(await inviteMembers(resolved.team, group, workshopId, token, inviterName))
      );
    }

    teams.push({
      teamName: resolved.team.name,
      disposition: resolved.disposition,
      teamId: resolved.team.id,
      members: memberOutcomes,
    });
  }

  const all = teams.flatMap((t) => t.members);
  return {
    teamsCreated: teams.filter((t) => t.disposition === "created").length,
    teamsMatched: teams.filter((t) => t.disposition === "matched").length,
    invited: all.filter((m) => m.status === "invited").length,
    skipped: all.filter((m) => m.status === "skipped").length,
    failed: all.filter((m) => m.status === "failed").length + teams.filter((t) => t.disposition === "failed").length,
    teams,
  };
}
