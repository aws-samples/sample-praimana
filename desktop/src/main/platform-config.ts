// ── THE CONFIGURED PLATFORM ────────────────────────────────────────────────────
//
// Which platform this install belongs to: the API origin for `/v1/*`, and the Cognito pool's
// real OAuth endpoints for renewing a session.
//
// ── WHERE IT COMES FROM ──
//
// Not from the user, and not from a build-time constant. The pool id and client id arrive in
// the portal's connect link (`@praimana/shared` → `desktop-link`), and the ENDPOINTS come
// from AWS's own OIDC discovery document for that pool:
//
//   https://cognito-idp.<region>.amazonaws.com/<poolId>/.well-known/openid-configuration
//
// ── WHY NOTHING IS HARDCODED ──
//
// The desktop is ONE BINARY shipped to MANY CUSTOMERS, each with its own portal domain and
// Cognito pool, so no customer-specific value may be compiled in. That rules out the VS Code
// model, which bakes in client ids and IdP URLs and only gets away with it because it talks to
// one GitHub.
//
// Two earlier revisions are worth knowing about, because both were withdrawn for reasons that
// still constrain this file:
//
//   1. A public `GET <portal>/api/desktop/config`. Worked, but required every customer domain
//      to expose an unauthenticated endpoint — letting anyone confirm "this is an AI
//      Accelerator deployment, here is its tenant pool". An enumeration surface; ruled out.
//   2. An AES-encrypted "Access Key" the participant pasted. Removed the endpoint, but made a
//      participant carry a credential-shaped string, and the sealing key had to ship in the
//      binary so it was never secret from anyone holding the app.
//   3. A one-time code redeemed for a session. Impossible, not merely rejected: the portal
//      cannot mint a token for another client — `AdminInitiateAuth` is refused by this pool and
//      its SRP login leaves no Hosted UI session.
//
// The connect link has none of those problems: it is issued behind the portal's login, carries
// no credential, and nothing in it expires. Sign-in is the app's own SRP form.
//
// ── WHY THE LOGIN ENDPOINT COMES FROM AWS ──
//
// ⚠ THIS REPLACES THE OLD BUILD-TIME ORIGIN PIN, and is stronger than what it replaced.
// A known concern was that a caller-supplied URL chooses the identity provider — a
// hostile value could choose where a password is typed. Here the login endpoint is supplied by
// nobody: it is read from AWS's own document for the pool. A hostile value can name a
// different POOL; it cannot produce a login page that is not AWS's.
//
// Three supporting invariants, because the above is only true if they hold:
//
//   1. The pool id is validated BEFORE it is interpolated into that URL (`oidcDiscoveryUrl` in
//      @praimana/shared). Unvalidated, a pool id containing path traversal or a host
//      would move discovery — and the login page with it.
//   2. The document's `issuer` must name the pool we asked about — see `validateDiscovery`.
//      This is what ties the response to the request.
//   3. `assertAwsDiscoveryHost` re-checks the returned endpoints are AWS hosts.
//
// The loopback redirect URI stays pinned in `cognito-oauth.ts`. Nothing discovered here can
// move where an authorization code comes back to.
//
// ⚠ IF SIGN-IN EVER MOVES IN-APP, REVISIT THIS. `cognito-oauth.ts` still calls
// `shell.openExternal`, so a user sees the domain in a real address bar — the condition
// that makes a configurable provider survivable. A native form has none.
//
// ── WHY A CHANGE FORCES A SIGN-OUT ──
//
// The stored session is a Cognito ID token from ONE pool. Point the app at a different
// platform and every credential on disk is an artefact of a pool that no longer applies. So a
// fingerprint change tears the session down.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { oidcDiscoveryUrl, regionFromPoolId, isValidPoolId } from "@praimana/shared";
import { readSetting, writeSetting, getDb } from "./database";
import { debugLog } from "./debug-log";

/**
 * The three values the desktop cannot derive on its own.
 *
 * They arrive in the CLAIM RESPONSE — an authenticated exchange with `user-access` — alongside
 * the session token itself.
 *
 * ⚠ NO LONGER CARRIED BY A USER. An earlier revision had participants paste these in an
 * encrypted "Access Key". That path is deleted: the config now comes from a response the
 * desktop already had to make, so there is nothing to transcribe, nothing to keep in step by
 * hand, and nothing on screen that reveals a customer's pool to a passer-by.
 */
