// ── THE TAGLINE IN THE HEADER ─────────────────────────────────────────────────────────────────
//
// A tagline under the Praimana wordmark in the portal header.
//
// ⚠ WHAT THIS FILE IS REALLY GUARDING IS THE `aria-hidden`, not the words.
//
// Adding a line of text under the wordmark is a two-minute change with one non-obvious consequence: on every
// page header the brand is a LINK (`href={home}`), and a link's accessible name is its text content. Without
// `aria-hidden` the tagline joins that name, so a screen reader announces "Praimana Know how your
// team works with AI, link" on every single page, a regression that is invisible to anyone who can see the
// header, which is exactly the kind that survives review.
//
// The words themselves are a product choice and may change freely; nothing here pins them.

import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "./BrandMark";
import { sourceWithoutComments } from "@/lib/source-under-test";

const HERE = __dirname;
const SRC = join(HERE, "..");
const brand = sourceWithoutComments(join(HERE, "BrandMark.tsx"));

describe("the tagline", () => {
  it("says something the product NAME does not", () => {
    // A tagline that restates the name is furniture. This one has to add the purpose, a team learning to
    // work with an AI assistant, which the bare name "Praimana" does not.
    expect(PRODUCT_TAGLINE.trim().length).toBeGreaterThan(8);
    expect(PRODUCT_TAGLINE.toLowerCase()).not.toBe(PRODUCT_NAME.toLowerCase());
    expect(PRODUCT_TAGLINE).not.toContain(PRODUCT_NAME);
  });

  it("is short enough not to wrap the header", () => {
    // The dense workspace bar has a 24px mark, a wordmark and a profile menu to fit. Seven words is the
    // ceiling; past that the header grows a line on the screen with the least room to spare.
    expect(PRODUCT_TAGLINE.trim().split(/\s+/).length).toBeLessThanOrEqual(7);
  });

  it("⚠ is HIDDEN from assistive tech, because the brand is a link", () => {
    /**
     * The failure mode in full: `<Link>` wraps the logo and the wordmark, its accessible name is computed
     * from its contents, so an unhidden tagline is appended to the name of a link that appears on every
     * page. Asserted on the same element, not merely on the string appearing somewhere in the file.
     */
    const tagline = /<span aria-hidden="true"[^>]*>\s*\{PRODUCT_TAGLINE\}/;
    expect(brand, "the tagline's own span carries aria-hidden").toMatch(tagline);
  });

  it("⚠ never renders without the wordmark it qualifies", () => {
    // A tagline alone is a fragment with nothing to qualify, and on the auth screens, where the wordmark is
    // suppressed, it would be the only brand text and would become the image's company.
    expect(brand).toMatch(/\{wordmark &&\s*\(tagline \?/);
  });

  it("is OFF by default, so no existing header changed silently", () => {
    // Opt-in: the auth card deliberately keeps its brand line quiet so its own <h1> stays loudest.
    expect(brand).toMatch(/tagline = false/);
  });
});

describe("where it appears", () => {
  /**
   * ⚠ DERIVED FROM THE TREE, NOT A LIST I MAINTAIN. Six headers render <BrandMark> and a seventh (the auth
   * shell) deliberately does not want a tagline. A hardcoded list of files would pass forever while a new
   * header shipped without one.
   */
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".tsx")) files.push(path);
    }
  };
  walk(SRC);

  const usages = files
    .map((path) => ({ path, code: sourceWithoutComments(path) }))
    .filter(({ code }) => /<BrandMark\b/.test(code))
    .flatMap(({ path, code }) =>
      [...code.matchAll(/<BrandMark\b[^>]*\/>/g)].map((m) => ({ path, tag: m[0] }))
    );

  it("finds every brand mark in the tree", () => {
    // If this drops to zero the assertions below are all vacuously true.
    expect(usages.length).toBeGreaterThanOrEqual(6);
  });

  it("⚠ every SIGNED-IN header carries it, and only the auth card does not", () => {
    /**
     * The regression: the tagline on five headers and missing from the sixth, which reads as a broken page
     * rather than a deliberate omission. The auth shell is the ONE exception and it is identified by what
     * makes it exceptional, it suppresses the wordmark's prominence with `tone="neutral"` and `size="sm"` -
     * rather than by its filename.
     */
    for (const { path, tag } of usages) {
      const isAuthCard = /tone="neutral"/.test(tag);
      expect(/\btagline\b/.test(tag), `${path}: ${tag}`).toBe(!isAuthCard);
    }
  });
});
