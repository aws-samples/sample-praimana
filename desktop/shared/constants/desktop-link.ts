// ── THE DESKTOP CONNECT LINK ────────────────────────────────────────────────────
//
// The portal builds it, the desktop parses it. Shared because a scheme string or a
// parameter name that drifts between the two is a button that silently stops working.
//
//   praimana://connect?p=<portalUrl>&a=<apiBaseUrl>&pool=<poolId>&c=<clientId>
//
// CONFIG ONLY. It tells a fresh install which platform it belongs to; the user then signs in
// with the app's own form (SRP against Cognito).
//
// ⚠ IT USED TO CARRY A ONE-TIME CODE, and that is gone along with everything that redeemed it.
// The portal cannot mint a session for the desktop — measured, not assumed:
// the portal's SRP login leaves no
// Cognito Hosted UI session, and `AdminInitiateAuth` returns `Auth flow not enabled for this
// client` against the live pool. So there is no session to hand over, and no code to carry.
//
// That makes this link SIMPLER AND SAFER than the version it replaces: nothing in it expires,
// nothing is single-use, and nothing in it is a credential.
//
// ── ⚠ WHAT MAY AND MAY NOT GO IN HERE ──
//
// A deep link's payload lands in `process.argv` on Windows and Linux, and ANY unprivileged
// local process can read another process's command line. It also reaches shell history and,
// on Windows, the registry command that launches the app. On this platform participants run
// AI agents that install packages, so treat the contents as readable by hostile local code.
//
//   ALLOWED      the platform's URLs, pool id and app client id. None is secret: the pool and
//                client ids travel in every OAuth redirect, and AWS publishes the pool's
//                endpoints unauthenticated at its `.well-known/openid-configuration`.
//   ⚠ FORBIDDEN  an ID token, a refresh token, a password, or any bearer — permanent and
//                silent if stolen from argv.
//   ⚠ FORBIDDEN  a one-time code. Not because it is unsafe here, but because nothing redeems
//                one any more; re-adding one would mean re-adding a server that can mint
//                sessions, which the gate above showed this pool cannot do.
//
// ── ⚠ AND A LINK MUST NEVER AUTO-APPLY ──
//
// Any web page can trigger a custom-scheme navigation, so a hostile page can send a link
// naming the REAL portal alongside ITS OWN `a=` origin — after which the desktop would send
// every request, bearing the user's token, to that attacker. Config-only does not fix this:
// the API origin IS the dangerous field, whatever else the link carries.
//
// The desktop therefore shows the API origin and waits for a click before committing. See
// the desktop's deep-link handler in src/main.

/** The scheme the portal's link uses and the desktop registers with the OS. */
export const DEEP_LINK_SCHEME = "praimana";

/** The only action this scheme supports. An unknown host is ignored, never guessed at. */
export const DEEP_LINK_HOST = "connect";

/**
 * Cap on any single parameter, enforced on BOTH sides.
 *
 * The values come from outside the app and are forwarded to a renderer that displays them, so
 * an unbounded string is a memory and layout problem any local process could hand us.
 */
const MAX_PARAM_LENGTH = 512;

/**
 * Cap on a hostname inside `p`/`a`, at the DNS limit.
 *
 * ⚠ `MAX_PARAM_LENGTH` ALONE IS NOT ENOUGH FOR THE ORIGINS, because what the panel has to be
 * read against is the RIGHTMOST labels — the registrable domain — and those are what wrap out
 * of view first. 512 characters of `aaaa…` still pushes `.attacker.example` down a `break-all`
 * mono block in a narrow card. `new URL` enforces no length at all here: it accepts a hostname
 * of any size, so the DNS limit has to be applied deliberately.
 */
const MAX_HOSTNAME_LENGTH = 253;

/** What the desktop extracts from a link. All four are configuration, none is a credential. */
export interface DesktopConnectLink {
  /** The portal, shown for confirmation and linked to for password resets. */
  portalUrl: string;
  /** The API origin, for `/v1/*`. */
  apiBaseUrl: string;
  /** Cognito user pool. The desktop reads its real endpoints from AWS discovery. */
  poolId: string;
  /** Cognito app client. Public by OAuth design. */
  clientId: string;
}

/** Raised for every rejection, with a message written for the person who clicked. */
export class DesktopLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopLinkError";
  }
}

/** Strip trailing slashes so `${origin}/v1/...` never yields a double slash. */
function normaliseOrigin(raw: string): string {
  return (raw ?? "").trim().replace(/\/+$/, "");
}