export interface DesktopPlatformParams {
  poolId: string;
  clientId: string;
  apiBaseUrl: string;
}

/** How long AWS discovery may take before it is treated as unreachable. */
const DISCOVERY_TIMEOUT_MS = 6000;

/**
 * Cap on the discovery response body. AWS is not going to stream forever, but this
 * path is reachable with a pasted pool id, so the read is bounded on principle rather
 * than on trust.
 */
const MAX_DISCOVERY_BYTES = 64 * 1024;

/** The scopes the app client is built for. */
const DEFAULT_SCOPES = ["openid", "email", "profile"];

export interface PlatformCognitoConfig {
  issuer: string;
  clientId: string;
  /** From AWS discovery — where the browser is sent to sign in. */
  authorizationEndpoint: string;
  /** From AWS discovery — where the code is exchanged for tokens. */
  tokenEndpoint: string;
  scopes: string[];
}

export interface PlatformConfig {
  poolId: string;
  region: string;
  apiBaseUrl: string;
  cognito: PlatformCognitoConfig;
  /** SHA-256 over the identity-bearing fields. A change means "different platform". */
  fingerprint: string;
}

/** Setting keys this module owns. Grouped so the reset paths cannot miss one. */
export const PLATFORM_SETTING_KEYS = {
  poolId: "cognito_pool_id",
  apiBaseUrl: "server_url",
  issuer: "cognito_issuer",
  clientId: "cognito_client_id",
  authorizationEndpoint: "cognito_authorization_endpoint",
  tokenEndpoint: "cognito_token_endpoint",
  scopes: "cognito_scopes",
  fingerprint: "platform_config_fingerprint",
} as const;

/** Raised for every rejection, so callers can show the reason verbatim to the user. */
export class PlatformConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformConfigError";
  }
}

/** Strip trailing slashes so `${origin}/v1/...` never yields a double slash. */
function normalise(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * An endpoint AWS is allowed to have handed us.
 *
 * Cognito serves OAuth endpoints from the Hosted UI domain
 * (`<prefix>.auth.<region>.amazoncognito.com`), and discovery itself from
 * `cognito-idp.<region>.amazonaws.com`. Anchored at BOTH ends:
 * `evil-amazoncognito.com` and `...amazoncognito.com.evil.test` must both fail, which
 * a bare `endsWith` would allow.
 */
function isAwsAuthHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    /^[a-z0-9][a-z0-9-]*\.auth\.[a-z0-9-]+\.amazoncognito\.com$/.test(h) ||
    /^cognito-idp\.[a-z0-9-]+\.amazonaws\.com$/.test(h)
  );
}

/**
 * Assert an endpoint from the discovery document is HTTPS and AWS-hosted.
 *
 * Belt and braces: the document came from an AWS host over TLS, so a bad value would
 * mean AWS served one. Checked anyway because `authorizationEndpoint` is where a
 * PERSON types a password, and the check costs one regex.
 */
export function assertAwsDiscoveryHost(endpoint: string, label: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PlatformConfigError(`Cognito returned an invalid ${label}.`);
  }
  if (url.protocol !== "https:") {
    throw new PlatformConfigError(`Cognito's ${label} must use https://`);
  }
  if (!isAwsAuthHost(url.hostname)) {
    throw new PlatformConfigError(
      `Refusing to use "${url.hostname}" as the ${label} — it is not an AWS Cognito host.`
    );
  }
}

