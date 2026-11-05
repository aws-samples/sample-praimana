// The deep link parses OS-DELIVERED, ATTACKER-INFLUENCEABLE input: any web page can
// trigger a custom-scheme navigation, and on Windows/Linux the payload arrives in argv.
//
// So the properties pinned here are containment, not features:
//
//   - a malformed URL returns null instead of throwing (this runs before a window
//     exists, where an exception is a crash with no UI to report it);
//   - argv is scanned for exactly ONE recognised scheme and nothing else is read from it
//     — note `--remote-debugging-port` injection is reachable here;
//   - the key is length-capped, since it is forwarded to a renderer and rendered.
//
// ⚠ WHAT THIS FILE CANNOT TEST is that the participant actually READ the panel. What it can now
// test — and does, at the foot — is that the commit is BOUND to the proposal that was displayed:
// `takePendingConnectLink` requires the id `peekPendingConnectLink` handed out, and a proposal
// expires. In the absence of any redeem-on-receive path, `offerConnectLink` still only records and
// notifies. See the module header.

import { describe, it, expect, vi, afterEach } from "vitest";

// deep-link.ts imports electron for `app`/`BrowserWindow`; only the pure parsers are
// under test here, so the module surface is stubbed rather than driven.
vi.mock("electron", () => ({
  app: {
    requestSingleInstanceLock: () => true,
    on: () => {},
    setAsDefaultProtocolClient: () => {},
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  connectLinkFromUrl,
  connectLinkFromArgv,
  DEEP_LINK_SCHEME,
  initDeepLinks,
  peekPendingConnectLink,
  takePendingConnectLink,
  hasPendingConnectLink,
} from "./deep-link";

const POOL = "us-east-1_EXAMPLE01";
const CLIENT = "clientaaaaaaaaaaaaaaaaaaaa";
const P = encodeURIComponent("https://ai.acme.example");
const A = encodeURIComponent("https://api.acme.example");
/** A well-formed link, as the portal builds it. Config only — no code, no token. */
const LINK = `praimana://connect?p=${P}&a=${A}&pool=${POOL}&c=${CLIENT}`;

describe("connectLinkFromUrl", () => {
  it("extracts the config from a well-formed link", () => {
    expect(connectLinkFromUrl(LINK)).toEqual({
      portalUrl: "https://ai.acme.example",
      apiBaseUrl: "https://api.acme.example",
      poolId: POOL,
      clientId: CLIENT,
    });
  });

  it("tolerates surrounding whitespace, as an OS or shell may add it", () => {
    expect(connectLinkFromUrl(`  ${LINK}  `)?.poolId).toBe(POOL);
  });

  it("accepts extra parameters, so a future addition does not break older builds", () => {
    expect(connectLinkFromUrl(`${LINK}&utm=x`)?.poolId).toBe(POOL);
  });

  /**
   * ⚠ NULL, NEVER A THROW. This runs from `open-url` and from argv parsing at module
   * load — before any window exists. An exception there is a crash with no UI to report
   * it, triggerable by any local process sending a malformed URL.
   */
  it.each([
    "",
    "   ",
    "not a url",
    "://///",
    "praimana://",
    // Right scheme, unknown action: ignored rather than guessed at, so adding an action
    // later cannot be simulated by an older build.
    `praimana://something-else?p=${P}&a=${A}&pool=${POOL}&c=${CLIENT}`,
    // Right shape, missing pieces — a partial link must not half-configure the app.
    "praimana://connect",
    `praimana://connect?p=${P}`,
    `praimana://connect?p=${P}&a=${A}`,
    `praimana://connect?p=${P}&a=${A}&pool=${POOL}`,
    // ⚠ PLAINTEXT API ORIGIN. It would carry the bearer in clear, and naming its own origin is
    // a hostile link's whole purpose. Config-only does not soften this.
    `praimana://connect?p=${P}&a=${encodeURIComponent("http://api.acme.example")}&pool=${POOL}&c=${CLIENT}`,
    // Wrong scheme entirely — including https, which must not be treated as a link.
    `https://connect?p=${P}`,
    "file:///etc/passwd",
  ])("returns null for unusable input: %s", (input) => {
    expect(connectLinkFromUrl(input)).toBeNull();
  });

  /**
   * ⚠ LENGTH CAP. The URL comes from outside the app and the value is forwarded to a
   * renderer and rendered in a textarea, so an unbounded string is a memory and layout
   * problem any local process could hand us. A real key is ~150 characters.
   */
  it("rejects an absurdly long value rather than forwarding it to a renderer", () => {
    expect(
      connectLinkFromUrl(`praimana://connect?p=${P}&a=${A}&pool=${"A".repeat(5000)}&c=${CLIENT}`)
    ).toBeNull();
    // Just under the cap still works, so the bound is not accidentally tight.
    expect(
      connectLinkFromUrl(`praimana://connect?p=${P}&a=${A}&pool=${"A".repeat(400)}&c=${CLIENT}`)
    ).not.toBeNull();
  });

  /**
   * ⚠ NO CREDENTIAL IN THE LINK. It lands in `process.argv`, readable by any local process, so a
   * bearer there would be permanent and silent if stolen. The link carries configuration only —
   * a pool id and client id that travel in every OAuth redirect anyway.
   */
  it("carries no code and no token", () => {
    const parsed = connectLinkFromUrl(LINK);
    expect(parsed).not.toHaveProperty("code");
    expect(JSON.stringify(parsed)).not.toMatch(/token/i);
  });

  it("exports the scheme it actually matches, so registration cannot drift from parsing", () => {
    expect(DEEP_LINK_SCHEME).toBe("praimana");
  });
});

describe("connectLinkFromArgv — argv is attacker-controlled", () => {
  it("finds a link among ordinary arguments", () => {
    expect(connectLinkFromArgv(["/path/to/app", "--some-flag", LINK])?.poolId).toBe(POOL);
  });

  it("returns null when no argument is a link", () => {
    expect(connectLinkFromArgv(["/path/to/app", "--enable-logging"])).toBeNull();
    expect(connectLinkFromArgv([])).toBeNull();
  });

  /**
   * ⚠ THE FIRST MATCH ONLY. A crafted argv carrying two links must not let the second
   * override the first — the app acts on one candidate, deterministically.
   */
  it("takes the FIRST link and ignores later ones", () => {
    expect(
      connectLinkFromArgv([
        "/path/to/app",
        LINK,
        `praimana://connect?p=${P}&a=${A}&pool=us-east-1_Second&c=${CLIENT}`,
      ])?.poolId
    ).toBe(POOL);
  });

  /**
   * ⚠ NOTHING ELSE IS READ FROM ARGV. A protocol handler
   * makes `--remote-debugging-port` injection reachable — which under a renderer that
   * holds the IPC bridge would be a full compromise. This function must return only a
   * link, never contribute a switch.
   */
  it("ignores dangerous-looking switches entirely", () => {
    const argv = [
      "/path/to/app",
      "--remote-debugging-port=9222",
      "--inspect-brk",
      "--no-sandbox",
    ];
    expect(connectLinkFromArgv(argv)).toBeNull();
  });

  it("is unfazed by non-string entries", () => {
    // argv is typed as string[], but this parses input from outside the type system.
    expect(
      connectLinkFromArgv([undefined as unknown as string, null as unknown as string, LINK])?.poolId
    ).toBe(POOL);
  });

  it("matches the scheme case-insensitively, as the OS may normalise it", () => {
    expect(connectLinkFromArgv(["/app", LINK.replace("praimana://", "PRAIMANA://")])?.poolId).toBe(
      POOL
    );
  });
});

/**
 * ── ⚠ THE PENDING PROPOSAL: IDENTIFIED, AND IT EXPIRES ─────────────────────────────────────────
 *
 * The confirmation click is this app's whole security boundary for repointing its identity provider, and it
 * was not bound to what got committed: the display path peeked, the commit path took whatever occupied the
 * slot at that instant, and any web page could overwrite it at any time. Driven through the COLD-START argv
 * path, which is the one route that reaches `offerConnectLink` without a window.
 */
describe("the pending proposal is bound to the confirmation", () => {
  /** Offer a link the way a cold start does: it is sitting in our own argv. */
  function offerViaArgv(url = LINK): string {
    const argv = vi.spyOn(process, "argv", "get").mockReturnValue(["electron", ".", url]);
    initDeepLinks();
    argv.mockRestore();
    const proposal = peekPendingConnectLink();
    if (!proposal) throw new Error("the link should have been offered");
    return proposal.id;
  }

  afterEach(() => {
    vi.useRealTimers();
    // Drain the slot so one test's proposal cannot satisfy the next one's assertions.
    const left = peekPendingConnectLink();
    if (left) takePendingConnectLink(left.id);
  });

  it("hands out an id alongside the link it describes", () => {
    const id = offerViaArgv();

    expect(id).toBeTruthy();
    expect(peekPendingConnectLink()?.link.poolId).toBe(POOL);
    // Peeking does NOT consume: the participant has not decided yet.
    expect(hasPendingConnectLink()).toBe(true);
  });

  it("⚠ REFUSES to commit under any id but the current one", () => {
    offerViaArgv();

    expect(takePendingConnectLink("not-the-id")).toBeNull();
    expect(takePendingConnectLink("")).toBeNull();
    // And the refusals consumed nothing, so the real click still works.
    expect(hasPendingConnectLink()).toBe(true);
  });

  it("commits exactly once under the right id", () => {
    const id = offerViaArgv();

    expect(takePendingConnectLink(id)?.poolId).toBe(POOL);
    // Consumed: a committed proposal cannot be re-applied on a later mount.
    expect(takePendingConnectLink(id)).toBeNull();
    expect(hasPendingConnectLink()).toBe(false);
  });

  /**
   * ⚠ THE SWAP. A hostile page fires a second link after the panel rendered and before the click
   * lands. The panel's click still carries the FIRST proposal's id, and committing the second one
   * under a confirmation given to the first is the defect — so the commit must fail.
   */
  it("⚠ REFUSES the click when the slot was overwritten after the panel read it", () => {
    const shownToUser = offerViaArgv();

    const attacker = `praimana://connect?p=${P}&a=${encodeURIComponent("https://attacker.example")}&pool=${POOL}&c=${CLIENT}`;
    offerViaArgv(attacker);

    // The participant confirmed what they were shown; that proposal is gone.
    expect(takePendingConnectLink(shownToUser)).toBeNull();
    // And the attacker's link was NOT committed as a side effect of their click.
    expect(peekPendingConnectLink()?.link.apiBaseUrl).toBe("https://attacker.example");
  });

  /**
   * ⚠ AND IT DOES NOT WAIT FOR EVER. A proposal planted at any earlier time used to survive in
   * memory indefinitely and be re-offered the next time the participant reached the setup screen for
   * their own reasons — after `platform:reset`, say — with no browser click of theirs behind it.
   */
  it("⚠ EXPIRES a proposal nobody confirmed", () => {
    vi.useFakeTimers();
    const id = offerViaArgv();
    expect(hasPendingConnectLink()).toBe(true);

    // Inside the window a decision still lands: nobody legitimate is timed out mid-read.
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(hasPendingConnectLink()).toBe(true);

    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(hasPendingConnectLink(), "past five minutes it is not on offer").toBe(false);
    expect(peekPendingConnectLink()).toBeNull();
    expect(takePendingConnectLink(id), "and it cannot be committed either").toBeNull();
  });
});
