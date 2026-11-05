const BACKEND_URL = process.env.BACKEND_URL ?? "";

/**
 * The validated backend origin, for the ONE caller that cannot use `backendFetch`.
 *
 * ⚠ EXPORTED SO THERE IS A SINGLE VALIDATED SOURCE. `/api/desktop/download` needs
 * `redirect: "manual"` and reads the raw `location` header, so it cannot go through `backendFetch`
 * (which parses JSON and follows redirects), and it had its own `process.env.BACKEND_URL` const as a
 * result. That second copy meant this module never loaded on that route, so `validateBackendUrl`
 * below never ran for it: the one place that forwards a user's ID token to an UNVALIDATED origin.
 * Importing this binding makes the module-load assertion run.
 */
export const BACKEND_ORIGIN = BACKEND_URL;

/**
 * ── BACKEND_URL SCHEME VALIDATION ───────────────────────────────────────────────────────────
 *
 * The bearer token (a Cognito ID token) is attached to every outbound request to the backend.
 * Sending it over plaintext HTTP to a non-loopback host would expose the credential on the wire.
 * This mirrors the validation already applied to the desktop deep link's API origin
 * (shared/constants/desktop-link.ts `requireSafeOrigin`).
 *
 * In local development, http://localhost and http://127.0.0.1 are safe (loopback). In deployed
 * environments, BACKEND_URL must be https://.
 *
 * Validated at module load so a misconfigured deploy fails fast at startup rather than silently
 * leaking tokens.
 */
function validateBackendUrl(url: string): void {
  if (url.length === 0) {
    throw new Error(
      "[backend] BACKEND_URL is not set. Set it to the API origin this portal fans /v1/* out to " +
        "(https:// when deployed, or http://localhost:8080 for the local gateway, see .env.example). " +
        "There is deliberately no default: a missing value used to point the BFF at its own loopback."
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `[backend] BACKEND_URL is not a valid URL: "${url}". ` +
        `Set BACKEND_URL to an https:// origin (or http://localhost for local dev).`
    );
  }
  if (parsed.protocol === "https:") return; // Always allowed.
  // Allow plaintext only for loopback addresses (local development).
  const isLoopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol === "http:" && isLoopback) return;
  throw new Error(
    `[backend] BACKEND_URL must use https:// in deployed environments (got "${url}"). ` +
      `Plaintext http:// is only allowed for localhost/127.0.0.1. ` +
      `A bearer token would be exposed in cleartext otherwise.`
  );
}

validateBackendUrl(BACKEND_URL);

/**
 * Error thrown by {@link backendFetch} for any non-2xx backend response.
 * Preserves the HTTP status and (when present) a structured `code` from the
 * backend body so callers can branch on machine-readable values instead of
 * string-matching the human message. tRPC maps these to TRPCError codes in
 * `trpc.ts`; never inspect `.message` text to make control-flow decisions.
 */
export class BackendError extends Error {
  readonly status: number;
  /** Machine-readable code from the backend body, if it provided one. */
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "BackendError";
    this.status = status;
    this.code = code;
  }
}

/**
 * ── PATH SEGMENT ENCODING ───────────────────────────────────────────────────────────────────
 *
 * `encodeURIComponent` is the right tool for embedding a caller-supplied identifier into a URL
 * path segment: it percent-encodes `/`, `?`, `#`, `..`, every character that the WHATWG URL
 * parser would interpret as structure rather than data. Without it an identifier like
 * `../../v1/admin/cost?x=` would collapse the path through `..` resolution and inject query
 * parameters, giving the caller control over which backend route the BFF hits.
 *
 * This helper adds a SECOND check beyond encoding: it rejects values that are empty or that,
 * after encoding, would still be problematic (e.g. a value that is nothing but whitespace). An
 * identifier that fails this check is not a plausible database key and is more likely an
 * injection attempt.
 *
 * ⚠ USE THIS FOR EVERY CALLER-SUPPLIED VALUE SPLICED INTO A PATH. Query-string values should
 * use `URLSearchParams` (which encodes automatically) or `encodeURIComponent` directly.
 */
export function safePathSegment(value: string, label = "identifier"): string {
  if (!value || !value.trim()) {
    throw new BackendError(400, `Invalid ${label}: must not be empty`, "INVALID_PATH_SEGMENT");
  }
  return encodeURIComponent(value);
}

