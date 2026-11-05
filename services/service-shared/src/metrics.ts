/**
 * CUSTOM METRICS via CloudWatch Embedded Metric Format (EMF) — one home, so a
 * "should never happen" that happens is visible in every service instead of in
 * whichever one remembered to instrument itself.
 *
 * ── WHY EMF AND NOT PutMetricData ──
 *
 * Every caller below is on a FAILURE PATH of something we must not make the caller wait
 * on or fail on. A PutMetricData call is another network request that can itself hang or
 * throw — exactly the class of problem being reported — needs `cloudwatch:PutMetricData`
 * on every emitting role, and would need a `monitoring` VPC endpoint for any function
 * inside the VPC. EMF is a structured line on stdout: CloudWatch Logs turns it into a
 * real metric asynchronously, so emitting costs ONE console.log, cannot throw a network
 * error, and needs NO IAM beyond the log writes every function already does.
 *
 * The trade accepted: the metric appears with CloudWatch Logs' own ingestion delay
 * rather than immediately, and it only exists where the log group is being parsed for
 * EMF (which is automatic for any account — no configuration). For a "page a human"
 * signal that delay is irrelevant; for a latency SLI it would not be.
 *
 * ── WHY IT LIVES IN service-shared ──
 *
 * Ported here from apps/services/cognito-postconfirmation, which had the only copy. It
 * is now the ONLY copy: a per-service duplicate is how the third one drifts, and the
 * dimension-set trick below is subtle enough that a drifted copy would publish a metric
 * no alarm ever matches — a monitoring gap that looks exactly like "no failures".
 * Every service that emits already depends on this package.
 */

/**
 * CloudWatch's hard limits, restated as the reason they matter HERE: an EMF record that
 * violates one is REJECTED WHOLE by the log-group parser, which silently produces no
 * metric at all — indistinguishable, at the alarm, from a healthy system. So the helper
 * clamps rather than emitting something that will be thrown away.
 */
/** Max dimensions in one CloudWatch dimension set. */
const MAX_DIMENSIONS = 30;
/** Max characters in a dimension name or value. */
const MAX_DIMENSION_VALUE_CHARS = 255;

export interface EmfMetric {
  /**
   * CloudWatch namespace. MUST match the `Namespace` on the alarm watching it, exactly
   * — a typo here does not fail anything, it just means the alarm watches a metric
   * nobody publishes and stays permanently OK.
   */
  namespace: string;
  /** Metric name. Same exact-match rule as `namespace`. */
  name: string;
  /** The datapoint. Emit 0 on success too — see emitAccessAuditMetric for why. */
  value: number;
  /**
   * Dimension keys and values. BOUNDED VALUES ONLY (the cardinality rule): a dimension
   * multiplies into a separate metric per distinct value, so an id, an email or an error
   * string here is unbounded cardinality and an unbounded bill. Ids belong in
   * `properties`.
   */
  dimensions?: Record<string, string>;
  /**
   * Extra fields on the log line — SEARCHABLE IN LOGS INSIGHTS, not metric dimensions.
   * This is where ids go, and it is the whole reason the pair exists: an investigation
   * needs "which subject, which actor", and CloudWatch metrics are the wrong place to
   * put either.
   */
  properties?: Record<string, unknown>;
  /** Prefix for the human-readable `message`, matching each service's log convention. */
  source?: string;
}

/**
 * Emit ONE metric datapoint. Never throws, never awaits, never allocates a client.
 *
 * DELIBERATELY SWALLOWING. Observability must not break the operation it reports on —
 * every caller is already on a degraded path, and a metric emission that threw would
 * turn a reported partial into a 500 on work that has already taken effect.
 */
