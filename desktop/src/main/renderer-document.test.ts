import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { pathToFileURL } from "url";

/**
 * ⚠ `app.isPackaged` IS NOW PART OF THE TRUST DECISION, so it has to be drivable here.
 *
 * The dev-origin allowance used to be gated on `NODE_ENV` alone — an environment variable any local
 * process can set, inside a shipped binary. `packaged` below is what a real build cannot have flipped
 * from outside; the tests at the bottom of this file pin that a packaged build refuses the dev origin
 * even when `NODE_ENV=development` is present.
 */
let packaged = false;
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return packaged;
    },
  },
}));

/**
 * THE RENDERER TRUST BOUNDARY.
 *
 * `isOwnRendererUrl` is what `will-navigate` and the IPC sender guard both consult, so it decides
 * two things at once: where this window may go, and which frames may reach ~120 privileged
 * channels. Both previously trusted ANY `file://` URL.
 *
 * ⚠ THESE TESTS CUT BOTH WAYS ON PURPOSE. A guard this central fails in two directions — too loose
 * and a local HTML file inherits the whole bridge, too tight and the app cannot talk to itself at
 * all. So the accept cases (packaged document, the `?chooser=1` variants, the dev server) matter as
 * much as the refusals, and they are asserted against the SAME path derivation index.ts uses.
 */

import { isOwnRendererUrl, rendererDocumentPath, DEV_ORIGIN } from "./renderer-document";

/** The real production document URL, built the way Electron builds it for `loadFile`. */
const ownUrl = () => pathToFileURL(rendererDocumentPath()).href;

const savedEnv = process.env.NODE_ENV;
beforeEach(() => {
  delete process.env.NODE_ENV; // production by default
  packaged = false; // an unpackaged checkout by default, so NODE_ENV still decides
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedEnv;
});

describe("accepts the app's own document — the app must still work", () => {
  it("accepts the packaged renderer document", () => {
    expect(isOwnRendererUrl(ownUrl())).toBe(true);
  });

  it("accepts the profile-chooser variants, which differ only by query string", () => {
    // `loadFile(..., { search })` produces these. A raw-string comparison would reject them and
    // break the one screen that runs before anything is signed in.
    expect(isOwnRendererUrl(`${ownUrl()}?chooser=1`)).toBe(true);
    expect(isOwnRendererUrl(`${ownUrl()}?chooser=1&mustCreate=1`)).toBe(true);
  });

  it("ignores a hash, which selects a view rather than a document", () => {
    expect(isOwnRendererUrl(`${ownUrl()}#/board`)).toBe(true);
  });

  it("accepts a percent-encoded spelling of the same path", () => {
    // Whoever builds the URL may encode differently; it is the same file either way.
    const encoded = ownUrl().replace(/\/([^/]+)\.html$/, "/%69ndex.html");
    expect(isOwnRendererUrl(encoded)).toBe(true);
  });

  it("accepts a traversal spelling that resolves to the same document", () => {
    /**
     * ⚠ BUILT AS A STRING, NOT VIA `path.join`. The first version of this used
     * `path.join(dir, "sub", "..", "index.html")`, which NORMALISES at construction — so the URL it
     * produced was byte-identical to the baseline test above and no traversal ever reached
     * `isOwnRendererUrl`. It was a duplicate asserting nothing, which is worse than absent: it read
     * as coverage of a case that was untested.
     */
    const dir = pathToFileURL(path.dirname(rendererDocumentPath())).href;
    const viaTraversal = `${dir}/sub/../index.html`;
    expect(viaTraversal).toContain("/../"); // the traversal really is in the input
    expect(isOwnRendererUrl(viaTraversal)).toBe(true);
  });

  it("accepts the dev server in development, by EXACT origin", () => {
    process.env.NODE_ENV = "development";
    expect(isOwnRendererUrl(DEV_ORIGIN)).toBe(true);
    expect(isOwnRendererUrl(`${DEV_ORIGIN}/`)).toBe(true);
    expect(isOwnRendererUrl(`${DEV_ORIGIN}/?chooser=1`)).toBe(true);
  });
});

