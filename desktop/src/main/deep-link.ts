// ── THE `praimana://` DEEP LINK ─────────────────────────────────────────────────
//
// So the portal can offer "Open desktop app" and have the user land signed in. The link
// carries a ONE-TIME CODE and the two URLs the desktop will talk to:
//
//   praimana://connect?code=<one-time>&p=<portalUrl>&a=<apiBaseUrl>
//
// ── ⚠ THE ONE RULE: A DEEP LINK NEVER AUTO-APPLIES ──
//
// It hands the key to the SETUP SCREEN and stops. The user still sees where they will
// sign in, and still clicks Connect.
//
// That is not politeness — it is the whole security boundary. ANY web page can trigger
// a custom-scheme navigation, so `attacker.example` can fire a link carrying the real
// pool and client id but ITS OWN API origin:
//
//   praimana://connect?k=<key encoding a=https://attacker.example>
//
// The user would then sign in legitimately at real AWS, receive a real token, and the
// desktop would send that bearer to the attacker's server on every request. Encryption
// does not help: the key that seals these is in the binary, so an attacker can mint one.
// The confirmation step is what closes it — the screen shows the API origin, and a user
// who did not expect `attacker.example` can stop.
//
// ⚠ IF A FUTURE CHANGE MAKES THIS APPLY WITHOUT A CLICK, that vulnerability is live
// again. Do not add an "auto-connect" convenience here.
//
// ── HOW THIS DIFFERS FROM THE REJECTED REDIRECT-TARGET APPROACH ──
//
// A prior review rejected `praimana://` as the OAUTH REDIRECT TARGET, because a squatted custom
// scheme steals the authorization CODE silently, where a squatted loopback port fails
// loudly. That reasoning is sound and unchanged: the OAuth redirect stays on
// `http://localhost:8788/callback`.
//
// This link carries no code, no token, and no credential — only a config blob the user
// must then confirm. A process that squats the scheme learns the customer's pool id and
// API origin, which is the same thing it would learn by reading the Access Key off the
// clipboard. So that finding does not transfer.
//
// ── THE FOUR ELECTRON BUGS THIS FILE EXISTS TO GET RIGHT ──
//
// Each is a known Electron concern, and each is silent if missed:
//
//   1. `open-url` MUST be registered BEFORE `whenReady`, or the URL that launched a
//      cold app is dropped and the user sees a normal empty setup screen.
//   2. Windows/Linux deliver via `process.argv`, NOT `open-url` — on cold start in the
//      first argv, and on warm start via `second-instance`.
//   3. `requestSingleInstanceLock` must exist, or a link opens a SECOND copy of the app
//      with its own SQLite handle on the same file.
//   4. argv is attacker-controlled, so take the FIRST `praimana://` element and ignore
//      the rest — never pass unfiltered argv anywhere, and never let a switch like
//      `--remote-debugging-port` through as if it were a link.

import path from "path";
import { randomUUID } from "crypto";
import { app, BrowserWindow } from "electron";
// RE-EXPORTED, NOT REDEFINED: the portal builds links with this same constant, and two
// copies of a scheme string is how one gets a typo and the button silently stops working.
import {
  DEEP_LINK_SCHEME,
  parseDesktopConnectLink,
  DesktopLinkError,
  type DesktopConnectLink,
} from "@praimana/shared";

export { DEEP_LINK_SCHEME };

/**
 * ── ⚠ A PROPOSAL IS IDENTIFIED AND IT EXPIRES ──────────────────────────────────────────────────
 *
 * The confirmation click is this app's whole security boundary for repointing its identity provider, and it
 * was not bound to what got committed: the display path PEEKED, the commit path took whatever occupied a
 * single mutable slot at that instant, and any web page could overwrite that slot at any time. Two
 * consequences, both closed here:
 *
 *   (a) A SWAP. A hostile page fires a second link after the panel has rendered and before the click
 *       lands, so the origin the participant read is not the origin persisted. The panel does
 *       re-read on `platform:deepLink`, but that is an asynchronous refresh, not a binding.
 *
 *   (b) PERSISTENCE. A proposal planted at any earlier time survived in memory indefinitely and was
 *       re-offered the next time the participant reached the setup screen for their own reasons —
 *       after `platform:reset`, say — with no browser click of theirs behind it.
 *
 * So the slot now carries an opaque `id` the renderer must hand back, and an `offeredAt` it is
 * measured against. `platform:connect` commits the proposal the participant was LOOKING AT or
 * nothing at all.
 *
 * In memory only, never persisted: this is a pending USER INTENT, not configuration.
 */
