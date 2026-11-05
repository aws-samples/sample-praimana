// The connect link is parsed from OS-DELIVERED, ATTACKER-INFLUENCEABLE input: any web page can
// trigger a custom-scheme navigation, and on Windows/Linux the payload arrives in argv.
//
// The properties pinned here are containment:
//
//   - the API origin must be HTTPS (it will carry a bearer token) — the single most important
//     assertion in this file, because a hostile link's whole goal is to name its own origin;
//   - a malformed link throws DesktopLinkError and nothing else, since callers run before a
//     window exists where an unexpected exception is a crash with no UI;
//   - the code is length-capped, since it is forwarded to a renderer and rendered.

import { describe, it, expect } from "vitest";
import {
  buildDesktopConnectLink,
  parseDesktopConnectLink,
  looksLikeDesktopConnectLink,
  DesktopLinkError,
  DEEP_LINK_SCHEME,
  DEEP_LINK_HOST,
} from "./desktop-link";

const LINK = {
  portalUrl: "https://ai.acme.example",
  apiBaseUrl: "https://api.acme.example",
  poolId: "us-east-1_EXAMPLE01",
  clientId: "clientaaaaaaaaaaaaaaaaaaaa",
};

/** Query string for a hand-built link, so a test can omit one parameter at a time. */
function q(over: Partial<Record<"p" | "a" | "pool" | "c", string>> = {}) {
  const base: Record<string, string> = {
    p: LINK.portalUrl,
    a: LINK.apiBaseUrl,
    pool: LINK.poolId,
    c: LINK.clientId,
    ...over,
  };
  return new URLSearchParams(base).toString();
}

describe("buildDesktopConnectLink", () => {
  it("round-trips all three values", () => {
    expect(parseDesktopConnectLink(buildDesktopConnectLink(LINK))).toEqual(LINK);
  });

  it("produces a single-line link with no whitespace", () => {
    expect(buildDesktopConnectLink(LINK)).not.toMatch(/\s/);
  });

  it("uses the shared scheme and host, so the desktop's matcher cannot drift", () => {
    expect(buildDesktopConnectLink(LINK).startsWith(`${DEEP_LINK_SCHEME}://${DEEP_LINK_HOST}?`)).toBe(
      true
    );
  });

  it("refuses to build a malformed link, rather than shipping one to a user", () => {
    expect(() => buildDesktopConnectLink({ ...LINK, poolId: "" })).toThrow(DesktopLinkError);
    expect(() => buildDesktopConnectLink({ ...LINK, clientId: "" })).toThrow(DesktopLinkError);
    expect(() => buildDesktopConnectLink({ ...LINK, portalUrl: "" })).toThrow(DesktopLinkError);
    expect(() => buildDesktopConnectLink({ ...LINK, apiBaseUrl: "not a url" })).toThrow(
      DesktopLinkError
    );
  });

  /**
   * ⚠ NO CREDENTIAL IN THE LINK. It lands in `process.argv`, readable by any local process, so
   * a bearer or a password there would be permanent and silent if stolen. Config only.
   */
  it("carries only configuration — never a token or a code", () => {
    const link = buildDesktopConnectLink(LINK);
    expect(link).not.toMatch(/code=/);
    expect(link).not.toMatch(/token/i);
    expect(link).not.toMatch(/password/i);
  });

  it("percent-encodes, so a crafted value cannot inject another parameter", () => {
    const sneaky = buildDesktopConnectLink({ ...LINK, clientId: "abc&a=https://evil.test" });
    expect(parseDesktopConnectLink(sneaky).apiBaseUrl).toBe(LINK.apiBaseUrl);
  });
});

