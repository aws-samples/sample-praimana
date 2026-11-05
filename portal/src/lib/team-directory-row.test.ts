import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { teamTabHref } from "@/lib/team-routes";
import { formatInstantUtc } from "@/lib/format-datetime";

/**
 * THE TEAMS DIRECTORY, one row, and the count line above the list.
 *
 * ── WHY THIS FILE IS SHAPED LIKE THIS ──
 * `TeamsTab` and `TeamDirectoryRow` are private components inside a "use client" page
 * (app/admin/page.tsx). The portal suite runs `environment: "node"` with
 * `include: ["src/**\/*.test.ts"]` and there is no jsdom, no happy-dom and no
 * @testing-library in the dependency tree, so rendering either of them is not merely
 * inconvenient here, it is not executable. Same constraint, and therefore the same
 * convention, as lib/access-outcome-message.test.ts and lib/access-action-gating.test.ts:
 *
 *   1. A MIRROR of the pure logic, which string the row produces for a given field, and
 *      what the cursor stack does to a page turn. This is where behaviour is proved.
 *   2. A SOURCE PIN on the real page, against COMMENT-STRIPPED code, so the mirror cannot
 *      silently stop describing the thing it mirrors. Stripping comments is load-bearing on
 *      this file specifically: the row carries a long design note that names `?? 0`,
 *      `toLocaleDateString` and "Search covers this page only" in prose, and a pin that
 *      matched a comment would be a false green about behaviour.
 *
 * ── WHAT THIS CANNOT COVER ──
 *   • `disabled={page === 0}` and `disabled={!data?.nextCursor}` are DOM properties this suite
 *     cannot exercise, so whether the buttons are actually inert is a browser fact. What CHANGED:
 *     the attribute is no longer the only thing standing between a click and an underflow, the
 *     Previous handler now guards too (`c.length > 1 ? c.slice(0, -1) : c`), and that half IS
 *     covered here, both behaviourally (the no-op case, with the unguarded form kept as a negative
 *     control) and by a source pin. The `disabled` attributes stay pinned structurally and still
 *     need a browser to verify as properties.
 *   • `maxLength={100}` is likewise a DOM property, the browser enforces it. Pinned, and
 *     paired with a pin on the BFF cap it exists to stay under.
 *   • `aria-hidden`, `sr-only`, `truncate` and `title` are asserted as PRESENT in the
 *     source and as text in the mirror. Whether a screen reader actually skips the em dash,
 *     and whether CSS truncation happens, is a browser fact this suite cannot observe.
 *   • React's own scheduling. The debounce mirror uses vitest's fake timers (a test clock,
 *     never a sleep), so it proves the arithmetic of the debounce and the reset, not that
 *     React commits the effects in that order.
 */

const readCode = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");

const ADMIN_PAGE = "../app/admin/page.tsx";
const TEAM_ROUTER = "./trpc/routers/team.ts";

const SOURCE = readCode(ADMIN_PAGE);

/**
 * The three regions this file asserts against, sliced out of the comment-stripped page.
 *
 * Region slicing matters for the "absent" pins. "Search covers this page only" is TRUE for
 * UsersTab (a browser-side needle over one loaded page) and FALSE for the teams directory
 * (the store applies the match), so asserting it is missing from the WHOLE FILE would be
 * asserting a defect into UsersTab. The claim is only that it is absent from THIS tab.
 */
const region = (from: string, to: string) => {
  const start = SOURCE.indexOf(from);
  const end = SOURCE.indexOf(to);
  expect(start, `region start not found: ${from}`).toBeGreaterThan(-1);
  expect(end, `region end not found: ${to}`).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
};

const USERS_TAB = region("function UsersTab()", "function decodeScope(");
const TEAMS_TAB = region("function TeamsTab()", "function TeamDirectoryRow({");
const ROW = region("function TeamDirectoryRow({", "const EXPIRY_TICK_MS");

// ─── The row's two load-bearing nulls ───────────────────────────────────────────

/**
 * What one row RENDERS AS TEXT, mirrored from TeamDirectoryRow.
 *
 * Returned as a record of strings rather than as markup, because what is under test is the
 * WORDING and the branch that chooses it. Three separate fields per fallback on purpose:
 * the visible glyph, the sr-only phrase and the `title` are three independent copies of the
 * same fact in the real row, and the whole point of that design is that no ONE of them is
 * the only carrier, so a mirror that collapsed them would stop being able to prove it.
 *
 * `teamTabHref` and `formatInstantUtc` are the REAL functions, not re-implementations:
 * the row's own note says the href exists to be spelled in exactly one place, and a
 * hand-templated path in this test would defeat the assertion it is making.
 */
interface DirectoryTeam {
  id: string;
  name: string;
  workshopId: string;
  workshopName: string | null;
  memberCount: number | null;
  createdAt: string;
}

function rowText(team: DirectoryTeam) {
  // Read into a local and branched on with `== null`, LOOSE, so a service version that
  // omits the field entirely takes the same path as an explicit null. Never coerced.
  const count = team.memberCount;
  const created = formatInstantUtc(team.createdAt);

  // THE TRIMMED LOCAL, mirroring `const workshopName = team.workshopName?.trim() ? … : null`.
  //
  // The mirror used to branch on `team.workshopName` directly, which routed `null` and `""` to the
  // id fallback correctly and let `" "` through, rendering a cell that LOOKS blank, the exact
  // reading ("a data problem") the fallback exists to prevent, and the hardest kind to report
  // because there is nothing on screen to quote.
  //
  // ⚠ THE TEST IS TRIMMED, THE VALUE IS NOT. What renders is `team.workshopName` itself, so a real
  // name keeps whatever spacing the service stored: deciding a name is ABSENT is this row's
  // business, rewriting one that is PRESENT is not. `" x "` therefore renders as `" x "`, asserted
  // below, a mirror that returned the trimmed value would be describing a page that does not exist.
  const workshopName = team.workshopName?.trim() ? team.workshopName : null;

  const countVisible =
    count == null ? "- members" : `${count} ${count === 1 ? "member" : "members"}`;
  const countScreenReader =
    count == null ? "Member count unavailable, the roster could not be read" : "";
  const countHiddenFromScreenReader = count == null;

  return {
    href: teamTabHref(team.workshopId, team.id),
    /** The accessible name of the link, the team name ALONE; the arrow is decoration. */
    linkAccessibleName: team.name,
    countVisible,
    countScreenReader,
    countHiddenFromScreenReader,
    // Branched on the TRIMMED local, not on `team.workshopName`: `null`, `""` and `" "` are all
    // "not a name" and every one of them must take the id fallback.
    workshopVisible: workshopName ? workshopName : team.workshopId,
    workshopScreenReader: workshopName ? "" : "Experience name unavailable, experience id ",
    createdText: created ? ` · created ${created}` : "",
  };
}