/**
 * The identity of a platform, as one comparable string.
 *
 * Over the five fields whose change means "different platform, your session is void".
 * Host-shaped fields are case- and trailing-slash-normalised so cosmetic differences
 * do not read as a pool rotation and sign everyone out on the next poll.
 *
 * ── ⚠ `apiBaseUrl` STAYS IN, EVEN WHEN THE COGNITO POOL IS SHARED. ──
 *
 * Two experiences may share `poolId`, `issuer` and `clientId` and differ only in which API they point at.
 * Their fingerprints still differ (probed), so `checkPlatformDrift` voids the session on a move between them,
 * and it can look as though this function is asking the wrong question.
 *
 * ⚠ IT IS NOT. The question is not "is this the same identity?" but "should this app keep sending its bearer
 * token to this server?" — and a changed `apiBaseUrl` means the token now goes to a different host.
 *
 * ⚠ A SHARED POOL MAKES THAT MORE SENSITIVE, NOT LESS. Because the pool is the same, a token minted for one
 * experience is genuinely VALID at the other's API. So anyone able to alter `apiBaseUrl` could obtain a
 * working token with no user action at all. Voiding the session is what forces one explicit
 * re-authentication before a bearer reaches a new host.
 *
 * Removing `apiBaseUrl` here is a one-line change and was considered and REJECTED. The
 * accepted cost is one interactive sign-in per profile — profiles hold one experience each, so a pinned
 * profile's fingerprint never changes and this never fires for it.
 */
export function configFingerprint(input: {
  poolId: string;
  apiBaseUrl: string;
  issuer: string;
  clientId: string;
  authorizationEndpoint: string;
}): string {
  const canonical = (value: string) => {
    const n = normalise(value);
    try {
      const url = new URL(n);
      return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      return n;
    }
  };

  const material = [
    // NOT lower-cased: a pool id's suffix is case-sensitive.
    input.poolId.trim(),
    canonical(input.apiBaseUrl),
    canonical(input.issuer),
    // NOT lower-cased either: Cognito app client ids are case-sensitive, so folding
    // would make two genuinely different clients look like the same platform.
    input.clientId.trim(),
    canonical(input.authorizationEndpoint),
  ].join("|");

  return crypto.createHash("sha256").update(material).digest("hex");
}

/** The subset of AWS's OIDC discovery document this app uses. */
interface DiscoveryDocument {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  scopes_supported?: unknown;
}

/**
 * Validate a discovery document against the pool it was fetched for.
 *
 * Separate from the fetch so the whole policy is unit-testable without a network.
 */
export function validateDiscovery(params: DesktopPlatformParams, raw: unknown): PlatformConfig {
  if (!raw || typeof raw !== "object") {
    throw new PlatformConfigError("Cognito returned an unexpected discovery response.");
  }
  const doc = raw as DiscoveryDocument;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

  const issuer = normalise(str(doc.issuer));
  const authorizationEndpoint = normalise(str(doc.authorization_endpoint));
  const tokenEndpoint = normalise(str(doc.token_endpoint));

  if (!issuer || !authorizationEndpoint || !tokenEndpoint) {
    throw new PlatformConfigError(
      "Cognito's discovery document is missing the sign-in endpoints for this pool."
    );
  }

  /**
   * ⚠ THE ISSUER MUST NAME THE POOL WE ASKED ABOUT.
   *
   * This ties the document to the connect string. Without it, a redirect or a stale
   * response for some other pool would be accepted, and the app would authenticate
   * against a pool the string never named.
   */
  const expectedIssuer = `https://cognito-idp.${regionFromPoolId(params.poolId)}.amazonaws.com/${params.poolId}`;
  if (issuer !== expectedIssuer) {
    throw new PlatformConfigError(
      "Cognito's discovery document does not match the pool in the connect string."
    );
  }

  assertAwsDiscoveryHost(authorizationEndpoint, "sign-in endpoint");
  assertAwsDiscoveryHost(tokenEndpoint, "token endpoint");

  /**
   * Scopes are INTERSECTED with what the pool says it supports, falling back to the
   * standard three. Requesting a scope the pool does not support makes Cognito reject
   * the authorize request outright, which presents as "sign-in is broken".
   */
  const supported = Array.isArray(doc.scopes_supported)
    ? doc.scopes_supported.filter((s): s is string => typeof s === "string")
    : [];
  const scopes = supported.length ? DEFAULT_SCOPES.filter((s) => supported.includes(s)) : [];

  return {
    poolId: params.poolId,
    region: regionFromPoolId(params.poolId),
    apiBaseUrl: params.apiBaseUrl,
    cognito: {
      issuer,
      clientId: params.clientId,
      authorizationEndpoint,
      tokenEndpoint,
      scopes: scopes.length ? scopes : [...DEFAULT_SCOPES],
    },
    fingerprint: configFingerprint({
      poolId: params.poolId,
      apiBaseUrl: params.apiBaseUrl,
      issuer,
      clientId: params.clientId,
      authorizationEndpoint,
    }),
  };
}

