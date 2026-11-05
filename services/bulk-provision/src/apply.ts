// ── APPLYING A VALIDATED PLAN, FROM THE WORKER ───────────────────────────────────────────
//
// Resolve or create each team, write its invitation rows, provision the Cognito accounts, and email
// each invitee. One team at a time, so a failure is reported against a NAMED team.
//
// ⚠ THIS IS A TRANSPORT PORT, NOT A REWRITE. The behavioural rules were written and tested in the
// portal (its bulk-invite apply module, 17 tests) and are reproduced here EXACTLY:
//
//   - a matching team name ADDS members; a new one CREATES the team
//   - an address that already holds a live invitation is SKIPPED, never re-invited
//   - the temporary password is OMITTED when the account already existed
//   - two existing teams sharing a name FAIL that team rather than guessing
//   - rows → account → email, in that forced order
//   - a failed email after a created account says RE-INVITE, because the password went with it
//
// Only the transport differs: `backendFetch(path, {token})` becomes
// `callService(fn, method, path, identity)`, because a worker has no bearer to present.
//
// ⚠ WHY THE LOGIC IS DUPLICATED RATHER THAN SHARED. The portal cannot import from a service package
// and vice versa — they bundle separately, and the portal's version calls `backendFetch`, which does
// not exist here. Extracting a transport-agnostic core into `@praimana/service-shared` is the
// right eventual answer; doing it now would mean editing the live single-invite path in the same
// change as introducing the worker, which is a worse risk than two copies with a test each.

import {
  callService,
  ServiceInvokeError,
  type CallerIdentity,
} from "./invoke";

const TEAM_FN = process.env.TEAM_FUNCTION_NAME || "praimana-team";
const USER_ACCESS_FN = process.env.USER_ACCESS_FUNCTION_NAME || "praimana-user-access";
const NOTIFY_FN = process.env.NOTIFY_FUNCTION_NAME || "praimana-notify";

/**
 * ⚠ MATCHES `PROVISION_CONCURRENCY` IN THE PORTAL, AND FOR THE SAME REASON. Cognito's admin APIs are
 * rate-limited PER POOL and that throttle is shared with real users signing in. This is a load
 * decision against someone else's latency, not a tuning knob.
 */
const PROVISION_CONCURRENCY = 4;

/**
 * Minimum gap between two sends. SES allows 1/sec in this account's sandbox; 1100ms leaves margin so a
 * boundary-timed request is not a coin flip. Overridable because production access raises the ceiling.
 */
const SEND_GAP_MS = Number(process.env.SES_SEND_GAP_MS || 1100);

/**
 * ── ⚠ THE STALE-INDEX RETRY, AND IT IS NOT DEFENSIVE PROGRAMMING ─────────────────────────
 *
 * `POST /v1/user-access/provision` resolves the invitee's role from their invitation, and it must —
 * taking a role from the request would be the tamper-proof-role hole. It finds that invitation with
 * `listByEmail`, which queries the `email-index` **GSI**. A GSI is EVENTUALLY CONSISTENT, and DynamoDB
 * does not support `ConsistentRead` on one at all.
 *
 * This code writes the invitation row and then calls provision MILLISECONDS later. When the index has
 * not caught up, user-access correctly sees no live invitation and answers 409 — and the address is
 * reported as "the account could not be created" despite the row existing and being perfectly valid.
 *
 * ⚠ THIS HAPPENED. The 18th of 18 addresses in a real upload lost that race: row written at
 * 22:13:03.670, batch finished at 22:13:03.720. The other 17 won it. The person ended up with a live
 * invitation, no account, and no email — and because the link token is stored only as a hash and is
 * returned exactly once, nobody could recover their link. Repairing it took a revoke, a re-invite, a
 * provision, an email and an accept, by hand.
 *
 * ⚠ RETRYING IS SAFE *AND* JUSTIFIED HERE SPECIFICALLY. Safe: provision is idempotent — a second call
 * after a partial success returns `alreadyExisted`. Justified: this path only calls provision for
 * addresses whose invitation row it JUST created and got a token back for, so "no live invitation"
 * cannot be the truth. Anywhere else that 409 would be a real answer and must not be retried.
 *
 * Narrow on purpose: only a 409 that NAMES the missing invitation. A different 409, a 5xx, or a
 * throttle is left alone — those have side effects or need a human, and blanket retries on an account
 * -creating call are how you mint duplicates.
 */