/**
 * ── THE CENTRAL NET: A PATH REACHING `fetch` MUST ALREADY BE NORMALISED ─────────────────────
 *
 * Every call site now encodes its identifiers, and that is the fix. This is the SECOND line,
 * and it exists because the first line is a rule roughly twenty call sites have to remember -
 * the report found this defect precisely because two of them had forgotten while eleven others
 * had not. A future route added without `encodeURIComponent` fails HERE instead of quietly
 * becoming a request to somewhere else.
 *
 * What it refuses, and why each one:
 *
 *   · a path not starting with `/`, would resolve relative to the origin and could change it;
 *   · a leading `//`, protocol-relative, so `//evil.example` is a DIFFERENT HOST entirely;
 *   · any `.` or `..` segment, the WHATWG parser collapses these before the request is made,
 *     which is what turned `teamId = "../../v1/admin/cost?x="` into a read of another route;
 *   · an EMPTY segment (`/v1/teams//tasks`), never a real key, and gateways differ on whether
 *     they collapse it, so the route matched stops being predictable;
 *   · `#` anywhere, a fragment is meaningless to a server and TRUNCATES everything after it,
 *     so its presence means someone is smuggling rather than addressing;
 *   · control characters or whitespace, header/request smuggling shapes, and no legitimate id.
 *
 * ⚠ ONLY THE PATH PORTION IS SEGMENT-CHECKED. A `?` legitimately starts a query built by the
 * caller (with `URLSearchParams`, which encodes), and `..` inside a query VALUE is data, not
 * structure. Checking the whole string would refuse a search term containing "..".
 *
 * Throws `BackendError(400)` rather than returning, so it surfaces through the same mapping as
 * every other refusal instead of becoming an unhandled 500.
 */
export function assertSafeBackendPath(path: string): void {
  const reject = (why: string): never => {
    throw new BackendError(400, `Invalid backend path: ${why}`, "INVALID_BACKEND_PATH");
  };

  if (!path.startsWith("/")) reject("must start with '/'");
  if (path.startsWith("//")) reject("must not be protocol-relative");
  if (path.includes("#")) reject("must not contain a fragment");
  /**
   * ⚠ A BACKSLASH IS A PATH SEPARATOR TO THE WHATWG PARSER. `fetch` treats `\` exactly as `/` in a
   * special-scheme URL, so `/v1/teams/..\..\v1/admin/cost` collapsed to `/v1/admin/cost` while the
   * segment loop below, splitting only on `/`, saw one long innocent-looking segment. Refused
   * outright rather than normalised: nothing in this app addresses a backend path with a backslash.
   */
  if (path.includes("\\")) reject("must not contain a backslash");
  // eslint-disable-next-line no-control-regex -- matching control characters is the point here
  if (/[\s\u0000-\u001f\u007f]/.test(path)) reject("must not contain whitespace or control characters");

  const pathname = path.split(/[?]/, 1)[0];
  // `slice(1)` drops the empty string before the leading `/`; a trailing `/` would leave one at
  // the end, which is also refused, nothing in this app addresses a directory.
  for (const segment of pathname.slice(1).split("/")) {
    if (segment === "") reject("must not contain an empty path segment");
    /**
     * ⚠ PERCENT-ENCODED DOTS COUNT, AND MISSING THEM MADE THIS GUARD ALMOST USELESS. A security
     * scan demonstrated three encodings that passed the literal `.`/`..` test and were then
     * collapsed by the URL parser inside `fetch`, all reaching `/v1/admin/cost`:
     *
     *     /v1/teams/%2e%2e/%2e%2e/v1/admin/cost
     *     /v1/teams/.%2e/.%2e/v1/admin/cost
     *     /v1/teams/..\..\v1/admin/cost          (the backslash case, refused above)
     *
     * The parser decodes `%2e` to `.` BEFORE resolving dot segments, so any mixture of the two
     * spellings is a dot segment. Compared case-insensitively because `%2E` is the same byte.
     *
     * This guard exists as the net under ~20 call sites that each have to remember to encode, a
     * net that catches only the spelling an attacker would not bother with is not a net.
     */
    const decodedish = segment.toLowerCase().replace(/%2e/g, ".");
    if (decodedish === "." || decodedish === "..") {
      reject("must not contain a relative path segment");
    }
  }
}

/**
 * ── EVERY BFF→SERVICE CALL HAS A DEADLINE ───────────────────────────────────────────────
 *
 * ⚠ THIS CALL WAS UNBOUNDED. `fetch` was invoked with no `AbortSignal`, so a hung or throttled
 * service held the Amplify SSR request open indefinitely, for EVERY portal route, not just the
 * one being worked on. `the shared service package's `east-west.ts`` argues this exact case at length
 * for service-to-service calls ("a hung dependency must not hold a Lambda open") and the BFF
 * simply never got the same treatment.
 *
 * The operator-visible symptom is a spinner, then a retry, and a retry on a write path means
 * two batches in flight. That is why this is fixed as a prerequisite for bulk upload rather than
 * alongside it: bulk multiplies one unbounded wait by eighty.
 *
 * ── WHY A PREFIX TABLE RATHER THAN ONE NUMBER ──
 *
 * The backend is not one timeout. The infrastructure CloudFormation template sets three tiers:
 * 15s globally, 30s for `source` and `docs`, and 60s for `ai` (model calls run long). A single
 * default would have to be either 65s, which is no bound at all for CRUD, or short enough to
 * ABORT AI GENERATION MID-STREAM, turning a working feature into a timeout. Neither is
 * acceptable, so the ceiling is derived from the path.
 *
 * Deriving it also means no call site has to remember: adding a route under `/v1/ai` inherits the
 * long deadline automatically, where an opt-in parameter would be forgotten exactly once and the
 * regression would look like a flaky model call.
 *
 * ⚠ EACH VALUE SITS ABOVE ITS FUNCTION'S OWN TIMEOUT, DELIBERATELY. A caller that gives up
 * BEFORE the callee does converts a useful error into an ambiguous one: the work may well have
 * completed. Lambda kills its own invocation, so the honest ceiling is "the callee's timeout plus
 * the hop", and the hop's measured cold cost is 1802ms (`east-west.ts`).
 */
