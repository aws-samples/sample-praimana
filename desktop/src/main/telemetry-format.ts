// Pure helpers for the opt-in local telemetry log (EA-M6). Kept free of electron
// and fs so the record shape and redaction can be unit-tested.

export interface TelemetryInput {
  source: string; // e.g. "main:uncaughtException", "renderer:error", "renderer:boundary"
  message: string;
  stack?: string;
  extra?: Record<string, unknown>;
}

export interface TelemetryRecord extends TelemetryInput {
  ts: string; // ISO timestamp (caller supplies — Date is injected for testability)
  appVersion?: string;
}

// Absolute paths can carry the user's home dir / usernames. Redact them so a
// shared log doesn't leak the filesystem layout. Matches POSIX (/Users/..,
// /home/..) and Windows (C:\Users\..) home paths.
export function redactPaths(text: string): string {
  if (!text) return text;
  return text
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "/Users/<redacted>")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, "C:\\Users\\<redacted>");
}

/**
 * ── ⚠ AND CREDENTIALS, WHICH PATH REDACTION DOES NOT COVER ────────────────────────────────────
 *
 * Paths were redacted; secrets were not. A crash log is assembled from error messages and stacks, and this
 * app's errors are largely about HTTP requests, so a token reaches the file by ordinary means:
 *
 *     "HTTP 401 for https://api.example/v1/teams?token=eyJhbGciOi…"
 *     "fetch failed: {\"Authorization\":\"Bearer eyJhbGciOi…\"}"
 *
 * And the log's whole purpose is to be SHARED — "a local trail the user can export/share", per this
 * module's own header — so a token in it is a token in a support ticket.
 *
 * ⚠ SHAPE-BASED, NOT NAME-BASED. Matching on a JWT's own structure (three base64url segments after
 * an `eyJ` header) catches one in a message, a stack frame, a URL or a JSON blob, whoever put it
 * there. A list of known field names would only catch the ones we thought of.
 *
 * ⚠ THIS IS DEFENCE IN DEPTH, NOT A LICENCE. It is not a reason to pass a credential into telemetry
 * deliberately: a redactor is a filter over text nobody audited, and the first rule is still that
 * secrets do not go near this file.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return (
    text
      /**
       * A JWT: `eyJ` (base64url for `{"`) then two more dot-separated segments. This app's bearer,
       * ID and refresh tokens are all JWTs, so this is the shape that matters most.
       */
      .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/g, "<redacted-jwt>")
      // `Authorization: Bearer <anything>` even when the credential is not a JWT.
      .replace(/(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>")
      // Credential-ish query parameters, whatever their value looks like.
      .replace(
        /([?&](?:token|access_token|id_token|refresh_token|code|api[_-]?key|password)=)[^&\s"']+/gi,
        "$1<redacted>"
      )
      // A Cognito refresh token is opaque, not a JWT; it appears in JSON bodies.
      .replace(/("(?:refresh_?token|RefreshToken)"\s*:\s*")[^"]+/g, "$1<redacted>")
  );
}

/** Both redactions, in the order every field should get them. */
export function redact(text: string): string {
  return redactSecrets(redactPaths(text));
}

/**
 * ── ⚠ NON-STRING `extra` VALUES BYPASSED EVERY REDACTION ──────────────────────────────────────
 *
 * The comment said "shallow-copy scalar extras only" and the code copied ANY non-string value verbatim —
 * objects and arrays included — which were then `JSON.stringify`'d into the log with no redaction and no
 * length bound. `telemetry.ts` passes `extra` straight from the renderer's `telemetry:report`, so an error
 * payload of
 *
 *     extra: { response: { headers: { Authorization: "Bearer eyJ…" } } }
 *
 * landed unredacted in a file whose stated purpose is to be exported and shared, and which
 * `telemetry:openLog` reveals in Finder for exactly that.
 *
 * ⚠ BOUNDED IN THREE WAYS, because this walks renderer-supplied data: depth, key count per object, and
 * the existing per-string length cap. An unbounded recursion over an attacker-shaped object is its own
 * problem, and the standing constraint in this codebase is that every fan-out is bounded.
 *
 * ⚠ AND IT IS STILL DEFENCE IN DEPTH, not a licence. Passing a credential into telemetry deliberately
 * remains wrong; a redactor is a filter over text nobody audited.
 */
const MAX_EXTRA_DEPTH = 4;
const MAX_EXTRA_KEYS = 32;
/**
 * ── ⚠ A KEY IS RENDERER-SUPPLIED TEXT, EXACTLY LIKE A VALUE ────────────────────────────────────
 *
 * `redactDeep` walked VALUES and copied KEYS verbatim at every depth, so a caller that put a path or a bearer
 * token in the key position — `extra: { "/Users/jane/ projects/acme": 1 }`, or an error object keyed by a JWT
 * — wrote it unredacted into a file whose documented purpose is to be exported and shared with support.
 *
 * ⚠ AND KEYS ARE BOUNDED SEPARATELY FROM VALUES, shorter on purpose. A value can legitimately be a
 * stack fragment or a message; a key is an identifier, and one that needs more than 64 characters is
 * not an identifier.
 */
const MAX_EXTRA_KEY = 64;

/** A key reduced to something safe to write into the log. Same two redactions every field gets. */
function redactKey(key: string): string {
  return redact(String(key)).slice(0, MAX_EXTRA_KEY);
}

function redactDeep(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redact(value).slice(0, 500);
  // Primitives carry no text to redact. `undefined` is dropped by JSON.stringify either way.
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_EXTRA_DEPTH) return "[too deep]";

  if (Array.isArray(value)) {
    return value.slice(0, MAX_EXTRA_KEYS).map((item) => redactDeep(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_EXTRA_KEYS)) {
    out[redactKey(k)] = redactDeep(v, depth + 1);
  }
  return out;
}

const MAX_MESSAGE = 2_000;
const MAX_STACK = 8_000;
/**
 * ⚠ `source` IS BOUNDED SHORTEST OF THE THREE, because it is a LABEL. Every value this app produces
 * is of the form `main:child-process-gone` or `renderer:error` — a component and an event, tens of
 * characters. A cap generous enough for those is still far too small for the JWT or absolute home path
 * the finding is about.
 */
const MAX_SOURCE = 200;

/** Build a single telemetry record, redacting paths and bounding field sizes. */
export function buildRecord(input: TelemetryInput, ts: string, appVersion?: string): TelemetryRecord {
  const rec: TelemetryRecord = {
    ts,
    /**
     * ── ⚠ REDACTED AND CAPPED, LIKE EVERY OTHER FIELD ────────────────────────────────────────
     *
     * This was `source: input.source` — copied verbatim, while the two lines below it applied `redact()` and
     * a length cap, and while `redact`'s own docblock calls itself "Both redactions, in the order every field
     * should get them". `telemetry:report` forwards `payload.source` from the renderer with no type or length
     * check, so this was the one field of three where a home path or a Bearer-shaped string reached the log
     * intact.
     *
     * ⚠ THE CAP IS ALSO A DENIAL-OF-SERVICE BOUND, not only a confidentiality one. Rotation caps the
     * number of LINES (500) and not bytes, and every append re-reads the whole file synchronously on
     * the main process (telemetry.ts) — so an unbounded `source` was an unbounded line, and 500 of
     * them was unbounded main-process CPU and disk. `telemetry_enabled` is renderer-writable, so the
     * same code that writes the record can turn the sink on first.
     *
     * ⚠ REDACTION IS A NO-OP ON EVERY LEGITIMATE VALUE. `main:child-process-gone` contains no path and
     * no secret, so it passes through unchanged; nothing that groups records by source has to change.
     *
     * The `|| "unknown"` mirrors `redactedTarget` in security-audit.ts: a record with an empty source
     * is less useful than one that says it does not know.
     */
    source: redact(String(input.source ?? "")).slice(0, MAX_SOURCE) || "unknown",
    message: redact(String(input.message ?? "")).slice(0, MAX_MESSAGE),
  };
  if (input.stack) rec.stack = redact(String(input.stack)).slice(0, MAX_STACK);
  if (appVersion) rec.appVersion = appVersion;
  if (input.extra && typeof input.extra === "object") {
    const extra: Record<string, unknown> = {};
    /**
     * ⚠ THE TOP LEVEL IS BOUNDED THE SAME WAY EVERY NESTED LEVEL IS. This loop had no
     * `.slice(0, MAX_EXTRA_KEYS)` — compare `redactDeep`, which applies it to both arrays and objects
     * — so the ONE level a caller controls most directly was the only unbounded one. Keys go through
     * `redactKey` here for the same reason they do inside `redactDeep`.
     */
    for (const [k, v] of Object.entries(input.extra).slice(0, MAX_EXTRA_KEYS)) {
      extra[redactKey(k)] = redactDeep(v, 0);
    }
    rec.extra = extra;
  }
  return rec;
}

/**
 * Trim a JSONL log to the most recent `maxLines` entries. Returns the text to
 * write back (or null when no trim is needed). Keeps the log from growing
 * unbounded without a external rotation dependency.
 */
export function trimJsonl(existing: string, maxLines: number): string | null {
  const lines = existing.split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= maxLines) return null;
  return lines.slice(-maxLines).join("\n") + "\n";
}