const STALE_INDEX_BACKOFF_MS = [250, 750];

function isStaleInvitationIndex(err: unknown): boolean {
  return (
    err instanceof ServiceInvokeError &&
    err.status === 409 &&
    /no live invitation/i.test(err.message)
  );
}

export type MemberOutcome =
  | { email: string; status: "invited" }
  | { email: string; status: "skipped"; reason: string }
  | { email: string; status: "failed"; reason: string };

export interface TeamOutcome {
  teamName: string;
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

export interface PlanMember {
  line: number;
  teamName: string;
  teamKey: string;
  email: string;
  platformRole: string;
  teamRole?: string;
}

export interface Plan {
  teams: Array<{ teamKey: string; teamName: string; memberCount: number }>;
  members: PlanMember[];
}

interface ExistingTeam {
  id: string;
  name: string;
}

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u2060]/g;

/**
 * ⚠ MUST STAY IDENTICAL TO THE PORTAL'S `normalizeTeamName`. The portal decides which names are
 * "the same" when it validates; if the worker disagreed, a plan that grouped two rows into one team
 * would resolve them to two — silently splitting a team in half.
 */
export function normalizeTeamName(raw: string): string {
  return raw.normalize("NFKC").replace(ZERO_WIDTH, "").trim().replace(/\s+/g, " ").toLowerCase();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function reason(err: unknown): string {
  if (err instanceof ServiceInvokeError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Resolve a planned team name to an existing team, or create it. */
async function resolveTeam(
  workshopId: string,
  rawName: string,
  existing: ExistingTeam[],
  identity: CallerIdentity
): Promise<{ team: ExistingTeam; disposition: "created" | "matched" }> {
  const key = normalizeTeamName(rawName);
  const matches = existing.filter((t) => normalizeTeamName(t.name) === key);

  /**
   * ⚠ AMBIGUITY IS A REFUSAL, NOT A GUESS. Nothing enforces team-name uniqueness in a workshop, so two
   * teams can normalise equal — and picking one would put people on the WRONG team with no way for
   * anyone to tell.
   */
  if (matches.length > 1) {
    throw new Error(
      `More than one existing team is called "${rawName}" (${matches.map((m) => m.id).join(", ")}). ` +
        `Rename one and upload again.`
    );
  }
  if (matches.length === 1) return { team: matches[0], disposition: "matched" };

  const created = await callService<{ team?: { id: string; name: string } }>(
    TEAM_FN,
    "POST",
    `/v1/workshops/${encodeURIComponent(workshopId)}/teams`,
    identity,
    { name: rawName }
  );
  const team = created.body?.team;
  if (!team?.id) throw new Error("The team was created but the service returned no id.");

  // Added locally so a LATER row naming the same team matches it rather than creating a second one.
  existing.push({ id: team.id, name: team.name });
  return { team, disposition: "created" };
}

/** Addresses on this team that already hold a live invitation, lowercased. */
async function alreadyInvited(teamId: string, identity: CallerIdentity): Promise<Set<string>> {
  try {
    const res = await callService<{ invitations?: Array<{ email?: string; status?: string }> }>(
      TEAM_FN,
      "GET",
      `/v1/teams/${encodeURIComponent(teamId)}/invitations`,
      identity
    );
    return new Set(
      (res.body?.invitations ?? [])
        .filter((r) => !!r.email && r.status !== "REVOKED")
        .map((r) => r.email!.toLowerCase())
    );
  } catch {
    /**
     * ⚠ FAILS OPEN, AND IT IS THE LESSER EVIL. If this read fails we cannot tell who was already
     * invited. Skipping everybody would invite NOBODY and report success — silent and unrecoverable.
     * A duplicate invite is visible and fixable.
     */
    return new Set();
  }
}

/** Provision accounts at bounded concurrency. Never throws; each address gets its own outcome. */
async function provisionAll(
  emails: string[],
  identity: CallerIdentity
): Promise<Map<string, { temporaryPassword?: string; alreadyExisted?: boolean } | { error: string }>> {
  const out = new Map<string, { temporaryPassword?: string; alreadyExisted?: boolean } | { error: string }>();
  let next = 0;

  async function worker() {
    while (next < emails.length) {
      const email = emails[next++];

      // attempt 0, then one retry per backoff entry — see STALE_INDEX_BACKOFF_MS.
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await callService<{ temporaryPassword?: string; alreadyExisted?: boolean }>(
            USER_ACCESS_FN,
            "POST",
            "/v1/user-access/provision",
            identity,
            { email }
          );
          out.set(email, res.body ?? {});
          break;
        } catch (err) {
          const canRetry = isStaleInvitationIndex(err) && attempt < STALE_INDEX_BACKOFF_MS.length;
          if (!canRetry) {
            out.set(email, { error: reason(err) });
            break;
          }
          /**
           * Logged at WARN on every retry, because a rising count here is the only signal that index
           * lag is getting worse — and if it ever exceeds this budget the symptom is the silent,
           * expensive failure described above rather than anything obviously wrong.
           */
          console.warn("[bulk-provision] the invitation index was stale — retrying provision", {
            emailDomain: email.slice(email.indexOf("@")),
            attempt: attempt + 1,
            waitMs: STALE_INDEX_BACKOFF_MS[attempt],
          });
          await sleep(STALE_INDEX_BACKOFF_MS[attempt]);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(PROVISION_CONCURRENCY, emails.length) }, worker));
  return out;
}

/**
 * ── ⚠ WITHDRAW AN INVITATION THIS RUN CREATED BUT COULD NOT COMPLETE ─────────────────────
 *
 * A compensating action, and the thing whose absence made one failed address unrepairable.
 *
 * The order is rows → account → email. If provisioning fails, the row exists, no email was sent (that
 * happens after), and the raw link token is already gone — it is returned exactly once and stored only
 * as a hash. So the row is an ORPHAN: it grants nothing, nobody can act on it, and it cannot be
 * completed.
 *
 * ⚠ AND LEAVING IT IS ACTIVELY HARMFUL, NOT MERELY UNTIDY. A live invitation makes the address
 * "already invited", so the skip rule removes it from every future upload — the one
 * mechanism that was supposed to repair it. It also holds a SEAT: the team was at 5 members + 1 orphan
 * against a cap of 6, so even a manual re-invite was refused as full until the row was withdrawn.
 * Repairing it by hand took five calls.
 *
 * Withdrawing turns that into a no-op: the seat is released, the address stops looking invited, and
 * re-uploading the same file genuinely retries it — which is what the report email promises.
 *
 * ⚠ ONLY EVER FOR ROWS CREATED IN THIS RUN. The caller passes addresses drawn from `fresh`, never from
 * `seen`, so this can never withdraw a PRE-EXISTING invitation — which might be somebody's live link.
 *
 * Best-effort: a failure here is reported in the address's reason rather than thrown, because the
 * provisioning failure is already the outcome and losing it would be worse than an orphan.
 */
async function withdrawInvitation(
  teamId: string,
  email: string,
  identity: CallerIdentity
): Promise<boolean> {
  try {
    await callService(
      TEAM_FN,
      "DELETE",
      `/v1/teams/${encodeURIComponent(teamId)}/invitations/${encodeURIComponent(email)}`,
      identity
    );
    return true;
  } catch (err) {
    console.error("[bulk-provision] could not withdraw an orphaned invitation", {
      teamId,
      emailDomain: email.slice(email.indexOf("@")),
      reason: reason(err),
    });
    return false;
  }
}

/** Invite one role-group's members on one team: rows → accounts → emails, in that forced order. */
async function inviteGroup(
  team: ExistingTeam,
  members: PlanMember[],
  identity: CallerIdentity,
  appUrl: string,
  inviterName: string | undefined,
  seen: Set<string>
): Promise<MemberOutcome[]> {
  const outcomes: MemberOutcome[] = [];

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
  // readable, so links must be built from it and nowhere else.
  let created: Array<{ email?: string; token?: string }>;
  try {
    const res = await callService<{ invitations?: Array<{ email?: string; token?: string }> }>(
      TEAM_FN,
      "POST",
      `/v1/teams/${encodeURIComponent(team.id)}/invitations`,
      identity,
      {
        emails: fresh.map((m) => m.email),
        platformRole: fresh[0].platformRole,
        teamRole: fresh[0].teamRole,
      }
    );
    created = res.body?.invitations ?? [];
  } catch (err) {
    // The rows are the source of truth for everything downstream, so nothing else runs.
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

  // ⚠ NO ACCOUNT WITHOUT A LINK. An account whose token never came back is a credential nobody can
  // act on, so it is failed rather than provisioned.
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

  // ── STEP 2: the Cognito accounts, at bounded concurrency.
  const provisioned = await provisionAll(sendable.map((m) => m.email), identity);
  const emailable: PlanMember[] = [];
  for (const m of sendable) {
    const r = provisioned.get(m.email);
    if (!r || "error" in r) {
      const cause = r && "error" in r ? r.error : "unknown";

      /**
       * ⚠ WITHDRAW THE ROW WE JUST WROTE. Without this the address is left holding a live invitation
       * nobody can use, which the skip rule then hides from every future upload — see
       * `withdrawInvitation`. The reason text says which happened, because it changes what the
       * operator has to do: a withdrawn row is fixed by re-uploading, an orphan needs a human.
       */
      const withdrawn = await withdrawInvitation(team.id, m.email, identity);

      outcomes.push({
        email: m.email,
        status: "failed",
        reason: withdrawn
          ? `the account could not be created (${cause}) — the invitation was withdrawn, so uploading the same file again will retry this address`
          : `the account could not be created (${cause}), and the invitation could NOT be withdrawn — re-invite this address`,
      });
    } else {
      emailable.push(m);
    }
  }

  // ── STEP 3: the emails, PACED one at a time.
  for (let i = 0; i < emailable.length; i++) {
    const m = emailable[i];
    const account = provisioned.get(m.email) as { temporaryPassword?: string; alreadyExisted?: boolean };
    const startedAt = Date.now();

    try {
      await callService(NOTIFY_FN, "POST", "/v1/notify/team-invite", identity, {
        to: m.email,
        actionUrl: `${appUrl}/join/${encodeURIComponent(tokenByEmail.get(m.email)!)}`,
        teamName: team.name,
        roleLabel: m.teamRole ? `${m.platformRole} (${m.teamRole})` : m.platformRole,
        inviterName,
        /**
         * ⚠ OMITTED WHEN THE ACCOUNT ALREADY EXISTED. The generated password was never applied to it,
         * so sending it hands someone a credential that silently does not work — and invites them to
         * abandon a working one.
         */
        ...(account.alreadyExisted ? {} : { temporaryPassword: account.temporaryPassword }),
      });
      outcomes.push({ email: m.email, status: "invited" });
    } catch {
      /**
       * ⚠ THE MOST EXPENSIVE PARTIAL FAILURE. The row and the account EXIST, but the temporary
       * password went out with an email that never sent and is stored NOWHERE. "Resend" cannot work;
       * only re-inviting mints a fresh one, so the reason has to say so.
       */
      outcomes.push({
        email: m.email,
        status: "failed",
        reason: "the account was created but the email did not send — re-invite this address",
      });
    }

    // Start-to-start pacing, and no trailing wait after the last send.
    if (i < emailable.length - 1) {
      const elapsed = Date.now() - startedAt;
      if (elapsed < SEND_GAP_MS) await sleep(SEND_GAP_MS - elapsed);
    }
  }

  return outcomes;
}

/** Apply a validated plan. Throws ONLY when the run could not start; everything else is reported. */
export async function applyPlan(
  workshopId: string,
  plan: Plan,
  identity: CallerIdentity,
  appUrl: string,
  inviterName?: string
): Promise<ApplyReport> {
  /**
   * ⚠ REFUSE BEFORE CREATING ANYTHING. Every invite link would be unopenable, the invitations are
   * REAL, and each token is SINGLE-USE — so recovery means revoking and re-inviting everybody.
   *
   * ⚠ THE `api.` CHECK IS NOT PARANOIA, IT IS A BUG THAT ALREADY HAPPENED. The first deployment set
   * APP_URL from the template's `DomainName`, which is the API's domain — so every link would have
   * pointed at api.<host>/join/<token>, where /join does not exist. Caught by reading the deployed
   * environment, not by any test, because no fake can tell one hostname from another.
   *
   * It IS a heuristic: a customer whose portal genuinely lives at api.* would be refused. That is the
   * safe direction — a refusal is a config error someone fixes in a minute, and the alternative is
   * eighteen dead links and eighteen burned tokens.
   */
  const bad =
    !appUrl ||
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(appUrl) ||
    /^https?:\/\/api\./i.test(appUrl);
  if (bad) {
    throw new Error(
      `APP_URL is unset, local, or points at an api.* host (${appUrl || "empty"}). Invite links must ` +
        `point at the PORTAL, where /join lives — nothing was created.`
    );
  }

  const teams: TeamOutcome[] = [];

  // Read the workshop's teams ONCE: name resolution costs one call rather than one per team.
  let existing: ExistingTeam[];
  try {
    const res = await callService<{ teams?: ExistingTeam[] }>(
      TEAM_FN,
      "GET",
      `/v1/workshops/${encodeURIComponent(workshopId)}/teams`,
      identity
    );
    existing = (res.body?.teams ?? []).map((t) => ({ id: t.id, name: t.name }));
  } catch (err) {
    // ⚠ Without this list every name looks NEW, so it would DUPLICATE every existing team.
    throw new Error(`Could not read this experience's teams, so nothing was created: ${reason(err)}`);
  }

  for (const planned of plan.teams) {
    const members = plan.members.filter((m) => m.teamKey === planned.teamKey);

    let resolved;
    try {
      resolved = await resolveTeam(workshopId, planned.teamName, existing, identity);
    } catch (err) {
      teams.push({ teamName: planned.teamName, disposition: "failed", members: [], error: reason(err) });
      continue;
    }

    // Read the existing invitations ONCE per team, then share the set across role groups — otherwise
    // a team with two roles would read it twice and the second read would not see the first's writes.
    const seen = await alreadyInvited(resolved.team.id, identity);

    /**
     * Grouped by (platformRole, teamRole) because the invitations endpoint takes ONE role per request.
     * Grouping rather than one call per member keeps the call count down while still letting a team
     * mix an EXECUTIVE with participants.
     */
    const byRole = new Map<string, PlanMember[]>();
    for (const m of members) {
      const k = `${m.platformRole}|${m.teamRole ?? ""}`;
      byRole.set(k, [...(byRole.get(k) ?? []), m]);
    }

    const memberOutcomes: MemberOutcome[] = [];
    for (const group of byRole.values()) {
      const res = await inviteGroup(resolved.team, group, identity, appUrl, inviterName, seen);
      memberOutcomes.push(...res);
      // Anything just invited must not be re-invited by a later group on the same team.
      for (const o of res) if (o.status === "invited") seen.add(o.email);
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
    failed:
      all.filter((m) => m.status === "failed").length +
      teams.filter((t) => t.disposition === "failed").length,
    teams,
  };
}
