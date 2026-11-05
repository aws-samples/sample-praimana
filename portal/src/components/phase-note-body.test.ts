import { describe, it, expect } from "vitest";
import { join } from "path";
import { linkFieldsFor, decodeLinks, isSafeHttpUrl } from "@praimana/shared";
import { sourceWithoutComments } from "@/lib/source-under-test";

/**
 * ── THE DEMO LINKS IN THE PORTAL ───────────────────────────────────────────────────────────
 *
 * REPORTED: the portal showed `app: https://test.com video: https://test-watch.com`, one line of
 * prose, nothing clickable, while the desktop showed two labelled links. It is the same stored value
 * rendered two different ways, which is the actual defect: a participant fills these in on the desktop
 * and a FACILITATOR or JUDGE clicks them here.
 *
 * ── ⚠ WHY THESE ARE SOURCE ASSERTIONS ──
 *
 * This package's vitest is `environment: "node"` with no jsdom and no RTL, every existing test here is
 * pure logic or a source read. Adding a DOM harness for one component is a bigger change than the
 * component. So this follows the same convention as the desktop's `phases-view.test.ts`: the pure
 * behaviour is exercised through the real shared functions, and the rules that would silently regress
 * are asserted against the source.
 *
 * The three source assertions are not style checks. Each one is a property whose loss is invisible in
 * review and harmful in production: an unguarded `href`, a missing `noopener`, or a quiet return to
 * dumping the string through markdown.
 */

/**
 * ⚠ COMMENTS STRIPPED, see `source-under-test.ts`. Without it these assertions are satisfiable by the
 * component's own doc comments, which explain at length exactly the properties being asserted. The
 * `rel` check below was green with the real attribute DELETED for precisely that reason.
 */
const src = sourceWithoutComments(join(__dirname, "PhaseNoteBody.tsx"));

describe("PhaseNoteBody renders the Demo phase's links as links", () => {
  it("⚠ NEVER PUTS AN UNCHECKED VALUE IN AN href, the security assertion", () => {
    /**
     * This is participant-supplied content going into an anchor. A stored `javascript:` or `data:` URL
     * would execute on click; the desktop had exactly that hole once, from assigning `phase.content`
     * straight to `href`. The guard must be present and the anchor must be inside it.
     */
    expect(src).toContain("isSafeHttpUrl(value)");
    // The ONLY href in this file is the one behind that guard. A second, unguarded one would reopen it.
    expect(src.match(/href=/g) ?? []).toHaveLength(1);
    expect(src).toMatch(/isSafeHttpUrl\(value\)[\s\S]{0,200}href=\{value\}/);
  });

  it("⚠ opens in a new tab WITH noopener and noreferrer, checked on the ANCHOR, not the file", () => {
    /**
     * Without `noopener` the opened page gets a handle back to this window (tabnabbing); without
     * `noreferrer` it learns the workshop URL the reader came from. `target="_blank"` alone is the bug.
     *
     * ⚠ THIS ASSERTION WAS WRONG ON ITS FIRST DRAFT, AND MUTATION TESTING IS WHAT CAUGHT IT. It was
     * `expect(src).toContain('rel="noreferrer noopener"')`, which the doc comment ABOVE the component
     * satisfies all on its own. Deleting the real attribute from the JSX left the test green. So the
     * rule is now asserted per ANCHOR TAG: every `<a>` in this file must carry both, which is the
     * property that actually matters and cannot be met by prose.
     */
    const anchors = src.match(/<a\s[^>]*>/g) ?? [];
    expect(anchors, "there is exactly one anchor in this component").toHaveLength(1);
    for (const anchor of anchors) {
      expect(anchor).toContain('target="_blank"');
      expect(anchor).toMatch(/rel="(?=[^"]*\bnoopener\b)(?=[^"]*\bnoreferrer\b)[^"]*"/);
    }
  });

  it("⚠ chooses the link view with hasAnyLink, NOT with a content truthiness check", () => {
    /**
     * A Demo phase whose content is PROSE from before the link fields existed decodes to no usable
     * values. Keying off "content is non-empty" would render an empty link list where the team can see
     * they wrote something, so the fallback to the markdown body is load-bearing, not defensive.
     */
    expect(src).toContain("hasAnyLink(storedLinks)");
    expect(src).toContain("ReactMarkdown");
  });

  it("labels each link, because two bare URLs are ambiguous", () => {
    expect(src).toContain("{field.label}");
  });
});

/**
 * The behaviour the component delegates, exercised through the REAL shared functions, so this file
 * fails if the module the portal depends on changes meaning, not merely if the component is edited.
 */
describe("what the component will actually render for the reported row", () => {
  const stored = "app: https://test.com\nvideo: https://test-watch.com";

  it("produces two labelled, safe, clickable URLs", () => {
    const fields = linkFieldsFor({ name: "Demo" })!;
    expect(fields).not.toBeNull();

    const values = decodeLinks(fields, stored);
    const rendered = fields
      .map((f) => ({ label: f.label, value: values[f.key], clickable: isSafeHttpUrl(values[f.key]) }))
      .filter((r) => r.value);

    expect(rendered).toEqual([
      { label: "Live application URL", value: "https://test.com", clickable: true },
      { label: "Demo video link", value: "https://test-watch.com", clickable: true },
    ]);
  });

  it("a non-Demo phase still takes the markdown path", () => {
    // The link rendering must not leak onto phases whose notes are prose.
    expect(linkFieldsFor({ name: "Build" })).toBeNull();
  });
});