/** True for the loopback names, which are exempt from the HTTPS requirement. */
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * Validate a URL that the desktop will send a BEARER TOKEN to.
 *
 * HTTPS is required for anything but loopback: the API origin carries the session token on
 * every request, so plaintext would put it on the wire in clear. Reduced to an origin
 * because it is used as `${apiBaseUrl}/v1/...`, where a path would silently produce the
 * wrong URL for every call.
 *
 * ⚠ AND BOUNDED, FOR THE SAME REASON `pool`/`c` ARE. These two are the values the confirmation
 * panel exists to display, so they are the ones an unbounded string hurts most — the cap's own
 * docstring says "forwarded to a renderer that displays them" and then did not apply to them.
 * Reducing to `${protocol}//${host}` already discards a padded path or query, so the hostname
 * is the only part left that can push the meaningful labels out of view; both are capped.
 */
function requireSafeOrigin(raw: string, label: string): string {
  const normalised = normaliseOrigin(raw);
  if (!normalised) throw new DesktopLinkError(`The link is missing the ${label}.`);
  if (normalised.length > MAX_PARAM_LENGTH) {
    throw new DesktopLinkError(`The link's ${label} is implausibly long.`);
  }

  let url: URL;
  try {
    url = new URL(normalised);
  } catch {
    throw new DesktopLinkError(`The link's ${label} is not a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DesktopLinkError(`The link's ${label} must be an http(s) URL.`);
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new DesktopLinkError(`The link's ${label} must use https://`);
  }
  if (url.username || url.password) {
    throw new DesktopLinkError(`Remove the username/password from the link's ${label}.`);
  }
  if (url.hostname.length > MAX_HOSTNAME_LENGTH) {
    throw new DesktopLinkError(`The link's ${label} has an implausibly long hostname.`);
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Build the link the portal renders behind "Open desktop app".
 *
 * Validates on the way OUT as well as in: a portal that renders a malformed link produces a
 * support conversation in which the user is blamed for a click that was broken already.
 */
export function buildDesktopConnectLink(params: DesktopConnectLink): string {
  const poolId = (params.poolId ?? "").trim();
  const clientId = (params.clientId ?? "").trim();
  if (!poolId) throw new DesktopLinkError("The link is missing the Cognito pool id.");
  if (!clientId) throw new DesktopLinkError("The link is missing the Cognito client id.");
  if (poolId.length > MAX_PARAM_LENGTH || clientId.length > MAX_PARAM_LENGTH) {
    throw new DesktopLinkError("A value in the link is implausibly long.");
  }

  const query = new URLSearchParams({
    p: requireSafeOrigin(params.portalUrl, "portal address"),
    a: requireSafeOrigin(params.apiBaseUrl, "API address"),
    pool: poolId,
    c: clientId,
  });
  return `${DEEP_LINK_SCHEME}://${DEEP_LINK_HOST}?${query.toString()}`;
}

/**
 * Parse a link delivered by the OS.
 *
 * ⚠ THROWS `DesktopLinkError`, NEVER anything else. Callers on the `open-url` and argv paths
 * run before a window exists, where an unexpected exception is a crash with no UI to report
 * it — triggerable by any local process sending a malformed URL. Those callers catch this
 * type and ignore the link.
 */
export function parseDesktopConnectLink(rawUrl: string): DesktopConnectLink {
  // Collapse whitespace: a link pasted from a chat client or an email can arrive wrapped.
  const trimmed = (rawUrl ?? "").trim().replace(/\s+/g, "");
  if (!trimmed) throw new DesktopLinkError("No link was provided.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DesktopLinkError("That is not a valid connect link.");
  }

  // Scheme AND host: `praimana://something-else` is not this link, and adding an action later
  // must not be simulatable against an older build.
  if (url.protocol !== `${DEEP_LINK_SCHEME}:` || url.hostname !== DEEP_LINK_HOST) {
    throw new DesktopLinkError("That is not a connect link for this app.");
  }

  const poolId = (url.searchParams.get("pool") ?? "").trim();
  const clientId = (url.searchParams.get("c") ?? "").trim();

  // All four or nothing: a partial link would half-configure the app, which then fails at
  // sign-in with nothing pointing back to the link that caused it.
  if (!poolId) throw new DesktopLinkError("The link is missing the Cognito pool id.");
  if (!clientId) throw new DesktopLinkError("The link is missing the Cognito client id.");
  if (poolId.length > MAX_PARAM_LENGTH || clientId.length > MAX_PARAM_LENGTH) {
    throw new DesktopLinkError("A value in the link is implausibly long.");
  }

  return {
    portalUrl: requireSafeOrigin(url.searchParams.get("p") ?? "", "portal address"),
    apiBaseUrl: requireSafeOrigin(url.searchParams.get("a") ?? "", "API address"),
    poolId,
    clientId,
  };
}

/** True if `raw` looks like this app's connect link. Shallow, for cheap dispatch. */
export function looksLikeDesktopConnectLink(raw: string): boolean {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .startsWith(`${DEEP_LINK_SCHEME}://${DEEP_LINK_HOST}`);
}
