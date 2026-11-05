/**
 * The audit trail for ACCESS-AFFECTING administrative actions.
 *
 * Both removing a user from a team and disabling a user's platform access need an audit trail that
 * records whose action it was.
 *
 * WHAT THIS FIXES. Neither action recorded an actor. Removing someone from a team
 * hard-deleted the membership row and published `member.left` with only `{teamId, userId}`
 * — no actor at all — so "who removed this person?" was unanswerable from anywhere. There
 * was also no audit store on the platform: `grep -i audit` over the infrastructure template
 * returned three comments and no resource.
 *
 * REMOVAL IS NO LONGER A HARD DELETE. The membership row is kept and marked
 * INACTIVE so a removal can be REVERSED, which this table structurally cannot do for itself:
 * it is append-only by IAM, so an entry can never be amended, and an audit entry is a record of
 * an act rather than a piece of mutable state. Hence the division that runs through this file —
 * THE TRAIL RECORDS WHO DID WHAT, THE ROW RECORDS WHAT IS TRUE NOW. Neither substitutes for the
 * other, and MEMBER_RESTORED exists because of it.
 *
 * SCOPE IS DELIBERATELY NARROW. This is not a general activity feed. It records the
 * handful of actions that change WHETHER SOMEONE CAN GET IN, because those are the ones an
 * operator has to answer for later. Task edits, messages and commits are product activity
 * and belong nowhere near here — mixing them would bury the entries that matter under
 * thousands that do not, and would turn a bounded table into a traffic-sized one.
 */

/**
 * The actions worth a permanent record.
 *
 * A closed union rather than a free string, so adding one is a deliberate decision made in
 * this file rather than a typo that silently creates a second spelling of an existing
 * action — at which point a UI filtering on the first spelling shows an incomplete history,
 * which is worse than showing none.
 */
export const AUDIT_ACTIONS = [
  /**
   * Removed from a team's roster.
   *
   * The membership row is KEPT and marked INACTIVE (it was previously hard-deleted, until
   * reactivation required current state to live somewhere reversible), so this is no longer the
   * removal's ONLY trace — but it remains the only place the operator's `reason` and the
   * per-removal history live. A person removed twice has one row and two of these.
   */
  "MEMBER_REMOVED",
  /**
   * Restored to a team's roster — a MEMBER_REMOVED reversed.
   *
   * THE FOURTH ACTION, added against a real bar: a previous fourth member
   * (TEAM_CONTENT_ACCESSED) was deleted for being unnecessary, so the default answer to "do we
   * need one?" is no. It is needed here because MEMBER_REMOVED CANNOT EXPRESS A RESTORATION —
   * this table is append-only by IAM (no UpdateItem, no DeleteItem), so a reactivation cannot
   * amend the entry it reverses, and an audit entry is a record of an act rather than mutable
   * state, so there is nothing on it that could be flipped even if the store allowed it.
   *
   * Without it, restoring someone's team access would be the ONE access-affecting act on this
   * platform leaving no record of who did it — the exact gap this trail exists to
   * close, and worse than a missing removal because granting access is the direction that ADDS
   * privilege.
   *
   * Named for the ACCESS_DISABLED/ACCESS_ENABLED pair below: same subject noun as the action it
   * reverses, past participle, reversal second.
   */
  "MEMBER_RESTORED",
  /** Platform access disabled — the person can no longer sign in. */
  "ACCESS_DISABLED",
  /** Platform access restored. */
  "ACCESS_ENABLED",
  // A fifth member, TEAM_CONTENT_ACCESSED, recorded an audited ADMIN break-glass read of a
  // team's private content. It was built and then REMOVED with its route, because
  // investigation is an EXECUTIVE's job. It was also the only
  // action whose `subjectId` was a TEAM id rather than a user id; with it gone, every action
  // in this union is about a person again — see the `subjectId` note below.
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Human-readable labels. Kept beside the union so a new action cannot ship unlabelled. */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  MEMBER_REMOVED: "Removed from team",
  MEMBER_RESTORED: "Restored to team",
  ACCESS_DISABLED: "Access disabled",
  ACCESS_ENABLED: "Access restored",
};