const TIMEOUT_BY_PREFIX: ReadonlyArray<readonly [string, number]> = [
  ["/v1/ai", 65_000], // ai function: Timeout 60
  ["/v1/git", 35_000], // source function: Timeout 30
  ["/v1/docs", 35_000], // docs function: Timeout 30
];

/** Everything else: the 15s Globals timeout plus room for a cold PrivateLink hop. */
const DEFAULT_TIMEOUT_MS = 20_000;

export function backendTimeoutFor(path: string): number {
  for (const [prefix, ms] of TIMEOUT_BY_PREFIX) {
    if (path.startsWith(prefix)) return ms;
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * ── THE ONE `any` AT THIS BOUNDARY, SO THERE NEED BE NONE ABOVE IT ──────────────────────
 *
 * `res.json()` is `Promise<any>`, and because this function returned it unnarrowed, EVERY
 * caller inherited `any`, which is how ~60 `.map((t: any) => …)` annotations accumulated in
 * the routers and the pages. `eslint.config.mjs` downgraded `no-explicit-any` to `warn` for
 * exactly those two globs and recorded the real fix: *"give the API responses declared types
 * and have `backendFetch` return them, at which point these annotations disappear on their
 * own."* The type parameter below is that fix; `backend-types.ts` holds the declarations.
 *
 * ⚠ THE DEFAULT STAYS PERMISSIVE ON PURPOSE. There are 112 call sites and only the ones whose
 * shape is declared in `backend-types.ts` pass an argument; defaulting to `unknown` instead
 * would turn the ~90 undeclared ones into type errors in a single change. So the escape hatch
 * is kept, but it is kept HERE, once, named and explained, rather than restated at each
 * caller. A call with no type argument is a route whose contract nobody has written down yet,
 * and that is now visible at the call site instead of invisible.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the single documented boundary hatch; see above
type UndeclaredResponse = any;

export async function backendFetch<T = UndeclaredResponse>(
  path: string,
  options: RequestInit & { token?: string; timeoutMs?: number } = {}
): Promise<T> {
  const { token, timeoutMs, ...fetchOptions } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {}),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  /**
   * A caller-supplied `signal` is RESPECTED, not replaced, dropping it would silently break
   * cancellation for anything that passes one. `AbortSignal.any` settles on whichever fires
   * first, so an explicit cancel still wins over the deadline.
   */
  const deadline = AbortSignal.timeout(timeoutMs ?? backendTimeoutFor(path));
  const signal = fetchOptions.signal
    ? AbortSignal.any([fetchOptions.signal, deadline])
    : deadline;

  /**
   * ⚠ CHECKED BEFORE THE REQUEST IS BUILT, not after. See `assertSafeBackendPath`: this is the
   * central net under ~20 call sites that each have to remember to encode their identifiers.
   */
  assertSafeBackendPath(path);

  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      ...fetchOptions,
      headers,
      signal,
    });
  } catch (err) {
    /**
     * ⚠ A TIMEOUT BECOMES A `BackendError`, NOT A RAW `AbortError`.
     *
     * Callers and `trpc.ts` branch on `BackendError.status`/`.code`; a bare DOMException would
     * escape that mapping and surface to the user as an unhandled 500 with no indication that
     * the cause was a deadline. 504 is the honest status, this gateway timed out waiting on an
     * upstream, and `BACKEND_TIMEOUT` lets a caller distinguish "took too long" from "refused",
     * which matters because only the former is worth retrying.
     *
     * The distinction from a caller's own cancel is kept: that is not a fault, so it rethrows.
     */
    if (deadline.aborted) {
      throw new BackendError(
        504,
        `The request to ${path} took too long and was cancelled. Try again shortly.`,
        "BACKEND_TIMEOUT"
      );
    }
    throw err;
  }

  if (!res.ok) {
    const text = await res.text();
    let data: { error?: string; code?: string } = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // Non-JSON error body (e.g. an upstream proxy error page), keep the raw
      // text as the message rather than throwing a JSON parse error over it.
      data = { error: text };
    }
    throw new BackendError(
      res.status,
      data.error || `Backend error: ${res.status}`,
      data.code
    );
  }

  /**
   * The ONLY unchecked step in the chain. `T` is a claim about what the service sends, not a
   * verification of it, the routers that care re-normalise (`data.teams || []`, `?? 0`) exactly
   * as they did before, because a declared type cannot stop a service from omitting a key.
   */
  return res.json() as Promise<T>;
}