/**
 * Resolve the pool config from a claim response into a full platform config, via AWS
 * discovery.
 *
 * Throws `PlatformConfigError`, whose messages are written for the user — the sign-in screen
 * is one place where an error with no next step leaves someone stuck.
 */
export async function resolvePlatform(params: DesktopPlatformParams): Promise<PlatformConfig> {
  // Validates the pool id BEFORE it can reach a URL — see the module header, invariant 1.
  const discoveryUrl = oidcDiscoveryUrl(params.poolId);

  let res: Response;
  try {
    res = await fetch(discoveryUrl, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      headers: { Accept: "application/json" },
      // A cached document from a previous pool would be worse than a slow fetch.
      cache: "no-store",
    });
  } catch (err) {
    const timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new PlatformConfigError(
      timedOut
        ? "Timed out reaching AWS Cognito. Check your connection and try again."
        : "Could not reach AWS Cognito. Check your connection and try again."
    );
  }

  if (res.status === 404) {
    // The realistic bad-paste case: a well-formed pool id that does not exist.
    throw new PlatformConfigError(
      `Cognito does not recognise the user pool "${params.poolId}". Check the connect string with your facilitator.`
    );
  }
  if (!res.ok) {
    throw new PlatformConfigError(`AWS Cognito responded with HTTP ${res.status}.`);
  }

  const text = await readBounded(res);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PlatformConfigError("AWS Cognito returned an unreadable discovery document.");
  }

  return validateDiscovery(params, parsed);
}

/**
 * Read a response body, refusing anything over {@link MAX_DISCOVERY_BYTES}.
 *
 * Streams so the cap is enforced BEFORE the bytes are held, rather than measuring a
 * string already in memory.
 */