/**
 * One audit entry.
 *
 * IDS ARE STORED, NAMES ARE RESOLVED AT READ TIME. Storing the actor's name would freeze it
 * at the moment of the action, so a later rename would make the trail disagree with the
 * directory — and worse, a stored name is a second copy of PII in a table that must never
 * be deleted. Subs are resolved to names through the same visibility-honouring helper the
 * Administration screen already uses, so a FACILITATOR reading a trail still cannot learn
 * about an ADMIN account.
 */
export interface AuditEntry {
  /**
   * WHO THE ACTION WAS ABOUT — the partition key, because "show me everything about this
   * person" is the read this table exists to serve.
   *
   * ALWAYS a user id. The removed break-glass action put a TEAM id here, which made
   * `GET /audit/users/:userId` reach every entry in a partition except that one; narrowed back
   * with it, so the guarantee holds without an exception.
   */
  subjectId: string;
  /**
   * `<ISO-8601>#<ulid>` — the sort key.
   *
   * The ULID suffix is not decoration. Two administrative actions on one person within the
   * same millisecond would collide on a bare timestamp and DynamoDB would silently
   * OVERWRITE one, losing an audit entry — the single failure mode this table cannot be
   * allowed to have. Sorts newest-last lexicographically, so a Query with
   * ScanIndexForward: false returns most-recent-first with no in-memory sort.
   */
  at: string;
  /** The ISO instant alone, denormalised so a reader need not parse the composite key. */
  occurredAt: string;
  action: AuditAction;
  /** WHO DID IT. Always a real signed-in principal; never a service, never inferred. */
  actorId: string;
  /**
   * The actor's role AT THE TIME. Stored rather than resolved, because this one genuinely
   * is a historical fact: "a FACILITATOR did this" stays true even if they are later made
   * an ADMIN, and re-deriving it from today's directory would rewrite the past.
   */
  actorRole: string;
  /**
   * The team, for MEMBER_REMOVED and MEMBER_RESTORED. Absent on platform-access actions, where
   * naming a team would imply a scope the change does not have.
   */
  teamId?: string;
  /** Denormalised so the trail still reads correctly after a team is renamed or deleted. */
  teamName?: string;
  /**
   * Free-text, operator-supplied. Length-capped at the write path.
   *
   * OPTIONAL on every remaining action, and no route now requires one. It was mandatory on
   * the removed break-glass action alone, which is why this stayed optional on the shape
   * rather than being split into two interfaces.
   */
  reason?: string;
  /**
   * WHEN THE PERSON HAD JOINED THE TEAM — the team actions (MEMBER_REMOVED, MEMBER_RESTORED)
   * only.
   *
   * Denormalised at write time from the membership row. It was originally copied here because
   * the removal HARD-DELETED that row, making this entry the sole record of when the
   * relationship started; the removal now keeps the row, so this is no longer the only copy.
   *
   * IT IS STILL WRITTEN, for two reasons. Removals performed BEFORE the switch to soft removal deleted their
   * rows, so for those entries this remains the only surviving evidence — and there is no
   * backfill, because the table is append-only. And it pins `joinedAt` AS AT THIS ACTION: a
   * person removed and re-added several times has ONE row carrying only the latest join, so
   * "when had they joined, the time they were removed in March?" is answerable per entry and
   * not from the row.
   *
   * That is what lets the "Former members" view render "Joined 2 Aug · Removed 4 Aug by
   * Facilitator One".
   *
   * Render an absent value as "join date unknown", NEVER as "never joined": the entry is itself
   * proof they were a member.
   */
  joinedAt?: string;
}

/** Cap on a reason string, enforced at the write path. */
export const AUDIT_REASON_MAX = 200;