describe("refuses everything else", () => {
  it("REFUSES another local HTML file — the hole this closes", () => {
    // The agent can write a file into the project during normal work, and markdown in the chat
    // views renders plain in-window links. Trusting any file:// URL made that a full bridge handover.
    const dir = path.dirname(rendererDocumentPath());
    expect(isOwnRendererUrl(pathToFileURL(path.join(dir, "evil.html")).href)).toBe(false);
    expect(isOwnRendererUrl("file:///tmp/evil.html")).toBe(false);
    expect(isOwnRendererUrl("file:///Users/victim/project/notes.html")).toBe(false);
  });

  it("REFUSES a sibling whose name merely starts the same way", () => {
    const own = rendererDocumentPath();
    expect(isOwnRendererUrl(pathToFileURL(own + ".evil").href)).toBe(false);
    expect(isOwnRendererUrl(pathToFileURL(own.replace(/\.html$/, "-evil.html")).href)).toBe(false);
  });

  it("REFUSES the dev origin in production", () => {
    // A packaged build never loads it, so trusting it would be a gift with no legitimate use.
    expect(isOwnRendererUrl(DEV_ORIGIN)).toBe(false);
    expect(isOwnRendererUrl(`${DEV_ORIGIN}/?chooser=1`)).toBe(false);
  });

  it("REFUSES look-alike dev origins that a prefix check accepted", () => {
    process.env.NODE_ENV = "development";
    // `startsWith("http://localhost:5173")` — the old check — matched both of these.
    expect(isOwnRendererUrl("http://localhost:51735")).toBe(false);
    expect(isOwnRendererUrl("http://localhost:5173.evil.com")).toBe(false);
    expect(isOwnRendererUrl("https://localhost:5173")).toBe(false);
    expect(isOwnRendererUrl("http://127.0.0.1:5173")).toBe(false);
  });

  it("REFUSES remote origins", () => {
    expect(isOwnRendererUrl("https://evil.example/index.html")).toBe(false);
    expect(isOwnRendererUrl("http://attacker.test/")).toBe(false);
  });

  it("REFUSES non-document schemes and unparseable values", () => {
    for (const url of [
      "about:blank",
      "data:text/html,<script>fetch('x')</script>",
      "javascript:alert(1)",
      "blob:file:///abc",
      "",
      "not a url",
      "/just/a/path/index.html",
    ]) {
      expect(isOwnRendererUrl(url), url).toBe(false);
    }
  });

  it("fails closed on null / undefined / non-string", () => {
    expect(isOwnRendererUrl(undefined)).toBe(false);
    expect(isOwnRendererUrl(null)).toBe(false);
    // @ts-expect-error — exercising the runtime guard against bad callers
    expect(isOwnRendererUrl(42)).toBe(false);
  });

  it("REFUSES a file:// URL carrying a host, which is not our local document", () => {
    // `file://evil.example/path` parses, and its pathname alone would look innocent.
    expect(isOwnRendererUrl(`file://evil.example${rendererDocumentPath()}`)).toBe(false);
  });
});

describe("the dev allowance cannot be turned on by the environment", () => {
  /**
   * The reported P1: three security decisions keyed on `process.env.NODE_ENV`, read at runtime inside
   * the shipped binary. `launchctl setenv NODE_ENV development` needs no privilege, and neither does
   * binding 127.0.0.1:5173 — so a signed, notarized, TCC-approved app could be made to load an
   * attacker's page as its own renderer, with the preload bridge attached and every IPC channel
   * reachable.
   */
  it("REFUSES the dev origin in a PACKAGED build even with NODE_ENV=development", () => {
    packaged = true;
    process.env.NODE_ENV = "development";

    expect(isOwnRendererUrl(DEV_ORIGIN)).toBe(false);
    expect(isOwnRendererUrl(`${DEV_ORIGIN}/?chooser=1`)).toBe(false);
  });

  it("REFUSES it in a packaged build for every truthy spelling of the flag", () => {
    packaged = true;
    for (const value of ["development", "dev", "DEVELOPMENT", "1", "true"]) {
      process.env.NODE_ENV = value;
      expect(isOwnRendererUrl(DEV_ORIGIN), value).toBe(false);
    }
  });

  it("still accepts the packaged document itself in a packaged build", () => {
    // The gate must close the dev origin WITHOUT closing the app's own document, or the fix is an
    // outage rather than a fix.
    packaged = true;
    process.env.NODE_ENV = "development";
    expect(isOwnRendererUrl(ownUrl())).toBe(true);
    expect(isOwnRendererUrl(`${ownUrl()}?chooser=1`)).toBe(true);
  });

  it("still allows the dev server in an UNPACKAGED checkout with NODE_ENV=development", () => {
    // `pnpm dev` must keep working: unpackaged plus the intent flag is the one case that trusts it.
    packaged = false;
    process.env.NODE_ENV = "development";
    expect(isOwnRendererUrl(DEV_ORIGIN)).toBe(true);
  });

  it("refuses the dev server in an unpackaged checkout WITHOUT the flag", () => {
    // `electron .` against a built dist is unpackaged and has no dev server; it must load and trust
    // the packaged document, not localhost.
    packaged = false;
    delete process.env.NODE_ENV;
    expect(isOwnRendererUrl(DEV_ORIGIN)).toBe(false);
    expect(isOwnRendererUrl(ownUrl())).toBe(true);
  });
});