export function emitMetric(metric: EmfMetric): void {
  try {
    const { namespace, name, value, dimensions, properties, source } = metric;

    // Blank values and over-long values are DROPPED/CLAMPED rather than passed through,
    // because either one makes CloudWatch reject the whole record (see MAX_* above).
    // Dropping a key still leaves the aggregate dimension set below publishing, so the
    // alarm keeps working on a malformed breakdown value — losing the breakdown beats
    // losing the signal.
    const safe: Record<string, string> = {};
    for (const [key, raw] of Object.entries(dimensions ?? {})) {
      if (Object.keys(safe).length >= MAX_DIMENSIONS) break;
      const text = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
      if (!text) continue;
      safe[key] = text.slice(0, MAX_DIMENSION_VALUE_CHARS);
    }
    const keys = Object.keys(safe);

    // TWO DIMENSION SETS, which is the whole trick that makes an alarm work.
    //
    // CloudWatch treats each distinct dimension COMBINATION as its OWN metric, and an
    // alarm must match one EXACTLY — so an alarm declared with no `Dimensions` would
    // never see a datapoint published only under {Action}. Emitting the EMPTY SET as
    // well publishes a genuinely dimensionless metric the alarm can watch directly
    // (aggregated across every dimension value, which is the right signal: ANY of them
    // failing is the problem), while the keyed set stays available for breaking the
    // number down afterwards. `[[]]` alone would be the aggregate only, and `[keys]`
    // alone is the mistake that leaves an alarm silently watching nothing.
    const dimensionSets = keys.length > 0 ? [[], keys] : [[]];

    console.log(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: namespace,
              // Dimension KEYS only; values are read from the top-level properties
              // merged in below.
              Dimensions: dimensionSets,
              Metrics: [{ Name: name, Unit: "Count" }],
            },
          ],
        },
        ...properties,
        // Dimensions LAST so a `properties` key can never shadow a dimension value and
        // publish the metric under a value the caller did not choose.
        ...safe,
        [name]: value,
        // Human-readable marker so the same line is useful when read as a log.
        message: source
          ? `[${source}] metric ${name}=${value}`
          : `metric ${name}=${value}`,
      })
    );
  } catch {
    // Never let observability break the operation it observes. Reached in practice only
    // by a non-serialisable `properties` value (a circular reference); asserted in
    // metrics.test.ts because "cannot throw" is a contract every caller relies on.
  }
}

// ─── The unaudited-access-change signal ─────────────────────────────────────────────

/**
 * ONE namespace for the access-change signal, shared by the team and user-access
 * services. Both write the same `praimana-audit` table, so the question the metric
 * answers ("did an access change go unrecorded?") is one question, not two.
 *
 * A LITERAL, deliberately NOT overridable by env, unlike the cognito trigger's
 * namespace: the only effect an override could have here is to move the metric away
 * from the alarm that watches it, which is a switch for blinding the alarm with no
 * operational use. Must equal the `Namespace` on UnauditedAccessChangeAlarm in
 * the infrastructure CloudFormation template.
 */
export const ACCESS_METRIC_NAMESPACE = "Praimana/AccessChanges";

/**
 * ONE metric for every access change, dimensioned by action rather than one metric each:
 * the alarm question is "did ANY access change go unrecorded", and N metrics would mean N
 * alarms and N-1 chances to forget one.
 *
 * Must equal the `MetricName` on UnauditedAccessChangeAlarm in the all-in-one template.
 */
export const UNAUDITED_ACCESS_CHANGES_METRIC = "UnauditedAccessChanges";

/**
 * The access changes that write the audit trail. A CLOSED SET, which is what makes
 * `Action` a legal dimension under the cardinality rule — five values, bounded for the
 * life of the platform, versus a userId which is unbounded by definition.
 *
 * ENTITLEMENT_REVOKED is the FIFTH member. It is the
 * withdrawal of a JUDGE's WORKSHOP entitlement — `DELETE /v1/teams/:teamId/invitations/
 * :email/workshop` in the team service, which clears the invitation row's `workshopId` and
 * nothing else. It belongs on THIS metric rather than a new one for the reason the metric is
 * shared at all: it is an access change (it is the only way to withdraw a registered judge's
 * read access to a workshop), it writes the same append-only `praimana-audit` table,
 * and "did an access change go unrecorded?" is one question however many actions can produce
 * it.
 *
 * Adding a value here stays cheap at the alarm because UnauditedAccessChangeAlarm watches the
 * EMPTY dimension set — the aggregate across every action — so a new action is covered the
 * moment it emits, with no template change to the alarm's Namespace/MetricName/Dimensions.
 *
 * ROLE_GRANTED is the SIXTH, added with the existing-account gate on
 * POST /v1/user-access/provision. It clears the same bar the fourth and fifth did — NO
 * EXISTING ACTION CAN EXPRESS IT. The ACCESS_* pair is about whether an account may sign in
 * AT ALL, which a group addition does not touch; the MEMBER_* pair is about a team roster.
 * Without it, adding a Cognito group to an account ALREADY IN USE — a privilege change that
 * collapseGroupsToRole turns into a promotion — was the one access-affecting act on this
 * platform that left no record of who made it, while the strictly smaller act on /access
 * wrote a row.
 */