describe("parseDesktopConnectLink", () => {
  const link = (over?: Parameters<typeof q>[0]) =>
    `${DEEP_LINK_SCHEME}://${DEEP_LINK_HOST}?${q(over)}`;

  it("tolerates whitespace and a wrapped paste", () => {
    const raw = buildDesktopConnectLink(LINK);
    expect(parseDesktopConnectLink(`  ${raw}  `)).toEqual(LINK);
    expect(parseDesktopConnectLink(raw.slice(0, 20) + "\n" + raw.slice(20))).toEqual(LINK);
  });

  it("normalises a trailing slash on either URL", () => {
    // Used as `${origin}/v1/...`, so `//v1/...` 404s on some gateways rather than normalising.
    const parsed = parseDesktopConnectLink(
      buildDesktopConnectLink({
        ...LINK,
        apiBaseUrl: "https://api.acme.example/",
        portalUrl: "https://ai.acme.example///",
      })
    );
    expect(parsed.apiBaseUrl).toBe("https://api.acme.example");
    expect(parsed.portalUrl).toBe("https://ai.acme.example");
  });

  it("reduces a URL with a path to its ORIGIN", () => {
    const parsed = parseDesktopConnectLink(
      link({ p: "https://ai.acme.example/welcome", a: "https://api.acme.example/v1/" })
    );
    expect(parsed.portalUrl).toBe("https://ai.acme.example");
    expect(parsed.apiBaseUrl).toBe("https://api.acme.example");
  });

  /**
   * ⚠ THE ASSERTION THAT MATTERS MOST.
   *
   * The API origin is where the desktop sends its bearer on every request. A plaintext origin
   * would put the session token on the wire in clear, and a hostile link's entire goal is to
   * name an origin of its own choosing — so http:// for a real host must be refused outright.
   * Config-only does not soften this: the origin IS the dangerous field.
   */
  it("REFUSES a plaintext API origin for a real host", () => {
    expect(() => parseDesktopConnectLink(link({ a: "http://api.acme.example" }))).toThrow(/https/);
  });

  it("refuses a plaintext PORTAL origin for a real host too", () => {
    expect(() => parseDesktopConnectLink(link({ p: "http://ai.acme.example" }))).toThrow(/https/);
  });

  it("allows loopback for local development", () => {
    expect(
      parseDesktopConnectLink(link({ p: "http://localhost:3001", a: "http://localhost:8080" }))
    ).toEqual({ ...LINK, portalUrl: "http://localhost:3001", apiBaseUrl: "http://localhost:8080" });
  });

  it("rejects credentials embedded in a URL", () => {
    expect(() => parseDesktopConnectLink(link({ a: "https://u:pw@api.acme.example" }))).toThrow(
      DesktopLinkError
    );
  });

  /**
   * ⚠ ONE ERROR TYPE, NEVER A BARE THROW. Callers run from `open-url` and argv parsing at
   * module load, before any window exists — where an unexpected exception is a crash with no UI
   * to report it, triggerable by any local process.
   */
  it.each([
    "",
    "   ",
    "not a url",
    "://///",
    `${DEEP_LINK_SCHEME}://`,
    // Right scheme, unknown action — ignored rather than guessed at.
    `${DEEP_LINK_SCHEME}://something-else?${q()}`,
    // Wrong scheme entirely.
    `https://connect?${q()}`,
    "file:///etc/passwd",
  ])("throws DesktopLinkError for unusable input: %s", (input) => {
    expect(() => parseDesktopConnectLink(input)).toThrow(DesktopLinkError);
  });

  /**
   * ⚠ ALL FOUR OR NOTHING. A partial link would half-configure the app, which then fails at
   * sign-in with nothing pointing back to the link that caused it.
   */
  it.each(["p", "a", "pool", "c"] as const)("rejects a link missing %s", (missing) => {
    const params = new URLSearchParams(q());
    params.delete(missing);
    expect(() =>
      parseDesktopConnectLink(`${DEEP_LINK_SCHEME}://${DEEP_LINK_HOST}?${params.toString()}`)
    ).toThrow(DesktopLinkError);
  });

  it("rejects an implausibly long value rather than forwarding it to a renderer", () => {
    expect(() => parseDesktopConnectLink(link({ pool: "A".repeat(600) }))).toThrow(
      /implausibly long/
    );
  });

  /**
   * ⚠ THE CAP NOW REACHES THE VALUES IT WAS WRITTEN FOR. Its docstring gives "forwarded to a
   * renderer that displays them" as the reason and it applied to `pool`/`c` only — while `p` and
   * `a` are the two the confirmation panel actually renders, in a `break-all` mono block in a
   * narrow card. A padded host wraps the registrable domain out of view, which is the part the
   * participant is being asked to read.
   */
  it("bounds the two origins it asks a renderer to display", () => {
    expect(() => parseDesktopConnectLink(link({ a: `https://${"a".repeat(600)}.example` }))).toThrow(
      /implausibly long/
    );
    expect(() => parseDesktopConnectLink(link({ p: `https://${"a".repeat(600)}.example` }))).toThrow(
      /implausibly long/
    );
  });

  /**
   * Under `MAX_PARAM_LENGTH` but over the DNS limit — `new URL` enforces neither, so the hostname
   * needs its own bound or 250 characters of padding still pushes the real domain off the panel.
   */
  it("bounds the hostname itself, not just the whole origin", () => {
    const host = `${"a".repeat(300)}.example`;
    expect(host.length).toBeLessThan(512);
    expect(() => parseDesktopConnectLink(link({ a: `https://${host}` }))).toThrow(
      /implausibly long hostname/
    );
  });

  it("still accepts an ordinary origin", () => {
    expect(parseDesktopConnectLink(link()).apiBaseUrl).toBe(LINK.apiBaseUrl);
  });

  /**
   * The pool id's SHAPE is not validated here. `oidcDiscoveryUrl` does it, immediately before
   * interpolating it into a URL — which is the only place it can be guaranteed, and duplicating
   * it here would create a second source of truth that could drift.
   */
  it("does not second-guess the pool id's shape", () => {
    expect(parseDesktopConnectLink(link({ pool: "not-a-pool" })).poolId).toBe("not-a-pool");
  });
});

describe("looksLikeDesktopConnectLink", () => {
  it("is shallow, for cheap dispatch", () => {
    expect(looksLikeDesktopConnectLink(buildDesktopConnectLink(LINK))).toBe(true);
    expect(looksLikeDesktopConnectLink(`${DEEP_LINK_SCHEME}://${DEEP_LINK_HOST}`)).toBe(true);
    expect(looksLikeDesktopConnectLink("AIAK1-something")).toBe(false);
    expect(looksLikeDesktopConnectLink("")).toBe(false);
  });
});