interface PendingProposal {
  link: DesktopConnectLink;
  /**
   * ⚠ UNGUESSABLE, and that is the point rather than a nicety. It is the renderer's proof that the
   * proposal it is confirming is the one main is holding; a predictable value would let a caller
   * commit a freshly-planted link by naming the id it expected the panel to be showing.
   */
  id: string;
  offeredAt: number;
}

let pending: PendingProposal | null = null;

/**
 * How long a proposal stays committable.
 *
 * Five minutes, matching `LOGIN_TIMEOUT_MS` in cognito-oauth.ts — the same "a person is reading a
 * screen and deciding" budget, and for the same reason: long enough that nobody legitimate is timed
 * out mid-decision, short enough that a link planted an hour ago is not still armed on a screen the
 * participant reached by their own route.
 */
const PROPOSAL_TTL_MS = 5 * 60 * 1000;

/**
 * The live proposal, clearing it if it has aged out.
 *
 * ⚠ EXPIRY IS CHECKED ON READ, not on a timer. A `setTimeout` would have to be cancelled on every
 * overwrite and on quit, and a missed cancellation clears a proposal the user is mid-decision on.
 * Reading is the only moment the answer matters.
 */
function currentProposal(): PendingProposal | null {
  if (!pending) return null;
  if (Date.now() - pending.offeredAt > PROPOSAL_TTL_MS) {
    pending = null;
    return null;
  }
  return pending;
}

/**
 * Parse a connect link, or null if it is not one.
 *
 * ⚠ NULL RATHER THAN A THROW. This runs from `open-url` and from argv parsing at module load —
 * before any window exists, where an exception is a crash with no UI to report it, triggerable
 * by any local process sending a malformed URL. `DesktopLinkError` is caught here and treated
 * as "not for us"; anything else is a genuine bug and is allowed to surface.
 */
export function connectLinkFromUrl(rawUrl: string): DesktopConnectLink | null {
  try {
    return parseDesktopConnectLink(rawUrl);
  } catch (err) {
    if (err instanceof DesktopLinkError) return null;
    throw err;
  }
}

/**
 * The first `praimana://` argument in an argv array, or null.
 *
 * ⚠ FIRST MATCH ONLY, AND NOTHING ELSE FROM ARGV. Windows and Linux deliver the link as a
 * command-line argument, and argv is attacker-controlled — note that
 * `--remote-debugging-port` injection is reachable this way. Scanning for exactly one
 * recognised scheme and ignoring every other element is what keeps a crafted argv from
 * contributing anything but a link we were going to validate anyway.
 */
export function connectLinkFromArgv(argv: readonly string[]): DesktopConnectLink | null {
  for (const arg of argv) {
    if (typeof arg !== "string") continue;
    if (!arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)) continue;
    return connectLinkFromUrl(arg);
  }
  return null;
}

