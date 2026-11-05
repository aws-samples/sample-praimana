import { describe, it, expect } from "vitest";
import {
  submissionPhaseSeed,
  seedForEmptyFields,
} from "./submission-phase-seed";

/**
 * SEEDING THE SUBMIT FORM FROM THE DEMO PHASE.
 *
 * The rule that can actually be wrong here is an ASYMMETRY between two validators that both look
 * like "is this a URL":
 *
 *   · `isSafeHttpUrl` (phase links)        accepts http: OR https:
 *   · `isReleasableDemoUrl` (release P4)   accepts https: ONLY
 *
 * So an `http://` value is a valid phase link that cannot satisfy release. Seeding it into `demoUrl`
 * would populate the form's ONE required field with something that still blocks release, the team
 * reads a filled field as done, and the checklist's "a demo link starting with https:// is needed"
 * names no culprit. A blank field is the better failure: it still reads as "not done".
 *
 * These tests exist because that distinction is invisible at a glance and would survive review.
 */

const demoPhase = (content: string | null) => ({ name: "Demo", content });

describe("submissionPhaseSeed, the https asymmetry", () => {
  it("seeds demoUrl from an https app link", () => {
    const seed = submissionPhaseSeed([demoPhase("app: https://our-app.example.com")]);
    expect(seed.demoUrl).toBe("https://our-app.example.com");
  });

  it("REFUSES to seed demoUrl from an http app link", () => {
    // ⚠ THE CENTRAL CASE. Valid as a phase link, cannot pass release P4. Must stay absent so the
    // required field keeps reading as "not done" rather than as done-but-mysteriously-blocked.
    const seed = submissionPhaseSeed([demoPhase("app: http://our-app.example.com")]);
    expect(seed.demoUrl).toBeUndefined();
  });

  it("still seeds videoUrl from an http video link, no release rule applies to it", () => {
    // The mirror of the case above: applying the stricter rule everywhere would silently drop a
    // perfectly usable video link for a precondition it has nothing to do with.
    const seed = submissionPhaseSeed([
      demoPhase("app: http://a.example.com\nvideo: http://watch.example.com"),
    ]);
    expect(seed.videoUrl).toBe("http://watch.example.com");
    expect(seed.demoUrl).toBeUndefined();
  });

  it("seeds both when both are https", () => {
    const seed = submissionPhaseSeed([
      demoPhase("app: https://a.example.com\nvideo: https://watch.example.com"),
    ]);
    expect(seed).toEqual({
      demoUrl: "https://a.example.com",
      videoUrl: "https://watch.example.com",
    });
  });

  it("refuses javascript: in either field", () => {
    // The protocol allowlist is the first line of defence, and this value would end up in an href
    // that a judge clicks. Neither predicate may admit it.
    const seed = submissionPhaseSeed([
      demoPhase("app: javascript:alert(1)\nvideo: javascript:alert(2)"),
    ]);
    expect(seed).toEqual({});
  });

  it("refuses prose that is not a URL at all", () => {
    const seed = submissionPhaseSeed([demoPhase("app: coming soon\nvideo: ask Priya")]);
    expect(seed).toEqual({});
  });
});

describe("submissionPhaseSeed, the messy real inputs decodeLinks already handles", () => {
  it("reads a legacy bare URL with no prefix as the first field", () => {
    // Pre-dates the labelled encoding: the whole content is the app URL.
    const seed = submissionPhaseSeed([demoPhase("https://legacy.example.com")]);
    expect(seed.demoUrl).toBe("https://legacy.example.com");
  });

  it("survives CRLF from a pasted value", () => {
    // A CR left inside the value would break the href, and here would fail the URL parse.
    const seed = submissionPhaseSeed([
      demoPhase("app: https://a.example.com\r\nvideo: https://watch.example.com"),
    ]);
    expect(seed).toEqual({
      demoUrl: "https://a.example.com",
      videoUrl: "https://watch.example.com",
    });
  });

  it("returns nothing for empty, null, or whitespace content", () => {
    expect(submissionPhaseSeed([demoPhase("")])).toEqual({});
    expect(submissionPhaseSeed([demoPhase(null)])).toEqual({});
    expect(submissionPhaseSeed([demoPhase("   ")])).toEqual({});
  });

  it("returns nothing for a phase that declares no link fields", () => {
    // ⚠ AND THE PHASE IS IDENTIFIED BY `linkFieldsFor`, NOT BY THE NAME "demo" HERE. A renamed phase
    // yields nothing and the fields stay empty, the pre-existing behaviour, not a regression.
    expect(submissionPhaseSeed([{ name: "Build", content: "app: https://a.example.com" }])).toEqual({});
    expect(submissionPhaseSeed([{ name: "Ideation", content: "https://a.example.com" }])).toEqual({});
  });

  it("matches the phase name case-insensitively and ignores surrounding whitespace", () => {
    expect(submissionPhaseSeed([{ name: "  demo  ", content: "app: https://a.example.com" }]).demoUrl)
      .toBe("https://a.example.com");
  });

  it("handles no phases at all", () => {
    expect(submissionPhaseSeed([])).toEqual({});
    expect(submissionPhaseSeed(null)).toEqual({});
    expect(submissionPhaseSeed(undefined)).toEqual({});
  });

  it("picks the Demo phase out of a full pipeline", () => {
    const seed = submissionPhaseSeed([
      { name: "Ideation", content: "our idea is..." },
      { name: "Build", content: "notes" },
      demoPhase("app: https://a.example.com"),
    ]);
    expect(seed.demoUrl).toBe("https://a.example.com");
  });
});

describe("seedForEmptyFields, a convenience must never overwrite typing", () => {
  const seed = { demoUrl: "https://a.example.com", videoUrl: "https://v.example.com" };

  it("fills a field that is empty", () => {
    expect(seedForEmptyFields(seed, { demoUrl: "", videoUrl: "" })).toEqual(seed);
  });

  it("leaves a field the team has already filled ALONE", () => {
    // The regression to fear: a page load quietly replacing the URL somebody pasted.
    const out = seedForEmptyFields(seed, {
      demoUrl: "https://team-typed-this.example.com",
      videoUrl: "",
    });
    expect(out).toEqual({ videoUrl: "https://v.example.com" });
    expect(out.demoUrl).toBeUndefined();
  });

  it("treats whitespace as empty", () => {
    // "  " is not a value anybody meant to keep.
    expect(seedForEmptyFields(seed, { demoUrl: "   ", videoUrl: "\t" })).toEqual(seed);
  });

  it("returns nothing when every seedable field is already filled", () => {
    expect(
      seedForEmptyFields(seed, { demoUrl: "https://x.example.com", videoUrl: "https://y.example.com" })
    ).toEqual({});
  });

  it("returns nothing when there is nothing to seed", () => {
    expect(seedForEmptyFields({}, { demoUrl: "", videoUrl: "" })).toEqual({});
  });

  it("ignores unrelated draft keys", () => {
    // The draft holds all nine editable fields; this must touch only the two it owns.
    const out = seedForEmptyFields(seed, {
      demoUrl: "",
      videoUrl: "",
      title: "Our project",
      repoUrl: "https://github.example.com/team",
    });
    expect(out).toEqual(seed);
  });
});