async function readBounded(res: Response): Promise<string> {
  const body = res.body;
  if (!body) {
    const text = await res.text();
    if (text.length > MAX_DISCOVERY_BYTES) {
      throw new PlatformConfigError("Cognito returned an unexpectedly large response.");
    }
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_DISCOVERY_BYTES) {
        throw new PlatformConfigError("Cognito returned an unexpectedly large response.");
      }
      chunks.push(value);
    }
  } finally {
    // Release even on the size-cap throw, so a bad response cannot leave an open
    // connection per attempt.
    reader.releaseLock();
    void body.cancel().catch(() => {});
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/** The persisted config, or null when this install has never been configured. */
export function readPlatformConfig(): PlatformConfig | null {
  const poolId = readSetting(PLATFORM_SETTING_KEYS.poolId) || "";
  const apiBaseUrl = readSetting(PLATFORM_SETTING_KEYS.apiBaseUrl) || "";
  const issuer = readSetting(PLATFORM_SETTING_KEYS.issuer) || "";
  const clientId = readSetting(PLATFORM_SETTING_KEYS.clientId) || "";
  const authorizationEndpoint = readSetting(PLATFORM_SETTING_KEYS.authorizationEndpoint) || "";
  const tokenEndpoint = readSetting(PLATFORM_SETTING_KEYS.tokenEndpoint) || "";

  // Unconfigured unless EVERY field is present: a half-written config would send the
  // app into sign-in with no pool to sign in against.
  if (!poolId || !apiBaseUrl || !issuer || !clientId || !authorizationEndpoint || !tokenEndpoint) {
    return null;
  }

  const rawScopes = readSetting(PLATFORM_SETTING_KEYS.scopes) || "";
  const scopes = rawScopes.split(/\s+/).filter(Boolean);

  return {
    poolId,
    region: regionFromPoolId(poolId),
    apiBaseUrl,
    cognito: {
      issuer,
      clientId,
      authorizationEndpoint,
      tokenEndpoint,
      scopes: scopes.length ? scopes : [...DEFAULT_SCOPES],
    },
    // Recomputed rather than trusted from disk: the stored fingerprint is what we
    // COMPARE against, so deriving this one from the stored fields is what makes a
    // hand-edited settings row detectable instead of authoritative.
    fingerprint: configFingerprint({ poolId, apiBaseUrl, issuer, clientId, authorizationEndpoint }),
  };
}

/** True when this install has a complete platform config. */
export function isPlatformConfigured(): boolean {
  return readPlatformConfig() != null;
}

/**
 * Forget the platform entirely — the "sign in to another experience" reset.
 *
 * ⚠ CLEARS THE FINGERPRINT TOO. Leaving it behind would make the next `checkPlatformDrift`
 * compare a recorded fingerprint against an absent config; that returns early today, but it is
 * a contradictory state to leave on disk and the next reader of these rows should not have to
 * reason about it.
 *
 * One transaction, so a crash mid-reset cannot leave a half-configured install — the state
 * `readPlatformConfig` treats as unconfigured anyway, but arrived at by accident rather than
 * by intent.
 */
export function clearPlatformConfig(): void {
  const db = getDb();
  db.transaction(() => {
    for (const key of Object.values(PLATFORM_SETTING_KEYS)) writeSetting(key, "");
    writeSetting("portal_url", "");
  })();
}

/** The fingerprint recorded at the last successful save. */
export function storedFingerprint(): string | null {
  return readSetting(PLATFORM_SETTING_KEYS.fingerprint) || null;
}

/**
 * Persist a resolved config.
 *
 * ONE TRANSACTION, because a partial write is the state `readPlatformConfig` treats as
 * unconfigured — and a crash between two of eight `writeSetting` calls would produce
 * exactly that, silently, on an app that was working a moment ago.
 *
 * Returns whether this REPLACED a different platform. It does not tear the session
 * down itself: the session lives in handlers/ai.ts (cached bearer, event stream), and
 * one owner of that teardown is what keeps it correct.
 */
export function savePlatformConfig(config: PlatformConfig): {
  changed: boolean;
  previousFingerprint: string | null;
} {
  const previousFingerprint = storedFingerprint();
  const changed = previousFingerprint != null && previousFingerprint !== config.fingerprint;

  getDb().transaction(() => {
    writeSetting(PLATFORM_SETTING_KEYS.poolId, config.poolId);
    writeSetting(PLATFORM_SETTING_KEYS.apiBaseUrl, config.apiBaseUrl);
    writeSetting(PLATFORM_SETTING_KEYS.issuer, config.cognito.issuer);
    writeSetting(PLATFORM_SETTING_KEYS.clientId, config.cognito.clientId);
    writeSetting(PLATFORM_SETTING_KEYS.authorizationEndpoint, config.cognito.authorizationEndpoint);
    writeSetting(PLATFORM_SETTING_KEYS.tokenEndpoint, config.cognito.tokenEndpoint);
    writeSetting(PLATFORM_SETTING_KEYS.scopes, config.cognito.scopes.join(" "));
    writeSetting(PLATFORM_SETTING_KEYS.fingerprint, config.fingerprint);
  })();

  return { changed, previousFingerprint };
}


// ── ⚠ A NEW PROFILE INHERITS THE EXPERIENCE, NOT THE SESSION ──────────────────────────────
//
// The cause: a new profile is a new `userData`, so its settings table is empty, so `isPlatformConfigured()` is
// false, so `App` renders `PlatformSetupView` — the browser-connect screen. Correct for a brand-new install
// that genuinely does not know which deployment it belongs to; wrong for a profile created BY a window that
// already knows.
//
// ⚠ WHAT TRAVELS IS CONFIGURATION, NOT A CREDENTIAL. Pool id, API base URL, issuer, client id and the two
// discovered endpoints — public values that identify a deployment. NO token, no refresh token, nothing
// `safeStorage` protects. The new profile still requires an explicit interactive sign-in, which is the
// accepted cost; this only removes the step where the participant re-answers "which
// platform is this?" for a machine that already answered it.
//
// ⚠ AND THAT IS WHY IT IS DEFENSIBLE AGAINST THE RULE IT LOOKS LIKE IT BREAKS. `connectPlatform` is the only
// way to change the platform precisely so that no WEB PAGE can point this app at a hostile API. A seed is not
// a web page: it is written by a window on this machine, from a config a human already confirmed there, into a
// profile that same human just created. The trust decision was made once and is being carried forward, not
// bypassed.
//
// ⚠ A FILE RATHER THAN A DATABASE WRITE, because the new profile has no database yet — it is created by
// `initDatabase` in the process that is about to launch. Writing one from here would mean this process opening
// and migrating another profile's SQLite, which is exactly the two-writers hazard profiles exist to avoid.

const PLATFORM_SEED_FILE = "platform-seed.json";

/**
 * Leave a resolved config for a profile that has not started yet.
 *
 * @param dir The new profile's directory (from `profileDir`).
 *
 * Never throws: failing to seed means the new window shows the connect screen, which is the behaviour that
 * shipped before this existed — a worse first run, not a broken one.
 */
export function writePlatformSeed(dir: string, config: PlatformConfig): void {
  try {
    fs.mkdirSync(dir, { recursive: true });  // nosemgrep: detect-non-literal-fs-filename
    fs.writeFileSync(path.join(dir, PLATFORM_SEED_FILE), JSON.stringify(config, null, 2));  // nosemgrep: detect-non-literal-fs-filename,path-join-resolve-traversal
  } catch {
    /* See above: degrades to the connect screen. */
  }
}

/**
 * Adopt a seed left for THIS profile, if there is one, and delete it.
 *
 * ⚠ CONSUMED, NOT MERELY READ. A seed that survived would re-apply on every launch, so a participant who
 * deliberately pointed this profile at a different experience would find it silently reverted — the file
 * would become a permanent override rather than a starting point.
 *
 * ⚠ AND IT IS IGNORED WHEN THE PROFILE IS ALREADY CONFIGURED. Same reason: whatever is in the database now is
 * a later decision than whatever was seeded at creation.
 *
 * @param dir This profile's directory.
 * @returns true when a config was adopted, so the caller can skip the connect screen.
 */
export function consumePlatformSeed(dir: string): boolean {
  const file = path.join(dir, PLATFORM_SEED_FILE);  // nosemgrep: path-join-resolve-traversal
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");  // nosemgrep: detect-non-literal-fs-filename
  } catch {
    return false; // No seed. The ordinary case for every profile after its first launch.
  }

  /* Removed FIRST, so a malformed or rejected seed cannot be retried on every launch. */
  try {
    fs.unlinkSync(file);  // nosemgrep: detect-non-literal-fs-filename
  } catch {
    /* Best effort; the guards below still stop it being applied twice. */
  }

  if (isPlatformConfigured()) return false;

  try {
    const parsed = JSON.parse(raw) as PlatformConfig;
    /**
     * ⚠ VALIDATED, NOT TRUSTED, even though this app wrote it. The file sits in the user's own directory and
     * can be edited; `savePlatformConfig` would otherwise persist whatever host it named, which is the one
     * thing the connect flow exists to prevent. `assertPlatformConfig` applies the same host rules the deep
     * link is held to.
     */
    assertSeededConfig(parsed);
    /**
     * ── ⚠ THE FINGERPRINT IS RECOMPUTED, NEVER TAKEN FROM THE FILE ───────────────────────────
     *
     * This used to persist `parsed` whole, including the `fingerprint` field the seed itself supplied — so
     * `checkPlatformDrift` (handlers/platform.ts) compared the seed's value against the seed's value and
     * reported no drift. A hostile seed therefore SUPPRESSED THE DETECTOR that exists to notice exactly it.
     *
     * A fingerprint is a statement ABOUT the other fields, so it is derived from them here rather
     * than believed. Recomputing after `assertSeededConfig` also means the value can only ever
     * describe fields that passed validation.
     */
    savePlatformConfig({
      ...parsed,
      fingerprint: configFingerprint({
        poolId: parsed.poolId,
        apiBaseUrl: parsed.apiBaseUrl,
        issuer: parsed.cognito.issuer,
        clientId: parsed.cognito.clientId,
        authorizationEndpoint: parsed.cognito.authorizationEndpoint,
      }),
    });
    return true;
  } catch (err) {
    debugLog("[platform] ignoring an unusable profile seed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Is this a URL this app may send a bearer token to?
 *
 * ⚠ EXPORTED SO THERE IS ONE DEFINITION. The rule ("https, or loopback for local development")
 * belongs in one place — a second copy is how one of them ends up permitting something the other
 * refuses, and the refusing one is never the one on the path that matters.
 *
 * @throws PlatformConfigError
 */
export function assertSafeApiOrigin(raw: string, label = "API origin"): void {
  let url: URL;
  try {
    url = new URL(normalise(raw));
  } catch {
    throw new PlatformConfigError(`${label} is not a valid URL`);
  }

  /** Loopback only by literal address — a HOSTNAME that merely resolves to 127.0.0.1 is not this. */
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";

  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopback) return;

  throw new PlatformConfigError(
    `${label} must use https:// (http:// is accepted only for localhost during development)`
  );
}

/**
 * The checks a seed must pass before it becomes this profile's platform.
 *
 * Deliberately the same host validation the resolve path applies — a seed is a shortcut past the *dialogue*,
 * never past the rules.
 */
function assertSeededConfig(config: PlatformConfig): void {
  if (!config || typeof config !== "object") throw new PlatformConfigError("seed is not an object");
  for (const [label, value] of [
    ["poolId", config.poolId],
    ["apiBaseUrl", config.apiBaseUrl],
    ["fingerprint", config.fingerprint],
  ] as const) {
    if (typeof value !== "string" || !value.trim()) {
      throw new PlatformConfigError(`seed is missing ${label}`);
    }
  }
  if (!config.cognito || typeof config.cognito !== "object") {
    throw new PlatformConfigError("seed is missing its cognito block");
  }
  /**
   * ── ⚠ THE POOL ID IS VALIDATED, AND THE ISSUER MUST NAME THAT POOL ───────────────────────────
   *
   * `poolId` was only checked for being a non-empty string, and the issuer↔pool tie that `validateDiscovery`
   * applies (":270-290") was not applied here at all. So a seed could persist an ATTACKER'S OWN Cognito user
   * pool — a real pool, on a real AWS host, which is why `assertAwsDiscoveryHost` does not catch it — and
   * that pool id and client id are handed to Amplify in the renderer, where THIS APP'S OWN SRP FORM collects
   * the participant's email, password and TOTP.
   *
   * ⚠ THE HOST CHECKS ALONE CANNOT SEE THIS, and that is the whole point: sign-in against the
   * attacker's pool is *supposed* to succeed. The tie is what makes the pool in the config and the
   * issuer the app trusts one decision rather than two.
   */
  if (!isValidPoolId(config.poolId)) {
    throw new PlatformConfigError("seed has a malformed pool id");
  }
  const expectedIssuer = `https://cognito-idp.${regionFromPoolId(config.poolId)}.amazonaws.com/${config.poolId}`;
  if (normalise(config.cognito.issuer) !== expectedIssuer) {
    throw new PlatformConfigError("seed's issuer does not name its pool");
  }

  /* The same rule the deep link is held to: an auth host must be AWS's, not an attacker's. */
  assertAwsDiscoveryHost(config.cognito.issuer, "issuer");
  assertAwsDiscoveryHost(config.cognito.authorizationEndpoint, "authorization endpoint");
  assertAwsDiscoveryHost(config.cognito.tokenEndpoint, "token endpoint");

  /**
   * ── ⚠ AND THE API ORIGIN, WHICH WAS ONLY CHECKED FOR BEING A NON-EMPTY STRING ────────────────
   *
   * The three Cognito hosts were validated and `apiBaseUrl` was not, which leaves the exact attack this
   * file's own header describes — and it is worse here than on the deep link, because the deep link's
   * protection is the CONFIRMATION SCREEN and a seed exists precisely to skip it:
   *
   *     seed { cognito: <the real pool>, apiBaseUrl: "http://attacker.example" }
   *       → the participant signs in at genuine AWS and gets a genuine token
   *       → every request thereafter sends that bearer to attacker.example
   *
   * The Cognito checks do not help: sign-in is *supposed* to succeed. The reason is plain —
   * "anyone able to alter `apiBaseUrl` could obtain a token" — which is why `apiBaseUrl` is in the
   * fingerprint at all, and validating the other three while trusting this one made the fingerprint
   * the only line of defence.
   *
   * ⚠ https ONLY, WITH ONE EXCEPTION: LOOPBACK. A local dev gateway serves the dev API over
   * `http://localhost`, so refusing plain http outright would break every developer's profile seed.
   * Loopback http is not interceptable off-machine, which is what makes the exception safe rather
   * than merely convenient.
   */
  assertSafeApiOrigin(config.apiBaseUrl);
}