export type AuditedAccessAction =
  | "MEMBER_REMOVED"
  | "MEMBER_RESTORED"
  | "ACCESS_DISABLED"
  | "ACCESS_ENABLED"
  | "ENTITLEMENT_REVOKED"
  | "ROLE_GRANTED";

export interface AccessAuditMetric {
  /** Which change happened. The metric's only dimension. */
  action: AuditedAccessAction;
  /**
   * The `audited` flag the route is about to report. FALSE emits 1 (the alarm's
   * datapoint); TRUE emits 0.
   *
   * ⚠ CALL THIS ONLY WHERE A CHANGE ACTUALLY HAPPENED. On the team routes `audited:
   * false` is ALSO what an idempotent no-op returns — a second removal of an
   * already-INACTIVE member, or a reactivation of an already-ACTIVE one, writes no
   * second entry BY DESIGN and reports false to say "no entry was needed". Emitting
   * there would page on a double-click and train everyone to ignore the alarm, which is
   * worse than having no alarm. Those routes call this inside their real-flip branch.
   */
  audited: boolean;
  /** WHO the change was about. A log property, never a dimension. */
  subjectId: string;
  /** WHO made it — the field whose loss is the entire point of the alarm. */
  actorId: string;
  /** Which team, on the two team actions. Absent for platform-wide access changes. */
  teamId?: string;
  /** Log-line prefix, e.g. "team" / "user-access". */
  source: string;
}

/**
 * Signal that an access change either WAS or WAS NOT written to the audit trail.
 *
 * ── WHY THIS EXISTS ──
 *
 * `audit.record` never throws by contract; it returns false. That is correct — by the
 * time it runs the access change has ALREADY taken effect (the membership row is
 * flipped, or Cognito has already been told), so failing the request would have the
 * operator retry a completed action. But it means an access change can succeed, answer
 * 200, and leave NO RECORD OF WHO MADE IT, with nothing raising a signal. This is that
 * signal; the 200 is deliberately unchanged.
 *
 * ── WHY A SUCCESS DATAPOINT (0) ──
 *
 * So the metric EXISTS in a healthy account. Without it, "no data" and "no failures"
 * look identical at the alarm, and a deploy that broke the emission entirely would read
 * as a permanently healthy platform. Same reason the cognito trigger emits its 0.
 *
 * ── NO PII ──
 *
 * Ids only, in the log properties. No email and no reason text: the reason is operator
 * free-text that may name a person, and an address in a metric dimension would be both
 * a disclosure and unbounded cardinality.
 */
export function emitAccessAuditMetric(metric: AccessAuditMetric): void {
  const { action, audited, subjectId, actorId, teamId, source } = metric;
  emitMetric({
    namespace: ACCESS_METRIC_NAMESPACE,
    name: UNAUDITED_ACCESS_CHANGES_METRIC,
    value: audited ? 0 : 1,
    dimensions: { Action: action },
    properties: {
      subjectId,
      actorId,
      ...(teamId ? { teamId } : {}),
      // Stable, greppable, and states the consequence rather than the mechanism — this
      // line is what an operator lands on from the alarm's runbook.
      event: audited
        ? "access change recorded"
        : "access change UNRECORDED — no trail entry of who made it",
    },
    source,
  });
}

// ─── Team seat ledger drift ──────────────────────────────────────────────────