/** Record a link and, if a window is already up, tell it to offer the link. */
function offerConnectLink(link: DesktopConnectLink): void {
  /**
   * ⚠ A NEW LINK STILL REPLACES AN OLD ONE, and that is correct — a participant who clicks the
   * portal button twice, or moves between two experiences, must see the LATEST proposal rather than
   * a stale one. What changed is the consequence of a replacement: because the commit names an id,
   * a click that races an overwrite now finds the proposal it was shown is gone and REFUSES, instead
   * of silently committing whatever arrived last. Refusing and asking them to click again is the
   * behaviour that cannot mis-commit.
   */
  pending = { link, id: randomUUID(), offeredAt: Date.now() };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    // Bring the app forward: the user clicked a button in their browser and expects the
    // desktop to come to them. Without this the app updates behind the browser window
    // and appears to have done nothing.
    if (win.isMinimized()) win.restore();
    win.focus();
    /**
     * ⚠ A WAKE-UP SIGNAL, NOT THE PROPOSAL. The renderer ignores this payload and re-reads
     * through `platform:pendingLink` (see PlatformSetupView's `load()`), which is what keeps ONE
     * shape and one source of truth for the derived fields main alone can compute.
     *
     * So the two origins here are a legacy of the shape this event used to have, not a decision
     * about what the renderer may know. It may know the pool id and client id too, and
     * `platform:pendingLink` returns them: they are the fields that decide which identity
     * provider the app trusts, and a confirmation screen that hides them is confirming nothing.
     * Do not re-derive the panel's contents from this payload — add them to that handler.
     */
    win.webContents.send("platform:deepLink", {
      portalUrl: link.portalUrl,
      apiBaseUrl: link.apiBaseUrl,
    });
  }
}

/**
 * Take the pending connect link, clearing it — but ONLY the one the caller names.
 *
 * ⚠ THE `expectedId` ARGUMENT IS THE BINDING, and it is what makes the confirmation click mean
 * something. Without it this returned whatever occupied the slot at that instant, so the proposal
 * the participant read and the proposal committed were only incidentally the same one. A mismatch
 * means the slot changed under the panel (or the proposal aged out); the honest response is to
 * commit NOTHING and let the user click again, which is what returning null produces.
 *
 * Consumed rather than read, so a committed link cannot be re-applied on a later mount.
 */
export function takePendingConnectLink(expectedId: string): DesktopConnectLink | null {
  const proposal = currentProposal();
  if (!proposal) return null;
  if (!expectedId || proposal.id !== expectedId) return null;
  pending = null;
  return proposal.link;
}

/**
 * Read the pending proposal WITHOUT consuming it, with the id needed to commit it.
 *
 * For the confirmation screen, which must describe the proposal before the user decides — and must
 * be able to say WHICH proposal it described when the click arrives.
 */
export function peekPendingConnectLink(): { link: DesktopConnectLink; id: string } | null {
  const proposal = currentProposal();
  return proposal ? { link: proposal.link, id: proposal.id } : null;
}

/**
 * Whether a connect link is waiting, WITHOUT consuming it.
 *
 * For the startup gate, which needs to know whether to route to the connect screen before any
 * renderer has asked for the link itself. Expired proposals do not count as waiting.
 */
export function hasPendingConnectLink(): boolean {
  return currentProposal() != null;
}

/**
 * Register the scheme and the OS delivery paths.
 *
 * ⚠ CALL THIS BEFORE `app.whenReady()`. macOS fires `open-url` early enough that a
 * listener attached after `whenReady` misses the URL that launched the app — bug (1)
 * above, and the one that presents as "the button does nothing the first time".
 *
 * Returns false when another instance already holds the lock, in which case the caller
 * must quit immediately: the running instance has been handed the link.
 */