const team = (over: Partial<DirectoryTeam> = {}): DirectoryTeam => ({
  id: "team-1",
  name: "Alpha Squad",
  workshopId: "ws-1",
  workshopName: "Summer Accelerator",
  memberCount: 4,
  createdAt: "2026-08-01T20:47:00.000Z",
  ...over,
});

describe("memberCount: null is a FAILED READ, not zero", () => {
  it("renders an em dash and NEVER the number 0", () => {
    // The single highest-value assertion in this file. `?? 0` here type-checks, lints, and
    // renders a plausible screen, and 0 is a number an operator ACTS on: "empty team" is a
    // reason to delete one. The BFF says it in as many words at DirectoryTeamRow.memberCount:
    // "Render null as '-', never as zero."
    const { countVisible } = rowText(team({ memberCount: null }));
    expect(countVisible).toBe("- members");
    expect(countVisible).not.toContain("0");
  });

  it("takes the same path when the field is ABSENT, not just null", () => {
    // `== null` rather than `=== null`, deliberately. A portal ahead of the team service
    // receives rows with no `memberCount` attribute at all, and `undefined` must not fall
    // through to the numeric branch, where it would render "undefined members".
    const absent = rowText(team({ memberCount: undefined as unknown as null }));
    expect(absent.countVisible).toBe("- members");
    expect(absent.countVisible).not.toContain("undefined");
  });

  it("pairs the glyph with an sr-only phrase, so it is never announced as a blank cell", () => {
    // The em dash is aria-hidden. Without the sr-only sentence a screen-reader user would
    // hear NOTHING where every other row says "4 members", and an absent count reads as a
    // rendering glitch rather than as the failed read it is.
    const { countScreenReader, countHiddenFromScreenReader } = rowText(
      team({ memberCount: null })
    );
    expect(countHiddenFromScreenReader).toBe(true);
    expect(countScreenReader).toBe(
      "Member count unavailable, the roster could not be read"
    );
    // And it does not say "0" or "no members" in the announced copy either.
    expect(countScreenReader).not.toMatch(/\b0\b|no members/i);
  });

  it("reports a REAL zero as 0, distinctly from the failed read", () => {
    // The negative control. Without it, "always render an em dash" would satisfy every
    // assertion above and destroy the distinction the whole design exists for: a genuinely
    // empty team IS a fact, and an operator is entitled to see it.
    const { countVisible, countScreenReader, countHiddenFromScreenReader } = rowText(
      team({ memberCount: 0 })
    );
    expect(countVisible).toBe("0 members");
    expect(countScreenReader).toBe("");
    expect(countHiddenFromScreenReader).toBe(false);
  });

  it("is SINGULAR at one and plural everywhere else, INCLUDING zero", () => {
    // "1 members" on a directory an operator reads all shift is the kind of thing that makes
    // a screen feel unmaintained. Zero is the interesting boundary and the reason the
    // pluralisation is `=== 1` and not `> 1`: the latter renders "0 member", which survives
    // every other assertion in this block. Pinned in the source below as well, because a
    // mirror cannot catch a mutation to the page's own ternary.
    expect(rowText(team({ memberCount: 0 })).countVisible).toBe("0 members");
    expect(rowText(team({ memberCount: 1 })).countVisible).toBe("1 member");
    expect(rowText(team({ memberCount: 2 })).countVisible).toBe("2 members");
    expect(rowText(team({ memberCount: 50 })).countVisible).toBe("50 members");
  });

  it("the page pluralises on `=== 1`, never on `> 1`", () => {
    expect(ROW).toContain('${count} ${count === 1 ? "member" : "members"}');
    expect(ROW).not.toMatch(/count\s*>\s*1/);
  });

  it("the page's source contains NO `?? 0` and NO `|| 0` anywhere in the row", () => {
    // The pin that makes the mirror above worth having. Asserted against COMMENT-STRIPPED
    // source, because the row's own design note contains the literal text "`?? 0` here
    // would be a correctness bug", matching raw source would let that comment satisfy a
    // pin about code, which is worse than having no pin.
    expect(ROW).not.toContain("?? 0");
    expect(ROW).not.toContain("|| 0");
    // The other two spellings of the same mistake.
    expect(ROW).not.toMatch(/memberCount\s*\|\|/);
    expect(ROW).not.toMatch(/Number\(\s*team\.memberCount/);
  });

  it("the page branches on `== null`, loose, and on a local", () => {
    expect(ROW).toContain("const count = team.memberCount;");
    expect(ROW).toContain("{count == null ? (");
    // `=== null` would let an absent field through to the numeric branch.
    expect(ROW).not.toContain("count === null");
    // The em dash and the sr-only phrase are both present, and the glyph is hidden.
    expect(ROW).toContain("- members");
    expect(ROW).toContain('<span className="sr-only">');
    expect(ROW).toContain("Member count unavailable, the roster could not be read");
    expect(ROW).toContain("This is not zero.");
  });
});

describe("workshopName: null is a FAILED LOOKUP, not 'no workshop'", () => {
  it("falls back to the workshop id, never to a blank", () => {
    // The name comes best-effort from another service so the lookup can never fail the
    // directory an operator opened during an incident. The id is the value they can quote
    // in a ticket or paste into a URL; a blank cell reads as a data problem and tells them
    // nothing.
    const { workshopVisible } = rowText(team({ workshopName: null }));
    expect(workshopVisible).toBe("ws-1");
    expect(workshopVisible).not.toBe("");
  });

  it("ALSO falls back on an empty string, and on WHITESPACE-ONLY, every way of not being a name", () => {
    // Deliberate looseness, and the reason `!= null` would be wrong: `""` from a future
    // service version is not a name either, and it would render an invisible cell.
    expect(rowText(team({ workshopName: "" })).workshopVisible).toBe("ws-1");

    // ── RE-POINTED. This block used to assert `rowText(team({ workshopName: " " }))` produced
    // `" "` and called it "documented, not asserted as correct", a truthiness-only branch let
    // whitespace through. The page now branches on a TRIMMED local
    // (`team.workshopName?.trim() ? … : null`), so whitespace takes the id fallback like every
    // other way of not being a name. The old expectation described the page before that fix.
    for (const blank of [" ", "   ", "\t", "\n", " \t\n ", " "]) {
      expect(rowText(team({ workshopName: blank })).workshopVisible, JSON.stringify(blank)).toBe(
        "ws-1"
      );
      // And it says WHICH gap it is, so the id is not announced as a bare 20-character string.
      expect(
        rowText(team({ workshopName: blank })).workshopScreenReader,
        JSON.stringify(blank)
      ).toBe("Experience name unavailable, experience id ");
    }
    // `undefined`, an older service version omitting the field, takes the same path. `?.` on the
    // trim is what makes this safe rather than a TypeError on the row.
    expect(
      rowText(team({ workshopName: undefined as unknown as null })).workshopVisible
    ).toBe("ws-1");
  });

  it("does NOT rewrite a REAL name's spacing, only the TEST is trimmed", () => {
    // The boundary the trim must not cross, and the negative control for the loop above. Deciding a
    // name is ABSENT is this row's business; rewriting one that is PRESENT is not, a row that
    // trimmed the rendered value would be silently editing another service's data, and the two
    // behaviours are one character apart in the source.
    expect(rowText(team({ workshopName: " Summer Accelerator " })).workshopVisible).toBe(
      " Summer Accelerator "
    );
    expect(rowText(team({ workshopName: " x" })).workshopVisible).toBe(" x");
    // A single non-whitespace character is a name, however unlikely, the branch is emptiness, not
    // plausibility.
    expect(rowText(team({ workshopName: "x" })).workshopVisible).toBe("x");
  });

  it("says which kind of gap it is, for assistive technology as well as for the eye", () => {
    // Without the sr-only prefix a screen-reader user hears a bare 20-character id in the
    // column where every other row announces a workshop name.
    const { workshopScreenReader } = rowText(team({ workshopName: null }));
    expect(workshopScreenReader).toBe("Experience name unavailable, experience id ");
    // And it never claims the team has no workshop, it does have one.
    expect(workshopScreenReader).not.toMatch(/no workshop/i);
  });

  it("renders the NAME when there is one, and no fallback copy", () => {
    const { workshopVisible, workshopScreenReader } = rowText(team());
    expect(workshopVisible).toBe("Summer Accelerator");
    expect(workshopScreenReader).toBe("");
  });

  it("the page branches on a TRIMMED LOCAL and states the fallback in the source", () => {
    // ── RE-POINTED. This pinned `{team.workshopName ? (`, the page's form before the trim. It now
    // builds a local and branches on that, so the pin follows it in both halves.
    expect(ROW).toContain("const workshopName = team.workshopName?.trim() ? team.workshopName : null;");
    expect(ROW).toContain("{workshopName ? (");
    // The OLD spelling is asserted ABSENT: branching on the raw field again is exactly the
    // regression that lets `" "` render an apparently blank cell.
    expect(ROW).not.toContain("{team.workshopName ? (");
    // `!= null` / `!== null` would let BOTH `""` and `" "` through, the looseness is the point.
    expect(ROW).not.toContain("team.workshopName != null");
    expect(ROW).not.toContain("team.workshopName !== null");
    // ⚠ THE RENDERED VALUE IS THE UNTRIMMED ONE. `{workshopName}` is `team.workshopName` itself
    // (the local holds the original when it is a real name), so this pin also proves the row does
    // not ship `.trim()` INTO the render and quietly rewrite a stored name.
    expect(ROW).not.toContain("{team.workshopName.trim()}");
    expect(ROW).not.toContain("{workshopName.trim()}");
    // The fallback, and the sr-only phrase that says which kind of gap it is.
    expect(ROW).toContain("{team.workshopId}");
    expect(ROW).toContain("Experience name unavailable, experience id ");
    // Never the two readings that would be false.
    expect(ROW).not.toMatch(/no workshop/i);
  });
});

// ─── The row's link, its glyph, and its date ─────────────────────────────────────

describe("the row's link is the one way in, so it is built by the shared helper", () => {
  it("points at the team's roster tab, through teamTabHref", () => {
    // Eight call sites template this path; a typo produces a 404 on the one link whose whole
    // job is to be the way in. The mirror uses the real helper, so this asserts the shape
    // the helper produces rather than a second copy of it.
    // The LITERAL path, spelled out here rather than compared against another call to
    // teamTabHref, the mirror already uses the real helper, so comparing the two would be a
    // tautology. This is the destination the team workspace's own tab resolves to.
    expect(rowText(team()).href).toBe("/w/ws-1/t/team-1/team");
  });

  it("the page calls teamTabHref rather than templating the path", () => {
    expect(ROW).toContain("href={teamTabHref(team.workshopId, team.id)}");
    // A hand-rolled template literal for this path anywhere in the row is the defect.
    expect(ROW).not.toMatch(/href=\{`\/w\//);
  });

  it("names the link with the TEAM NAME alone and hides the arrow", () => {
    // A screen-reader user tabbing fifty rows hears the accessible name out of context. The
    // arrow says "this goes somewhere" to the eye; announced, it is "right arrow" fifty times.
    expect(rowText(team()).linkAccessibleName).toBe("Alpha Squad");
    expect(ROW).toContain('<span aria-hidden="true"> →</span>');
  });

  it("formats createdAt through formatInstantUtc, and NEVER toLocaleDateString", () => {
    // A hydration-mismatch guard, not a cosmetic preference: this is a client component, so
    // React renders it on the server and again in the browser, and Intl plus the host
    // timezone disagree between the two.
    expect(ROW).toContain("const created = formatInstantUtc(team.createdAt);");
    expect(ROW).not.toContain("toLocaleDateString");
    expect(ROW).not.toContain("toLocaleString");
    expect(TEAMS_TAB).not.toContain("toLocaleDateString");
    expect(TEAMS_TAB).not.toContain("toLocaleString");
  });

  /**
   * ⚠ THE PIN WIDENED FROM TWO COMPONENTS TO THE WHOLE FILE, AND THIS TEST IS WHY IT COULD.
   *
   * It used to be scoped to the two Teams components, with a deliberate
   * `expect(SOURCE).toContain("toLocaleDateString")` guarding the scope: the sibling
   * `ExperienceRow` still had one, and asserting its presence meant nobody could quietly widen
   * this pin by deleting that usage without the test noticing.
   *
   * The redesign did delete it, `ExperienceRow` now formats through `workshopDate`, for the
   * same reason plus a second one (bare `toLocaleDateString` also rendered 8/1/2026 in Seattle
   * and 01/08/2026 in London). So the guard fired exactly as designed, and the correct response
   * is the one it was protecting: widen the scope now that the whole file qualifies.
   *
   * Kept as its own `it` rather than folded above, because "no component in this file formats a
   * date in the reader's locale" is a stronger and different claim than "these two do not".
   */
  it("has no locale-dependent date formatting anywhere in the file", () => {
    expect(SOURCE).not.toContain("toLocaleDateString");
    expect(SOURCE).not.toContain("toLocaleString");
  });

  it("renders NOTHING rather than 'Invalid Date' for an unusable createdAt", () => {
    // formatInstantUtc returns "" for absent/unparseable. An unknown creation date is not a
    // fault in the TEAM, and this row's real content is the name and the count.
    for (const createdAt of ["", "not-a-date", "2026-13-45T99:99:99Z"]) {
      expect(rowText(team({ createdAt })).createdText, createdAt).toBe("");
    }
    expect(rowText(team()).createdText).toBe(" · created 01 Aug 2026 20:47 UTC");
  });
});

// ─── The count line above the list ───────────────────────────────────────────────

/**
 * Mirrors the count line in TeamsTab.
 *
 * With a SERVER-side search the count in hand is the matches on THIS PAGE. There is no total
 * anywhere in the response, so "N of M" would be a number this layer invented.
 */
const countLine = (needle: string, rows: number, page: number) =>
  (needle
    ? `${rows} ${rows === 1 ? "match" : "matches"}`
    : `${rows} ${rows === 1 ? "team" : "teams"}`) + ` · page ${page + 1}`;

describe("the count line claims only what it can honestly claim", () => {
  it("says MATCHES while searching and TEAMS otherwise", () => {
    expect(countLine("alpha", 3, 0)).toBe("3 matches · page 1");
    expect(countLine("", 50, 0)).toBe("50 teams · page 1");
  });

  it("is singular at one, in both moods", () => {
    expect(countLine("alpha", 1, 0)).toBe("1 match · page 1");
    expect(countLine("", 1, 0)).toBe("1 team · page 1");
  });

  it("NEVER renders 'N of M', there is no M to render", () => {
    // "3 of 3" beside a live Next button reads as "3 in total", which is the one misreading
    // this line must not produce: an operator who believes they have seen every team stops
    // looking. Asserted on the produced string AND pinned in the source below.
    for (const [needle, rows, page] of [
      ["alpha", 3, 0],
      ["", 50, 2],
      ["", 0, 0],
    ] as const) {
      expect(countLine(needle, rows, page)).not.toContain(" of ");
    }
  });

  it("shows the page number on page 1 too", () => {
    // The one place this deviates from UsersTab, deliberately: every result set here is
    // paged, so "50 teams" alone invites exactly the "50 in total" misreading above.
    expect(countLine("", 50, 0)).toContain("· page 1");
    expect(countLine("", 50, 3)).toContain("· page 4");
  });

  it("counts zero rows without claiming the platform is empty", () => {
    expect(countLine("", 0, 0)).toBe("0 teams · page 1");
    expect(countLine("zzz", 0, 0)).toBe("0 matches · page 1");
  });

  it("the count EXPRESSION in the page contains no ' of ' and no 'total'", () => {
    // Pinned against the expression rather than the file: the word "of" appears all over the
    // page's prose, and comment-stripping alone would not make a file-wide pin meaningful.
    const open = TEAMS_TAB.indexOf('<p className="text-sm text-ink-subtle">');
    // Sliced FORWARD from the opening tag. `indexOf("</p>")` from zero finds the error box's
    // closing tag, which sits earlier in the component, a slice that came back empty and
    // would have made every `not.toContain` below pass vacuously. Guarded with a non-empty
    // assertion for the same reason.
    const countExpression = TEAMS_TAB.slice(open, TEAMS_TAB.indexOf("</p>", open));
    expect(open).toBeGreaterThan(-1);
    expect(countExpression.length).toBeGreaterThan(50);
    expect(countExpression).toContain('"match" : "matches"');
    expect(countExpression).toContain('"team" : "teams"');
    expect(countExpression).toContain("· page ${page + 1}");
    expect(countExpression).not.toContain(" of ");
    expect(countExpression).not.toMatch(/total/i);
    // Unconditional page number, no `page > 0 &&` guard, unlike UsersTab.
    expect(countExpression).not.toContain("page > 0 &&");
  });
});

describe("the 'search covers this page only' caveat belongs to UsersTab ONLY", () => {
  it("is present on UsersTab, where a browser-side needle makes it TRUE", () => {
    // Asserted first so the absence assertion below cannot pass by the sentence having been
    // deleted from the codebase entirely.
    expect(USERS_TAB).toContain("Search covers this page only");
  });

  it("is ABSENT from the Teams tab, where a server-side search makes it FALSE", () => {
    // Repeating it here would tell the operator the exact opposite of the truth: this needle
    // is applied in the store across the whole table. Region-scoped for exactly that reason
    //, a file-wide `not.toContain` would be asserting a defect into UsersTab.
    expect(TEAMS_TAB).not.toContain("Search covers this page only");
    expect(TEAMS_TAB).not.toContain("this page only");
    // And the empty state says the opposite out loud.
    expect(TEAMS_TAB).toContain("The search covers every page");
  });

  it("drives the truncation notice off the REAL `scopeTruncated` field, never an invented one", () => {
    // ── RE-POINTED BY INVERSION. This was "claims no `truncated` notice, because listDirectory
    // returns no such field" and asserted `TEAMS_TAB` did not contain "truncated" at all. THAT
    // PREMISE IS NOW FALSE: the service reports `scopeTruncated` and
    // the BFF passes it through, so the notice has something behind it.
    //
    // THE PROPERTY WORTH KEEPING IS UNCHANGED, "the notice is driven by the real field and is
    // never invented", so this is inverted into the POSITIVE pin rather than deleted. A warning
    // with nothing behind it still trains an operator to ignore the ones that mean something; what
    // changed is which direction that risk points.
    //
    // ⚠ THE OLD PIN WAS ALSO PASSING FOR THE WRONG REASON, which is why it appeared in neither
    // baseline failure: `not.toContain("truncated")` is CASE-SENSITIVE and the field is
    // `scopeTruncated` with a capital T. The notice had already landed and this assertion could not
    // see it. Both halves below are therefore spelled with the exact field name.
    const router = readCode(TEAM_ROUTER);

    // 1. THE BFF READS IT STRICTLY. `=== true` so a stringy or truthy value cannot read as
    // truncated, and, the direction that matters, an ABSENT field defaults to FALSE. An older
    // service version that does not send it has not told us anything WAS truncated, and a notice
    // raised on silence costs us the one render where it means something.
    expect(router).toContain("scopeTruncated: data.scopeTruncated === true");
    // Never coerced into a claim: `!!`, `??  true` and a bare truthiness read are all the mistake.
    expect(router).not.toMatch(/scopeTruncated:\s*!!/);
    expect(router).not.toMatch(/scopeTruncated:\s*data\.scopeTruncated\s*\?\?\s*true/);
    expect(router).not.toMatch(/scopeTruncated:\s*true\b/);

    // 2. THE TAB RENDERS IT FROM THAT FIELD AND FROM NOTHING ELSE. Guarded on the response, so the
    // notice cannot appear on a page that was never truncated.
    expect(TEAMS_TAB).toContain("{data?.scopeTruncated && (");
    // Never derived from a proxy the operator would not recognise: a full page, a live cursor and a
    // page number are all things this notice must NOT be inferred from, the whole point is that
    // "incomplete" is a fact the SERVICE reports, not one the browser guesses.
    expect(TEAMS_TAB).not.toMatch(/teams\.length\s*[=><]==?\s*\d+\s*&&[\s\S]{0,80}Incomplete/);
    expect(TEAMS_TAB).not.toMatch(/nextCursor\s*&&[\s\S]{0,80}Incomplete/);

    // 3. AND IT SAYS THE THING PAGING CANNOT FIX. This is not a short page: whole experiences are
    // outside the capped scope, so no page and no needle on this screen can reach their teams -
    // which is the misreading ("keep paging, it is in here somewhere") that makes an operator
    // conclude a team does not exist.
    expect(TEAMS_TAB).toContain("Incomplete list");
    expect(TEAMS_TAB).toContain("Paging");
    expect(TEAMS_TAB).toContain("still exists");
  });
});

// ─── The search box's cap ────────────────────────────────────────────────────────

describe("the search box caps input at the BFF's limit rather than throwing at it", () => {
  it("carries maxLength={100} on the input", () => {
    // The procedure's `z.string().trim().max(100)` REJECTS a 101st character, and a tRPC
    // error mid-typing is an error message for a keystroke, on a screen where every other
    // error means something is actually wrong. So the cap is enforced in the box.
    const searchBox = TEAMS_TAB.slice(
      TEAMS_TAB.indexOf('id="team-search"'),
      TEAMS_TAB.indexOf("Search team names")
    );
    expect(searchBox).toContain("maxLength={100}");
  });

  it("matches the BFF cap it exists to stay under, number for number", () => {
    // If either number moves alone the box either throws (cap raised in the box) or
    // truncates silently below what the service would accept (cap raised in the BFF).
    const router = readCode(TEAM_ROUTER);
    expect(router).toContain("search: z.string().trim().max(100).optional()");
    expect(TEAMS_TAB).toContain("maxLength={100}");
  });

  it("names ONLY what the server matches in the placeholder", () => {
    // The teams table stores `workshopId` and nothing else about the workshop, so promising
    // "team or workshop" would have an operator type a workshop name, get nothing, and
    // conclude the team does not exist.
    expect(TEAMS_TAB).toContain('placeholder="Search team names"');
    expect(TEAMS_TAB).toContain('aria-label="Search teams by name"');
    expect(TEAMS_TAB).not.toMatch(/placeholder="[^"]*workshop/i);
  });
});

// ─── Cursor stack semantics ──────────────────────────────────────────────────────

/**
 * Mirrors TeamsTab's cursor STACK. Pure array logic, so this half needs no harness.
 *
 * The cursors are opaque and only ever move forward, so the only way back is the one we came
 * by, which is why this is a stack and not an index.
 *
 * ⚠ `previousPage` MIRRORS THE GUARD, and that correction is the point of this block. It used to
 * be the bare `c.slice(0, -1)`, which was the page's OWN code at the time, and when the page
 * gained `c.length > 1 ? … : c`, this mirror kept exercising the test's stale copy. So the
 * underflow case below was "proving" a defect the page no longer had, while the guard that replaced
 * it had no behavioural coverage at all: only the source pin would have caught its removal, and a
 * source pin cannot tell you what the code DOES.
 *
 * The unguarded form is kept as `previousPageUnguarded`, a NEGATIVE CONTROL, so the underflow the
 * guard prevents is still demonstrated rather than merely described. Both are exercised below, and
 * the pair is what makes the guard's value visible.
 */
const pageOf = (cursors: (string | undefined)[]) => cursors.length - 1;
const nextPage = (cursors: (string | undefined)[], nextCursor: string | undefined) => [
  ...cursors,
  nextCursor,
];
/** THE PAGE'S CURRENT FORM: `setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))`. */
const previousPage = (cursors: (string | undefined)[]) =>
  cursors.length > 1 ? cursors.slice(0, -1) : cursors;
/**
 * THE FORM THE PAGE NO LONGER HAS, retained only to demonstrate what the guard buys. Never used to
 * assert correct behaviour, if this ever matches the source pin again, the guard has been lost.
 */
const previousPageUnguarded = (cursors: (string | undefined)[]) => cursors.slice(0, -1);
const previousDisabled = (cursors: (string | undefined)[]) => pageOf(cursors) === 0;
const nextDisabled = (nextCursor: string | undefined) => !nextCursor;

describe("paging by cursor stack", () => {
  it("starts on page 1 with no cursor at all", () => {
    const cursors: (string | undefined)[] = [undefined];
    expect(pageOf(cursors)).toBe(0);
    expect(cursors[pageOf(cursors)]).toBeUndefined();
  });

  it("PUSHES the server's cursor on Next and sends it back byte-for-byte", () => {
    // Never parsed, sliced or inspected, it encodes the store's pagination key.
    const opaque = "eyJwayI6IlRFQU0jMDEiLCJzayI6Ik1FVEEifQ==";
    const cursors = nextPage([undefined], opaque);
    expect(cursors).toEqual([undefined, opaque]);
    expect(cursors[pageOf(cursors)]).toBe(opaque);
    expect(pageOf(cursors)).toBe(1);
  });

  it("POPS on Previous, returning to the exact cursor that produced that page", () => {
    let cursors: (string | undefined)[] = [undefined];
    cursors = nextPage(cursors, "c1");
    cursors = nextPage(cursors, "c2");
    expect(pageOf(cursors)).toBe(2);

    cursors = previousPage(cursors);
    expect(cursors).toEqual([undefined, "c1"]);
    expect(cursors[pageOf(cursors)]).toBe("c1");

    cursors = previousPage(cursors);
    expect(cursors).toEqual([undefined]);
    expect(pageOf(cursors)).toBe(0);
  });

  it("disables Previous on page 1 and Next on the last page", () => {
    expect(previousDisabled([undefined])).toBe(true);
    expect(previousDisabled([undefined, "c1"])).toBe(false);
    expect(nextDisabled(undefined)).toBe(true);
    expect(nextDisabled("c1")).toBe(false);
    // An empty-string cursor is falsy and therefore reads as "no more pages". The service
    // omits the field on the last page rather than sending "", so this is out of contract
    //, recorded because a `!== undefined` here would page forward with an empty cursor.
    expect(nextDisabled("")).toBe(true);
  });

  it("Previous on page 1 is a NO-OP, because the handler guards as well as the attribute", () => {
    // ── RE-POINTED. This was "UNDERFLOWS if Previous is ever invoked on page 1, the handler has
    // no guard", documenting an absence. The absence is CLOSED: the handler is now
    // `setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))`, so `disabled={page === 0}` is the
    // first line of defence and this is the second, in the only place a unit test can reach.
    //
    // Returning `c` UNCHANGED matters beyond not underflowing: React bails out of a state update to
    // an identical value, so a stray click costs no render and no refetch.
    const guarded = previousPage([undefined]);
    expect(guarded).toEqual([undefined]);
    expect(pageOf(guarded)).toBe(0);
    // The SAME ARRAY REFERENCE, which is what makes React's bail-out apply, a fresh `[...c]` would
    // be equal by value and still schedule a render.
    const stack: (string | undefined)[] = [undefined];
    expect(previousPage(stack)).toBe(stack);
  });

  it("NEGATIVE CONTROL: the unguarded form underflows to page -1, which is what the guard prevents", () => {
    // ⚠ NOT A PIN ON THE PAGE, `previousPageUnguarded` is deliberately NOT the page's code. Kept
    // so the guard's value is demonstrated rather than asserted on trust: without it a one-element
    // stack yields `[]`, `page` becomes -1, `cursors[-1]` is undefined, and the query refetches page
    // 1's rows while the count line reads "· page 0", a screen that disagrees with itself.
    //
    // This is why the mirror above had to be corrected: while THIS was the mirror, the suite was
    // exercising its own stale copy of a handler the page had already fixed.
    const underflowed = previousPageUnguarded([undefined]);
    expect(underflowed).toEqual([]);
    expect(pageOf(underflowed)).toBe(-1);
    expect(underflowed[pageOf(underflowed)]).toBeUndefined();
    // And the guarded form differs on exactly this input, the two are not accidentally identical,
    // which is the whole basis for keeping both.
    expect(previousPage([undefined])).not.toEqual(underflowed);
  });

  it("guarded and unguarded agree on EVERY stack of two or more, the guard changes only page 1", () => {
    // The other half of the negative control: a guard that changed ordinary paging would be a
    // regression wearing a fix. Asserted across depths so "return c always" (which passes the no-op
    // test above) fails here.
    for (const stack of [
      [undefined, "c1"],
      [undefined, "c1", "c2"],
      [undefined, "c1", "c2", "c3"],
    ] as (string | undefined)[][]) {
      expect(previousPage(stack), JSON.stringify(stack)).toEqual(previousPageUnguarded(stack));
      expect(previousPage(stack), JSON.stringify(stack)).toHaveLength(stack.length - 1);
    }
  });

  it("the page wires both handlers to the stack, and both disabled attributes", () => {
    expect(TEAMS_TAB).toContain("const page = cursors.length - 1;");
    // ── RE-POINTED. This pinned the bare `setCursors((c) => c.slice(0, -1))`, which is the form the
    // page HAD. The guard is now in the handler, so the pin follows it, and the old spelling is
    // asserted ABSENT, because it is a substring of nothing in the new form and its reappearance
    // would mean the guard was reverted.
    expect(TEAMS_TAB).toContain("setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))");
    expect(TEAMS_TAB).not.toContain("setCursors((c) => c.slice(0, -1))");
    expect(TEAMS_TAB).toContain("setCursors((c) => [...c, data?.nextCursor])");
    // `disabled` stays pinned: it is the FIRST line of defence and a DOM property this suite
    // (environment:"node", no jsdom) cannot exercise, so the handler guard does not replace it.
    expect(TEAMS_TAB).toContain("disabled={page === 0}");
    expect(TEAMS_TAB).toContain("disabled={!data?.nextCursor}");
    // The cursor is read out of the stack at the current page, never derived arithmetically.
    expect(TEAMS_TAB).toContain("cursor: cursors[page],");
  });
});

// ─── The debounce, and the reset that keeps cursors and needles in step ──────────

/**
 * Mirrors the two effects in TeamsTab: the 300ms debounce onto `debouncedSearch`, and the
 * cursor-stack reset keyed on that debounced value.
 *
 * Driven by vitest's FAKE TIMERS, a test clock, never a sleep. Every advance is explicit,
 * so this is deterministic and there is no seed to record.
 */
function searchBoxHarness() {
  let search = "";
  let debouncedSearch = "";
  let cursors: (string | undefined)[] = [undefined];
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Every request the query would have issued, so a wasted one is visible. */
  const requests: { cursor: string | undefined; search: string | undefined }[] = [];

  const commitDebounced = (value: string) => {
    // React bails out of a state update to an identical value, so the effect keyed on
    // `[debouncedSearch]` does NOT re-run and the stack is not reset. Modelled, because a
    // reset on every keystroke would throw an operator back to page 1 for typing a
    // character and deleting it.
    if (value === debouncedSearch) return;
    debouncedSearch = value;
    cursors = [undefined];
  };

  const issue = () =>
    requests.push({ cursor: cursors[pageOf(cursors)], search: debouncedSearch || undefined });

  issue(); // the first render

  return {
    /** One keystroke, or a paste. Re-runs the debounce effect: cleanup, then a new timer. */
    type(value: string) {
      if (timer) clearTimeout(timer);
      search = value;
      const captured = value;
      timer = setTimeout(() => {
        commitDebounced(captured.trim());
        issue();
      }, 300);
    },
    next(cursor: string | undefined) {
      cursors = nextPage(cursors, cursor);
      issue();
    },
    previous() {
      cursors = previousPage(cursors);
      issue();
    },
    get state() {
      return { search, debouncedSearch, cursors: [...cursors], page: pageOf(cursors) };
    },
    get requests() {
      return requests;
    },
  };
}

describe("the debounced needle, and the cursor reset it triggers", () => {
  afterEach(() => vi.useRealTimers());

  it("sends nothing until the box has been quiet for 300ms", () => {
    // Un-debounced, every keystroke fires a filtered table Scan.
    vi.useFakeTimers();
    const h = searchBoxHarness();
    h.type("a");
    h.type("al");
    h.type("alp");
    vi.advanceTimersByTime(299);
    expect(h.state.debouncedSearch).toBe("");
    expect(h.requests).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(h.state.debouncedSearch).toBe("alp");
    // ONE request for three keystrokes, the whole point of the debounce.
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]).toEqual({ cursor: undefined, search: "alp" });
  });

  it("RESETS the cursor stack when a new needle commits", () => {
    // The correctness case, not a convenience: those cursors point into a DIFFERENT scan.
    // Reusing them pages through the wrong result set, the operator sees rows that are
    // neither the old result nor the new one, with no error anywhere on screen.
    vi.useFakeTimers();
    const h = searchBoxHarness();
    h.next("c1");
    h.next("c2");
    expect(h.state.page).toBe(2);

    h.type("alpha");
    vi.advanceTimersByTime(300);

    expect(h.state.cursors).toEqual([undefined]);
    expect(h.state.page).toBe(0);
    expect(h.requests.at(-1)).toEqual({ cursor: undefined, search: "alpha" });
  });

  it("resets on CLEARING the box as well as on typing into it", () => {
    // The other direction, and the one an operator hits more often: clearing a needle on
    // page 3 of the filtered results must not ask for page 3 of the unfiltered scan.
    vi.useFakeTimers();
    const h = searchBoxHarness();
    h.type("alpha");
    vi.advanceTimersByTime(300);
    h.next("c1");
    expect(h.state.page).toBe(1);

    h.type("");
    vi.advanceTimersByTime(300);
    expect(h.state.debouncedSearch).toBe("");
    expect(h.state.cursors).toEqual([undefined]);
    expect(h.requests.at(-1)).toEqual({ cursor: undefined, search: undefined });
  });

  it("TRIMS the needle, so whitespace-only is the same as no search at all", () => {
    // `search.trim()` at the debounce, then `debouncedSearch || undefined` at the query, so
    // a box holding three spaces sends no `search` parameter and the count line says
    // "teams" rather than "matches". A space-only filter that matched everything would
    // still be reported as a search result set.
    vi.useFakeTimers();
    const h = searchBoxHarness();
    h.type("   ");
    vi.advanceTimersByTime(300);

    expect(h.state.search).toBe("   ");
    expect(h.state.debouncedSearch).toBe("");
    expect(h.requests.at(-1)?.search).toBeUndefined();
    expect(countLine(h.state.debouncedSearch, 50, 0)).toBe("50 teams · page 1");
  });

  it("does NOT reset the stack when the committed needle is unchanged", () => {
    // Typing a character and deleting it inside one debounce window leaves the needle
    // identical, and React bails out of the state update, so the operator stays on page 3
    // instead of being thrown back to page 1 for having touched the keyboard.
    vi.useFakeTimers();
    const h = searchBoxHarness();
    h.type("alpha");
    vi.advanceTimersByTime(300);
    h.next("c1");
    h.next("c2");
    expect(h.state.page).toBe(2);

    h.type("alphax");
    h.type("alpha");
    vi.advanceTimersByTime(300);

    expect(h.state.debouncedSearch).toBe("alpha");
    expect(h.state.page).toBe(2);
  });

  it("leaves ONE window where the OLD cursor travels with the NEW needle", () => {
    // ⚠ DOCUMENTING the known cost the page's own comment admits: the reset is an EFFECT,
    // so between the needle committing and the reset committing there is one render with
    // the new search and the old cursor. It cannot paint wrong rows (that query has no
    // cached data, so the frame shows the loading state), but it IS one wasted filtered
    // Scan per needle change made away from page 1. Asserted so it cannot get worse
    // silently, and reported as a known cost rather than as a defect.
    vi.useFakeTimers();
    const h = searchBoxHarness();
    h.next("c1");
    h.next("c2");
    const before = h.requests.length;

    h.type("alpha");
    vi.advanceTimersByTime(300);

    // In the real page the intermediate render issues {cursor: "c2", search: "alpha"}; this
    // mirror commits both effects together, so what is pinned is the SHAPE of the code that
    // produces the window, below.
    expect(h.requests.length).toBe(before + 1);
    expect(h.requests.at(-1)).toEqual({ cursor: undefined, search: "alpha" });
  });

  it("the page debounces at 300ms and resets the stack in an effect on the DEBOUNCED value", () => {
    expect(TEAMS_TAB).toContain("setTimeout(() => setDebouncedSearch(search.trim()), 300)");
    // Cleanup, or every keystroke leaves a live timer that fires a Scan.
    expect(TEAMS_TAB).toContain("return () => clearTimeout(t);");
    expect(TEAMS_TAB).toContain("}, [search]);");
    expect(TEAMS_TAB).toContain("setCursors([undefined]);");
    // Keyed on the DEBOUNCED needle, not the raw box, once per request, not per keystroke.
    expect(TEAMS_TAB).toContain("}, [debouncedSearch]);");
    // And the needle is omitted from the request when empty.
    expect(TEAMS_TAB).toContain("search: debouncedSearch || undefined,");
  });
});

// ─── What the tab does NOT do ────────────────────────────────────────────────────

describe("the directory stays a read-only finding aid", () => {
  it("applies NO client-side filter over the rows the server returned", () => {
    // A second, narrower rule in the browser could silently drop a row the store considered
    // a match, and would find nobody past page 1, which on a small table looks exactly
    // like a working feature.
    expect(TEAMS_TAB).toContain("const needle = debouncedSearch;");
    expect(TEAMS_TAB).not.toMatch(/teams\.filter\(/);
    expect(TEAMS_TAB).not.toMatch(/\.toLowerCase\(\)\.includes\(/);
  });

  it("renders the service's error rather than an empty list", () => {
    // The 503 that matters is DIRECTORY_SCOPE_UNAVAILABLE: an empty directory is
    // indistinguishable from a correct one, so a swallowed failure renders a plausible,
    // wrong, empty page with no error anywhere on screen.
    expect(TEAMS_TAB).toContain("if (error) {");
    expect(TEAMS_TAB).toContain("{error.message}");
  });

  it("carries no mutation, dialog or destructive control at all", () => {
    expect(TEAMS_TAB).not.toContain("useMutation");
    expect(TEAMS_TAB).not.toContain("ConfirmActionDialog");
    expect(TEAMS_TAB).not.toContain("ActionOutcome");
    expect(ROW).not.toContain("useMutation");
    expect(ROW).not.toContain("onClick");
  });

  it("says the SCOPE out loud, because there is deliberately no scope picker", () => {
    // "Why can't I see team X" is otherwise a support question with no answer on screen.
    expect(TEAMS_TAB).toContain("a facilitator sees the teams in");
    expect(TEAMS_TAB).toContain("read-only directory");
    // No picker: `listDirectory` takes no scope parameter, so a control here would change
    // nothing and invite the operator to conclude a missing team does not exist.
    expect(TEAMS_TAB).not.toContain("<select");
  });

  it("distinguishes 'no matches' from 'no teams'", () => {
    // "No teams" under an active search would read as "the platform has no teams".
    expect(TEAMS_TAB).toContain('"No teams match your search." : "No teams to show."');
  });
});
