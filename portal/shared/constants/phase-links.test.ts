import { describe, it, expect } from "vitest";
import {
  PHASE_LINK_FIELDS,
  linkFieldsFor,
  encodeLinks,
  decodeLinks,
  hasAnyLink,
  isSafeHttpUrl,
} from "./phase-links";

/**
 * ── THE DEMO PHASE'S TWO LINKS, NOW SHARED BY BOTH FRONT-ENDS ──────────────────────────────
 *
 * This module is shared by both front-ends. The PORTAL was once found rendering the
 * stored string as prose: `app: https://test.com video: https://test-watch.com`, on one line, nothing
 * clickable. The desktop WRITES these fields and the portal RENDERS them for a facilitator or judge, so
 * a second copy is how the two ends stop agreeing about the format.
 *
 * ⚠ THE DESKTOP'S `phases-view.test.ts` ALSO EXERCISES THIS MODULE and is deliberately not trimmed: its
 * remaining value is the SOURCE assertions it makes about `PhasesView.tsx`, which this file cannot make.
 * These tests exist because a shared module needs tests in the package that owns it — otherwise deleting
 * the desktop test would silently remove all coverage of code the portal depends on.
 */

const demo = PHASE_LINK_FIELDS.demo;

describe("the exact reported string round-trips into two labelled links", () => {
  it("decodes both fields from the two-line stored form", () => {
    // Precisely what was in the database when this was reported.
    const stored = "app: https://test.com\nvideo: https://test-watch.com";

    expect(decodeLinks(demo, stored)).toEqual({
      app: "https://test.com",
      video: "https://test-watch.com",
    });
  });

  it("labels them the way BOTH front-ends must, since a reader has to tell them apart", () => {
    // Two unlabelled URLs leave a facilitator guessing which is the app and which the recording. These
    // strings are asserted because the portal now renders them and a rename would desynchronise the
    // two views of the same value.
    expect(demo.map((f) => f.label)).toEqual(["Live application URL", "Demo video link"]);
    expect(demo.map((f) => f.key)).toEqual(["app", "video"]);
  });

  it("is keyed by phase NAME, case- and space-insensitively", () => {
    // Ids are per-workshop ULIDs, so an id check would work in dev and nowhere else.
    expect(linkFieldsFor({ name: "Demo" })).toBe(demo);
    expect(linkFieldsFor({ name: "  demo  " })).toBe(demo);
    // ⚠ EXACT MATCH, NOT SUBSTRING: a "Demo Prep" phase keeps its free-text notes.
    expect(linkFieldsFor({ name: "Demo Prep" })).toBeNull();
    expect(linkFieldsFor({ name: "Build" })).toBeNull();
  });

  it("survives a value pasted from Windows", () => {
    // A stray CR would otherwise end up INSIDE the URL and break the anchor's href.
    expect(decodeLinks(demo, "app: https://a.example\r\nvideo: https://b.example")).toEqual({
      app: "https://a.example",
      video: "https://b.example",
    });
  });
});

describe("isSafeHttpUrl — a security control, not validation polish", () => {
  it("admits http and https and nothing else", () => {
    expect(isSafeHttpUrl("https://test.com")).toBe(true);
    expect(isSafeHttpUrl("http://test.com")).toBe(true);
    expect(isSafeHttpUrl("  https://test.com  ")).toBe(true);
  });

  it("⚠ REFUSES THE SCHEMES THAT WOULD EXECUTE — the hole this closes", () => {
    // Both front-ends put this value in an `href`. The desktop once assigned `phase.content` directly,
    // so a participant who stored a `javascript:` URL had it run in the renderer's context on click.
    // The portal now renders the same field and would have inherited the same hole.
    for (const hostile of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox",
      "file:///etc/passwd",
    ]) {
      expect(isSafeHttpUrl(hostile), hostile).toBe(false);
    }
  });

  it("refuses things that are not URLs at all, rather than throwing", () => {
    // A participant typed prose into a field that used to be free text. It renders as text.
    for (const notUrl of ["", "   ", "test.com", "see the demo", "//test.com"]) {
      expect(isSafeHttpUrl(notUrl), notUrl).toBe(false);
    }
  });
});

describe("the legacy rows that exist in the live database", () => {
  it("treats a pre-change BARE url as the first field", () => {
    // Before the fields existed, Demo stored one unprefixed URL. It must appear in the form rather than
    // vanish the moment this ships.
    expect(decodeLinks(demo, "https://old-single-link.example")).toEqual({
      app: "https://old-single-link.example",
      video: "",
    });
  });

  it("does NOT swallow a second line when one line IS prefixed", () => {
    // Someone hand-edited one line. Guarding on "did anything match" rather than "does line 0 look like
    // a URL" is what keeps the other line intact.
    expect(decodeLinks(demo, "nonsense\nvideo: https://b.example")).toEqual({
      app: "",
      video: "https://b.example",
    });
  });

  it("⚠ reports NO LINKS for a prose-only Demo phase, which is what makes the portal fall back", () => {
    /**
     * THE REASON `hasAnyLink` EXISTS RATHER THAN A `content` TRUTHINESS CHECK. A Demo phase written
     * before the fields existed holds prose. `decodeLinks` treats line 0 as the app value, so the naive
     * check would render an empty-ish link row instead of the words the team actually wrote.
     */
    const prose = "We will present the checkout flow and the admin view.";
    const values = decodeLinks(demo, prose);
    // Line 0 becomes the app value under the legacy rule...
    expect(values.app).toBe(prose);
    // ...so the caller ALSO has to ask whether it is a usable link before rendering it as one.
    expect(isSafeHttpUrl(values.app)).toBe(false);
  });

  it("hasAnyLink is false for an empty phase and true once one field is filled", () => {
    expect(hasAnyLink({ app: "", video: "" })).toBe(false);
    expect(hasAnyLink({ app: "   ", video: "" })).toBe(false);
    expect(hasAnyLink({ app: "https://a.example", video: "" })).toBe(true);
  });
});

describe("encode", () => {
  it("writes NO line for a blank field, so one filled field stores exactly one line", () => {
    expect(encodeLinks(demo, { app: "https://a.example", video: "" })).toBe(
      "app: https://a.example"
    );
  });

  it("round-trips through decode", () => {
    const values = { app: "https://a.example", video: "https://b.example/watch/1" };
    expect(decodeLinks(demo, encodeLinks(demo, values))).toEqual(values);
  });
});
