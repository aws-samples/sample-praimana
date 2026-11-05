/**
 * ── WHICH EXPERIENCE WAS THIS REQUEST ABOUT? ───────────────────────────────────────────────
 *
 * The question: "is the platform healthy FOR THE WORKSHOP
 * RUNNING RIGHT NOW". During a live event that is the only version of the question anyone asks,
 * and today nothing can answer it: every metric is per function or per account.
 *
 * This derives the scope from the REQUEST PATH, which is what makes it free. `/v1/workshops/:id/…`
 * and `/v1/teams/:id/…` already carry the ids, so one middleware covers every existing route and
 * every future one — the same reason the fail-closed counter lives in middleware rather than at
 * fifty call sites.
 *
 * ── ⚠ THE VALUES ARE UNTRUSTED, AND THAT DECIDES WHERE THEY MAY GO ──
 *
 * A path segment is whatever the CALLER typed. It is not a validated id, and on the refusal path
 * it usually CANNOT be one: `TEAM_SCOPE_UNAVAILABLE` and `ENTITLEMENTS_UNAVAILABLE` are emitted
 * *because* the platform could not resolve the scope, so by construction nothing has checked that
 * this workshop exists or that the caller may see it.
 *
 * So these are EMF **properties** (searchable in Logs Insights), NEVER metric dimensions. See
 * `emitFailClosedRefusal` for the full argument; the short version is that a dimension per id is
 * unbounded cardinality that an anonymous caller could inflate at will.
 */

/**
 * Longest id this will report. Ids on this platform are ULIDs (26 chars) or short slugs, so 64 is
 * generous — the cap exists to stop a caller putting a kilobyte of path into every log line.
 */
const MAX_ID_CHARS = 64;

/**
 * What a real id may contain. ULIDs and slugs only.
 *
 * ⚠ A NON-MATCHING SEGMENT IS REPORTED AS `INVALID`, NOT DROPPED AND NOT PASSED THROUGH. Dropping
 * it would make a scan for junk ids impossible at exactly the moment someone is probing the API;
 * passing it through would put caller-controlled text into an operator's log line. `INVALID` says
 * "something was there and it was not an id", which is the fact worth keeping.
 */
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Reported in place of a segment that is present but not id-shaped. */
export const INVALID_SCOPE_ID = "INVALID";

export interface RequestScope {
  /** The experience this request was about, when the path names one. */
  workshopId?: string;
  /** The team this request was about, when the path names one. */
  teamId?: string;
}

function normaliseId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let text: string;
  try {
    // Paths arrive percent-encoded. A malformed escape throws rather than returning the input,
    // which would otherwise turn an observability helper into the cause of a 500.
    text = decodeURIComponent(raw);
  } catch {
    return INVALID_SCOPE_ID;
  }
  text = text.trim();
  if (!text) return undefined;
  if (text.length > MAX_ID_CHARS || !ID_SHAPE.test(text)) return INVALID_SCOPE_ID;
  return text;
}

/**
 * Read the workshop and team ids out of a request path.
 *
 * ⚠ MATCHES THE SEGMENT AFTER THE COLLECTION NAME, WHEREVER IT APPEARS — not a fixed position.
 * The routes are not uniform: `/v1/teams/:teamId/…` on the team service, `/v1/ai/teams/:teamId/…`
 * on the AI service, and each Lambda sees a DIFFERENT prefix depending on its basePath. Anchoring
 * on `/v1/teams` would silently return nothing for the AI service, which reads as "no team
 * involved" rather than as a bug.
 *
 * ⚠ `workshops` HERE IS THE URL WORD, NOT THE PRODUCT WORD. The product calls these
 * "experiences"; every route path says `workshops`. Renaming the routes would break this, so it is
 * asserted in the tests rather than left to be discovered.
 *
 * Never throws — it runs on an already-degraded request.
 */
export function scopeFromPath(path: string): RequestScope {
  const scope: RequestScope = {};
  if (!path) return scope;

  const segments = path.split("/");
  for (let i = 0; i < segments.length - 1; i += 1) {
    // First occurrence wins: a path cannot legitimately name two different workshops, and taking
    // the last would let a trailing segment that happens to be called "teams" overwrite the real
    // one.
    if (segments[i] === "workshops" && scope.workshopId === undefined) {
      const id = normaliseId(segments[i + 1]);
      if (id !== undefined) scope.workshopId = id;
    } else if (segments[i] === "teams" && scope.teamId === undefined) {
      const id = normaliseId(segments[i + 1]);
      if (id !== undefined) scope.teamId = id;
    }
  }

  return scope;
}

/**
 * ── WHICH ROUTE WAS THIS, WITHOUT NAMING ANYBODY ────────────────────────────────────────────
 *
 * A bounded, caller-independent label for a request path: `/v1/teams/t-123/invitations/a@b.c/workshop`
 * becomes `/v1/teams/:id/invitations/:id/workshop`.
 *
 * ⚠ ADDED FOR THE AUTH-DENIAL INSTRUMENTATION, AND THE TWO PROBLEMS IT SOLVES ARE BOTH
 * REASONS THE RAW PATH COULD NOT BE USED:
 *
 *   1. PERSONAL DATA. Several routes are keyed on an EMAIL ADDRESS
 *      (`DELETE /teams/:teamId/invitations/:email`). Logging the raw path on every 401/403 would
 *      write recipient addresses into CloudWatch on exactly the requests most likely to be
 *      attacker-driven — the same mistake the notify audit line already had to fix ("keeps recipient
 *      ADDRESSES out of the logs").
 *   2. CARDINALITY. A path segment is whatever the caller typed, so a raw path in a metric property
 *      is an unbounded set an anonymous caller can inflate at will — see `emitFailClosedRefusal`.
 *
 * ⚠ THE POLARITY IS "KEEP WHAT IS PROVABLY A ROUTE WORD", NOT "REPLACE WHAT LOOKS LIKE AN ID". A
 * denylist of id shapes fails open: a new id format, or an email that happens to match, ends up in
 * the log. So only a lower-case word (letters and hyphens) or a version segment (`v1`) survives, and
 * EVERYTHING else becomes `:id`. A route word this rejects costs an operator a little precision; an
 * id it accepted would cost a caller their privacy.
 *
 * Never throws — it runs on an already-refused request.
 */
const ROUTE_WORD = /^(?:[a-z][a-z-]*|v\d+)$/;

/** Segments beyond this are dropped, so one absurd path cannot bloat every log line. */
const MAX_ROUTE_SEGMENTS = 12;

export function routeTemplate(path: string): string {
  if (!path) return "/";
  const segments = path.split("/").slice(0, MAX_ROUTE_SEGMENTS + 1);
  const normalised = segments.map((segment, i) => {
    // Index 0 is the empty string before the leading slash — preserved so the result starts with "/".
    if (i === 0) return segment;
    if (segment === "") return segment;
    return ROUTE_WORD.test(segment) ? segment : ":id";
  });
  const template = normalised.join("/");
  return path.split("/").length > MAX_ROUTE_SEGMENTS + 1 ? `${template}/…` : template;
}
