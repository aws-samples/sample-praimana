/**
 * ── SECURITY EVENT LOGGER ─────────────────────────────────────────────────────────────────
 *
 * A structured audit-event logger for security-relevant actions that only this tier observes.
 *
 * What it covers, the AUTHORITATIVE list is `AUDIT_EVENTS` below, not this summary:
 *   (a) Authentication, sign-in success, token verification failures, role-gate refusals.
 *   (b) Authorization, FORBIDDEN responses from this BFF.
 *   (c) Account lifecycle, invitation issuance, bulk provisioning, account enable/disable.
 *   (d) Privileged mutations, team membership and invitation credentials, cohort status and
 *       phase progression, submission release/reopen/edit, scoring, and results publication.
 *   (e) Desktop REST writes, with an UNVERIFIED actor; see the note on those names below.
 *
 * What it deliberately does NOT log:
 *   · Bearer tokens, temporary passwords, or any credential material.
 *   · PII beyond what an investigation requires (email on auth events, actor id everywhere).
 *
 * The output is structured JSON on stdout, the standard for serverless/container workloads
 * where a log collector (CloudWatch, Datadog, Splunk) ingests from stdout. No external
 * dependency is introduced; the format is compatible with any JSON-aware log pipeline.
 *
 * Each event carries:
 *   · `timestamp`, ISO 8601, always UTC.
 *   · `event`, a dot-namespaced event name (e.g. `auth.signin.success`).
 *   · `actor`, who performed the action (id, role; email only on auth events).
 *   · `target`, what was acted on (userId, teamId, workshopId, etc.).
 *   · `outcome`, `success` | `failure` | `denied`.
 *   · `reason`, human-readable context on failures/denials.
 *   · `metadata`, event-specific additional fields.
 */

export type AuditOutcome = "success" | "failure" | "denied";

/**
 * ── THE CATALOGUE: EVERY EVENT THIS TIER CAN EMIT ─────────────────────────────────────────────
 *
 * ⚠ THIS LIST EXISTS SO COVERAGE CAN BE REVIEWED RATHER THAN INFERRED, and its absence is why a
 * gap went unnoticed. The header above claimed coverage of "(d) Privileged mutations", but the
 * only way to check that claim was to grep for `auditLog(` and read every resolver, so six of
 * the most consequential mutations the BFF exposes (results publication, scoring, deliverable
 * edits, both phase writers, invitation revocation) emitted nothing while the documentation said
 * otherwise, and the desktop write tier emitted nothing at all.
 *
 * A union rather than prose: `event` is typed to it, so a new emit site must either use a listed
 * name or add one, and this list cannot drift from what the code actually emits. Reviewing
 * coverage is now reading one file.
 *
 * ⚠ ADDING A NAME IS A DECISION, NOT A FORMALITY. An event here is a commitment that the action
 * is worth an investigator's time; the fields it carries are constrained by "What it deliberately
 * does NOT log" above, no credentials, no free-text content, no PII beyond what an investigation
 * requires.
 */