/**
 * Namespace for the seat-ledger drift metric. MUST match the `Namespace` on
 * SeatLedgerDriftAlarm in the infrastructure CloudFormation template — a typo does not fail
 * anything, it just means the alarm watches a metric nobody publishes and stays permanently OK.
 */
export const SEAT_LEDGER_METRIC_NAMESPACE = "Praimana/TeamSeats";

/** Must equal the `MetricName` on SeatLedgerDriftAlarm in the all-in-one template. */
export const SEAT_LEDGER_DRIFT_METRIC = "SeatLedgerDrift";

export interface SeatLedgerDriftMetric {
  /** Team whose ledger was compared. An id, so it goes in `properties`, never a dimension. */
  teamId: string;
  /** ACTIVE membership rows actually returned by the roster read. */
  actualActive: number;
  /**
   * `memberCount` on the team row, or `null` when the attribute is ABSENT.
   *
   * Null is NOT drift and must not be reported as such: it is a row that predates the ledger
   * and has not been backfilled or lazily initialised yet. Reported separately (`unledgered`)
   * because it needs a different action — run the backfill — and because a team that is
   * genuinely unledgered would otherwise show drift equal to its whole roster and swamp the
   * signal the alarm exists for.
   */
  ledgerCount: number | null;
  source?: string;
}

/**
 * Report whether the seat ledger agrees with the roster it is supposed to summarise.
 *
 * ── WHAT THIS IS ACTUALLY FOR, AND WHAT IT IS NOT ──
 *
 * `memberCount` is not a cache of the roster — it moves in the SAME `TransactWriteItems` as the
 * membership row, so under the repository's own writes it CANNOT drift. This
 * metric therefore does not exist to repair expected divergence. It exists to catch the one
 * thing the design cannot prevent: a future write path that touches `team-members` without
 * going through `admit`/`deactivate`/`reactivate`, which would leave the ledger silently wrong
 * and start refusing joins to a team that has room.
 *
 * A non-zero datapoint means someone bypassed the repository. That is a code defect to find,
 * not a number to reconcile — which is why there is no reconciliation route.
 *
 * ── WHY IT EMITS 0 ON AGREEMENT ──
 *
 * Same reasoning as `emitAccessAuditMetric`: a metric only published when something is wrong is
 * indistinguishable from a metric nobody publishes, so the alarm cannot tell "healthy" from
 * "the emitting code was deleted". Publishing 0 makes silence itself a signal.
 *
 * NEVER THROWS and never awaits — `emitMetric` swallows by contract. This sits on a read path
 * that has already produced its answer, and an observability failure must not turn a served
 * roster into a 500.
 */