export function initDeepLinks(): boolean {
  /**
   * ⚠ SINGLE INSTANCE, and it must come first. Without the lock, clicking the link while
   * the app is running starts a SECOND process that opens the same SQLite file with its
   * own connection — two writers, one database, and the "app" the user is looking at is
   * not the one holding their session.
   *
   * ⚠ THE LOCK IS NOW PER PROFILE, and this call did not change to make that true — `profile.ts` redirects
   * `userData` before `index.ts` reaches this function, and Chromium keys the singleton on the user-data
   * directory. So the guarantee is unchanged in the case it was written for (two copies of one profile still
   * cannot start) and no longer prevents what it never needed to (two DIFFERENT profiles, which share no
   * database).
   *
   * ── ⚠ THE LIMITATION THAT MATTERS, AND WHAT IS ACTUALLY KNOWN ABOUT IT ──────────────────
   *
   * ⚠ THE PREMISE IS RIGHT, AND PROFILES ARE MOST OF THE ANSWER. The "experience" IS the platform config —
   * `server_url`, `cognito_pool_id`, the issuer and client id — and every one of those is stored with
   * `writeSetting`, i.e. in the PER-PROFILE database (see platform-config.ts, PLATFORM_SETTING_KEYS). So two
   * profiles genuinely hold two experiences and can run side by side; one experience per install was a
   * consequence of one database per install, and that is what profiles removed.
   *
   * ⚠ WHAT REMAINS IS DELIVERY, NOT STORAGE. The `praimana://` URL carries a one-time code and the two URLs,
   * and it names no profile — there is nowhere in it to say which one should receive the experience. So the
   * link is redeemed by whichever instance the OS hands it to.
   *
   * ⚠ AND WHICH INSTANCE THAT IS, I HAVE NOT MEASURED. An earlier version of this note asserted it reaches
   * "whichever instance holds the DEFAULT profile's lock". That was an inference from how the lock works, not
   * an observation, and it is corrected here rather than left to be trusted: macOS registers the scheme
   * against the app BUNDLE and delivers `open-url` to a running instance of it, but neither Electron's nor
   * Apple's documentation says which instance wins when several are running, and the dev build registers
   * `process.execPath` rather than a bundle, so a dev experiment would not answer it for a packaged app
   * either.
   *
   * ⚠ THE ROUTE THAT DOES NOT DEPEND ON ANY OF THIS: a profile can be connected from inside itself. The
   * window already has "Sign in to another experience" (`platform:reset`), so the working sequence today is
   * open the profile, then connect it. The deep link is a convenience on top of that, not the only way in.
   *
   * Encoding a profile in the URL is the obvious fix and is deliberately NOT built here, because the honest
   * version is not a one-liner: the code is a single-use 60-second credential, so handing it to another
   * process must not put it in argv (visible in `ps`) or in a file. Worth designing properly if the
   * connect-from-inside route proves insufficient.
   */
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) return false;

  /**
   * Warm start on Windows/Linux: the second process's argv arrives here rather than via
   * `open-url`. Bug (2). `commandLine` is filtered by `connectLinkFromArgv`, never used
   * wholesale — bug (4).
   */
  app.on("second-instance", (_event, commandLine) => {
    const link = connectLinkFromArgv(commandLine);
    if (link) offerConnectLink(link);
    // Focus regardless: a user who re-launched the app expects it to surface even if the
    // launch carried no link.
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // macOS, both cold and warm. Registered here — before whenReady — for bug (1).
  app.on("open-url", (event, url) => {
    // Prevent default so the OS does not also try to hand the URL to a browser.
    event.preventDefault();
    const link = connectLinkFromUrl(url);
    if (link) offerConnectLink(link);
  });

  /**
   * Claim the scheme with the OS.
   *
   * In development the executable is Electron itself, so the registration has to name
   * this project's entry point or the OS would route `praimana://` to a bare Electron
   * that knows nothing about it. In a packaged build the app IS the executable.
   */
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }

  /**
   * Cold start on Windows/Linux: the link is in OUR OWN argv, and no event fires for it.
   * Bug (2) again — the case most often missed, because macOS development never hits it.
   */
  const initial = connectLinkFromArgv(process.argv);
  /**
   * ⚠ THROUGH THE SAME SLOT-WRITING PATH, so a cold-start link gets an id and an `offeredAt` like
   * any other. Assigning the bare link here — as this line used to — would leave a proposal with no
   * id, which `takePendingConnectLink` would then refuse to commit at all.
   *
   * `offerConnectLink` is safe to call before any window exists: its broadcast loop simply finds no
   * windows, and the cold-start screen reads the proposal through `platform:pendingLink` on mount.
   */
  if (initial) offerConnectLink(initial);

  return true;
}