export const AUDIT_EVENTS = [
  // (a) Authentication.
  "auth.signin.success",
  "auth.token_verification.failure",
  "auth.token_refresh.failure",
  "auth.role_gate.denied",

  // (b) Authorization, refusals this BFF issues.
  "authz.trpc.unauthorized",
  "authz.invite.denied",
  "authz.bulk_provision.denied",
  "authz.workshop.create.denied",
  /**
   * A bearer token refused at the `/api/desktop/*` door, missing, unsigned, expired, wrong
   * audience, or an ACCESS token where an ID token is required. Carries NO actor: the whole point
   * of the change that added this event is that an unverified `sub` is a claim, and a claim from a
   * caller we just refused is worth less than the path they tried.
   */
  "authz.desktop.unauthorized",
  /**
   * A mutation refused UPSTREAM (401/403/409), recorded centrally by `mapBackendErrors` so a
   * refused privileged attempt leaves a trace in the tier that knows the session identity.
   */
  "authz.trpc.denied",
  /**
   * A caller turned away by the per-user tRPC limiter, either the general procedure-call window or
   * the tighter one on the billable model call. Recorded because a client hitting it repeatedly is
   * either broken or probing, and neither is visible from a 429 alone.
   */
  "authz.trpc.rate_limited",

  // (c) Account lifecycle.
  "account.invite.issued",
  "account.bulk_provision.accepted",
  "account.access.enabled",
  "account.access.disabled",
  "account.access.audit_gap",

  // (d) Privileged mutations, team membership and credentials.
  "team.joined",
  "team.member.removed",
  "team.member.reactivated",
  "team.invitation.revoked",

  // (d) Privileged mutations, competitive state.
  "submission.released",
  "submission.reopened",
  "submission.patched",
  "submission.score.recorded",
  "submission.results.published",

  // (d) Privileged mutations, cohort state.
  "workshop.created",
  "workshop.status.updated",
  "workshop.phases.updated",
  "workshop.current_phase.updated",
  /**
   * ── ⚠ THREE NAMES THAT DID NOT EXIST, FOR THREE MUTATIONS THAT EMITTED NOTHING ────────────
   *
   * A SECURITY FINDING (low): three privileged portal mutations, workshop.update,
   * rating.publish and team.create, emitted no audit event, contrary to the tier's own audit
   * catalogue. Verified by reading the routers: workshop.ts had six auditLog calls and none in
   * `update`; rating.ts had none at all; team.ts had five and none in `create`.
   *
   * This list exists "so coverage can be reviewed rather than inferred", and was added after six
   * privileged mutations were found emitting nothing, so a gap here is a gap in the promise the
   * list makes, not merely a missing log line. There was no catalogue name for any of the three,
   * which is why nothing looked wrong: `auditLog` is typed to this union, so an absent name reads
   * as "not an event" rather than as "an event nobody records".
   *
   * `workshop.updated` is the cohort/experience configuration patch, name, dates, format,
   * team-size bounds, setup config, enabled assistants, sitting alongside `status.updated` and
   * `phases.updated`, which were both already audited.
   */
  "workshop.updated",
  /**
   * ── WORKSHOP RESOURCES: material the facilitator shares with everyone on an experience ──
   *
   * `added` fires at COMPLETION, not when the upload opens: that is the moment the file exists and
   * becomes visible to every role on the experience. `downloaded` records the minting of a presigned
   * read URL, a bearer-free capability, so the bucket's own access log sees a signature rather than a
   * user, and this is the only place an identity is tied to a resource read. `deleted` is the
   * destructive one and is irreversible from the portal.
   */
  "workshop.resource.added",
  "workshop.resource.downloaded",
  "workshop.resource.deleted",
  /**
   * `rating.published` is a DISCLOSURE rather than a save, in its own docstring's words: it
   * publishes model-written performance statements about named people to facilitators, executives
   * and judges. The catalogue already promises coverage of "results publication".
   */
  "rating.published",
  /**
   * `team.created` completes the team lifecycle, whose other four transitions, join,
   * removeMember, reactivateMember, revokeInvitation, were all audited already.
   */
  "team.created",

  /**
   * (e) The desktop REST tier.
   *
   * ⚠ THE ACTOR ON THESE IS NOW VERIFIED, AND THAT IS A CHANGE FROM WHAT THIS NOTE USED TO SAY.
   * It read: "the ACTOR IS NOT VERIFIED HERE … `actor.id` is a decoded claim rather than an
   * established identity", because `withBearer` admitted on header presence and the id came from
   * `decodeJwt`. `withBearer` now verifies the ID token (signature, `iss`, `aud`, `exp`,
   * `token_use`) before the handler runs, so `actor.id` is the Cognito `sub` from a proven token
   * and `metadata.actorVerified: true` states it. The distinct prefix is kept, it identifies the
   * DOOR, which is still worth querying separately from the tRPC tier.
   */
  "desktop.message.sent",
  "desktop.task.created",
  "desktop.team.joined",
] as const;

/** One of {@link AUDIT_EVENTS}. */
export type AuditEventName = (typeof AUDIT_EVENTS)[number];

export interface AuditEvent {
  /**
   * Dot-namespaced event identifier, e.g. `auth.signin.success`.
   *
   * Typed to {@link AUDIT_EVENTS} rather than `string`: a typo used to produce a silently
   * unqueryable record, and an unlisted name made the catalogue a guess.
   */
  event: AuditEventName;
  /** The actor who initiated the action. */
  actor?: {
    id?: string;
    role?: string;
    /** Included ONLY on authentication events where the email is the lookup key. */
    email?: string;
  };
  /** The target of the action. */
  target?: Record<string, string | number | boolean | undefined>;
  /** Whether the action succeeded, failed, or was denied. */
  outcome: AuditOutcome;
  /** Human-readable explanation, especially on failure/denial. */
  reason?: string;
  /** Event-specific structured data. */
  metadata?: Record<string, unknown>;
}

interface AuditLogEntry extends AuditEvent {
  timestamp: string;
  level: "AUDIT";
}

/**
 * Emit a structured security audit event.
 *
 * Writes to stdout as a single JSON line. Never throws, a logging failure must not break
 * the action it is recording.
 */
export function auditLog(event: AuditEvent): void {
  try {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      level: "AUDIT",
      ...event,
    };
    // Single-line JSON, compatible with structured log ingestion.
    // Uses stdout (not stderr) so it is captured alongside application logs.
    process.stdout.write(JSON.stringify(entry) + "\n");
  } catch {
    // Never throw from a logger. If stdout is broken, the action still proceeds.
  }
}