export function emitSeatLedgerDriftMetric(metric: SeatLedgerDriftMetric): void {
  const { teamId, actualActive, ledgerCount, source } = metric;
  const unledgered = ledgerCount === null;
  // Drift is 0 for an unledgered row, NOT `actualActive`. See the field note: the two states
  // need different actions, and conflating them would bury real drift under backfill noise.
  const drift = unledgered ? 0 : Math.abs(actualActive - ledgerCount);
  emitMetric({
    namespace: SEAT_LEDGER_METRIC_NAMESPACE,
    name: SEAT_LEDGER_DRIFT_METRIC,
    value: drift,
    properties: {
      teamId,
      actualActive,
      ledgerCount,
      unledgered,
      // Stable and greppable, and states the consequence rather than the mechanism — this is
      // the line an operator lands on from the alarm's runbook.
      event: unledgered
        ? "team row has no memberCount — run scripts/backfill-team-seat-ledger.mjs"
        : drift === 0
          ? "seat ledger agrees with the roster"
          : "SEAT LEDGER DRIFT — a writer bypassed the membership repository",
    },
    source,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// FAIL-CLOSED REFUSALS — the metric that makes a dependency outage visible
//
// ── ⚠ WHY THIS EXISTS: `AWS/Lambda Errors` IS STRUCTURALLY BLIND HERE ──
//
// Over a representative 7-day window: 21,973 requests, 1,019 4xx, 1 5xx — and Lambda `Errors` was
// ZERO across every service. Yet this platform's CHARACTERISTIC failure is a fail-closed refusal:
// `TEAM_SCOPE_UNAVAILABLE`, `ENTITLEMENTS_UNAVAILABLE`, `SNAPSHOT_SOURCE_UNAVAILABLE`. The
// fail-closed rule REQUIRES them — an unanswered question must never be reported as an answer — and every one is a
// SUCCESSFUL invocation that returns a 503 body.
//
// So the first metric an operator reaches for cannot see the outage this architecture is built
// around. A Team-service brownout could refuse every participant on the platform for ten minutes
// with `Errors` flat at zero and no alarm firing. This closes that.
//
// ── ⚠ EMITTED BY MIDDLEWARE, NOT AT ~50 CALL SITES ──
//
// There are around fifty places across the services that return a coded 503, spread over sixteen
// codes. Instrumenting each one would be invasive, easy to get wrong, and — the part that matters —
// EASY TO FORGET AT THE NEXT ONE. A response-inspecting middleware covers every current site and
// every future site by construction, and the count of edits is one.

/** Namespace for fail-closed refusals. MUST match the Namespace on FailClosedRefusalAlarm. */
export const FAIL_CLOSED_NAMESPACE = "Praimana/FailClosed";
/** MUST match the MetricName on FailClosedRefusalAlarm. */
export const FAIL_CLOSED_METRIC = "FailClosedRefusals";

/**
 * A 503 whose body carried no `code`.
 *
 * ⚠ COUNTED, NOT DROPPED. An uncoded 503 is still a refusal a user experienced, and dropping it
 * would make the metric quietly under-report exactly where the code is missing — which is also
 * where the handler is least well understood.
 */
export const UNCODED_REFUSAL = "UNCODED";

/**
 * Record one fail-closed refusal.
 *
 * `service` and `code` are DIMENSIONS because an operator's first two questions are "which service"
 * and "why" — and both are bounded, low-cardinality sets (nine services, sixteen codes). No ids go
 * in dimensions; `emitMetric`'s empty-set trick means the alarm can watch the total while the
 * breakdown stays available for investigation.
 *
 * ── ⚠ `workshopId` IS A PROPERTY, NOT A DIMENSION — A DELIBERATE DEPARTURE ──
 *
 * An earlier observability plan asked for a workshopId DIMENSION so an operator could
 * ask "is the platform healthy for the workshop running right now". That is the right QUESTION and
 * the wrong MECHANISM, for two reasons:
 *
 *   1. UNBOUNDED CARDINALITY. The cardinality rule and this file's own rule forbid it: one metric
 *      per distinct value, forever, on a value that grows with every experience ever run.
 *   2. ⚠ AND IT IS CALLER-CONTROLLED. The id is read off the REQUEST PATH, and on this metric's
 *      path it cannot be anything better — `TEAM_SCOPE_UNAVAILABLE` fires precisely BECAUSE the
 *      scope could not be resolved, so nothing has validated that the workshop exists. Dimensioning
 *      it would let an anonymous caller mint unlimited metric series by varying a URL segment: a
 *      cost-amplification hole opened by the monitoring.
 *
 * The question is still answered, at zero cardinality cost, by the Logs Insights widget on the
 * platform dashboard (`stats count(*) by workshopId, Code`) — EMF records are log lines first and
 * metrics second, so the breakdown is already there to be queried. What is lost is the ability to
 * ALARM per workshop, which is the correct thing to give up: the alarm question is "is the platform
 * refusing", and that is per-platform.
 */
export function emitFailClosedRefusal(refusal: {
  service: string;
  code: string;
  /** Searchable in Insights, never a dimension — the route that refused. */
  routePath?: string;
  /** The experience the request was about, when the path named one. See the note above. */
  workshopId?: string;
  /** The team the request was about, when the path named one. Also never a dimension. */
  teamId?: string;
}): void {
  emitMetric({
    namespace: FAIL_CLOSED_NAMESPACE,
    name: FAIL_CLOSED_METRIC,
    value: 1,
    dimensions: { Service: refusal.service, Code: refusal.code },
    properties: {
      ...(refusal.routePath ? { routePath: refusal.routePath } : {}),
      ...(refusal.workshopId ? { workshopId: refusal.workshopId } : {}),
      ...(refusal.teamId ? { teamId: refusal.teamId } : {}),
    },
    source: refusal.service,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTH DENIALS — the two event classes a security investigation starts from
//
// ── ⚠ WHY THIS EXISTS ──
//
// The platform logged business outcomes generously and kept an append-only audit trail for
// access-CHANGE actions, and recorded NOTHING AT ALL for authentication failures and authorization
// denials. Concretely, before this:
//
//   · `edgeIdentityMiddleware` — the single authentication entry point for every HTTP service — had
//     two 401 exits (invalid/expired token, and missing credentials) and neither emitted a log line
//     or a metric. Those were the ONLY two 401 sites in non-test code, so token replay, expired-token
//     floods, credential stuffing and probes of the `x-internal-token` shared secret left no trace
//     whatsoever.
//   · 69 `403` responses across the service routers, and the per-service guard modules producing most
//     of them logged nothing: `grep -c "console\." */src/authz.ts` was 0 for ai, collaboration, docs,
//     source, team and workshop.
//   · No request-level access log exists (there is no Hono `logger()` anywhere), and the one
//     cross-cutting response middleware was instrumented for 503 ONLY — `if (c.res.status !== 503)
//     return;` — so 401 and 403 were excluded by construction.
//
// The consequence was that an incident responder could not answer "who tried to authenticate and
// failed" or "which principal was refused which resource" from the platform's own records.
//
// ── ⚠ COUNTED IN ONE PLACE, NOT AT 71 CALL SITES ──
//
// This is emitted from the `withHealth` response middleware, which every service is already wrapped
// by — so one insertion instruments the whole platform and a tenth service is covered on arrival.
// Instrumenting each guard would have meant 69 edits and a permanent obligation to remember the
// 70th. The per-guard DETAIL (which principal, which resource) is a separate concern from the COUNT,
// and lives in the guards' own log lines.
//
// API Gateway access logging may also capture some of these, but that configuration lives in the
// `infrastructure` repo and cannot be relied on from here — and an access log carries no
// service-level reason.

export const AUTH_DENIAL_NAMESPACE = "Praimana/AuthDenials";

/** MUST match the MetricName on any alarm watching authentication/authorization failures. */
export const AUTH_DENIAL_METRIC = "AuthDenials";

/**
 * Record one authentication failure (401) or authorization denial (403).
 *
 * `Service` and `Status` are the DIMENSIONS — the two questions an operator asks first ("which
 * service", "refused or unauthenticated"), and both are bounded: nine services × two statuses.
 *
 * ⚠ `routePath` IS A PROPERTY AND MUST ALREADY BE A TEMPLATE. Pass `routeTemplate(path)`, never
 * `c.req.path`: several routes are keyed on an email address, and the raw path would put personal data
 * into the log line and an unbounded value into the property. See `routeTemplate` for the full
 * argument.
 *
 * ⚠ NO PRINCIPAL, NO TOKEN, NO ADDRESS on this record, in dimensions OR properties. A denial is
 * counted here; WHO was denied belongs in the guard's own structured log where it can be correlated
 * by request, not in a metric series.
 */
export function emitAuthDenial(denial: {
  service: string;
  /** 401 or 403. Narrowed to the two, because a third value would be a bug rather than a datapoint. */
  status: 401 | 403;
  /** The route TEMPLATE that refused — searchable in Insights, never a dimension. */
  routePath?: string;
  /** The experience the request was about, when the path named one. */
  workshopId?: string;
  /** The team the request was about, when the path named one. */
  teamId?: string;
}): void {
  emitMetric({
    namespace: AUTH_DENIAL_NAMESPACE,
    name: AUTH_DENIAL_METRIC,
    value: 1,
    dimensions: { Service: denial.service, Status: String(denial.status) },
    properties: {
      ...(denial.routePath ? { routePath: denial.routePath } : {}),
      ...(denial.workshopId ? { workshopId: denial.workshopId } : {}),
      ...(denial.teamId ? { teamId: denial.teamId } : {}),
    },
    source: denial.service,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// BEDROCK REFUSALS — the outage that is invisible to every AWS metric
//
// ── ⚠ WHY NOTHING ELSE SEES THIS ──
//
// Observed when probing each model in turn in a fresh account:
//
//   sonnet-5             403  "Your AWS Marketplace subscription for this model cannot be
//                             completed at this time"   (LISTED IS NOT SUBSCRIBED)
//   sonnet-4-6 / 4-5 / 4 404  "Model use case details have not been submitted for this account"
//   haiku-4-5            answered NORMALLY, then returned that same 404 FOUR MINUTES LATER
//
// That last line is the whole reason this metric exists. The gate closed MID-SESSION, with no
// deploy, no config change, and no AWS metric moving: `AWS/Bedrock` publishes invocation counts for
// calls that HAPPEN, and a refusal at the entitlement layer is not this account's invocation. So
// insights generation can stop working platform-wide with every graph flat.
//
// ── ⚠ SCOPE: INSIGHTS GENERATION ONLY, AND THAT IS THE WHOLE OF IT ──
//
// The only Bedrock caller this platform owns is the executive-only ratings/summary path
// (`analyst.bedrock.ts` — `assessKnowledge` and `summariseTeam`). Nothing else here invokes a model:
// the conversational port was removed, and participants work in their OWN local CLI.
//
// ⚠ A PARTICIPANT'S ASSISTANT IS DELIBERATELY NOT COUNTED HERE. An earlier version of this metric had
// a second `PARTICIPANT_CLI` origin, inferred from the failure text the desktop app syncs. It was
// removed as WRONG IN PRINCIPLE: the platform does not control which assistant a developer uses, and
// Claude Code on subscription auth, Codex and Kiro never touch Bedrock at all. Those failures are
// therefore not Bedrock refusals, not attributable to this account, and not actionable by anyone
// reading these alarms. See the note at the `isClientErrorContent` branch in the AI service's sync
// route, which still SCRUBS that text — for disclosure and `aiTurns` correctness, not observability.

/** Namespace for Bedrock refusals. MUST match the Namespace on BedrockRefusalAlarm. */
export const BEDROCK_NAMESPACE = "Praimana/Bedrock";

/** MUST match the MetricName on BedrockRefusalAlarm. */
export const BEDROCK_REFUSALS_METRIC = "BedrockRefusals";

/**
 * A refusal this code did not recognise.
 *
 * ⚠ COUNTED, NOT DROPPED — same rule as `UNCODED_REFUSAL`. An unclassified failure is still an
 * executive who got no insights, and dropping it would hide the arrival of a NEW failure mode, which
 * is the one an operator most needs to see. A rising `UNKNOWN` is a signal in itself: it means the
 * classifier needs a new case.
 */
export const UNKNOWN_BEDROCK_REFUSAL = "UNKNOWN";

/**
 * Record one Bedrock refusal.
 *
 * `reason` is the ONLY dimension — roughly a dozen values, a closed set defined in code, so this is
 * bounded for the life of the platform. Everything identifying (which team, which model id) is a
 * property: a model ARN embeds an ACCOUNT ID and would be both a disclosure and unbounded
 * cardinality in a dimension.
 *
 * ⚠ NO MESSAGE TEXT, EVER. A Bedrock error string carries an account id, a role ARN and an action
 * name. The bounded `reason` is the whole point: it says WHAT happened, and what to do about it,
 * without repeating the provider's prose.
 */
export function emitBedrockRefusal(refusal: {
  /** Bounded classification. `UNKNOWN_BEDROCK_REFUSAL` when nothing matched. */
  reason: string;
  /** Which service observed it — the log-line prefix, and never a dimension. */
  service: string;
  /** Optional context for the investigation, all properties. */
  properties?: Record<string, unknown>;
}): void {
  emitMetric({
    namespace: BEDROCK_NAMESPACE,
    name: BEDROCK_REFUSALS_METRIC,
    value: 1,
    dimensions: { Reason: refusal.reason },
    properties: {
      ...refusal.properties,
      // Stable and greppable, and states the consequence rather than the mechanism — this is the
      // line an operator lands on from the alarm's runbook.
      event: "Bedrock refused an insights-generation call",
    },
    source: refusal.service,
  });
}

