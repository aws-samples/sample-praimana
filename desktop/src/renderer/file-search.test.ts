// ── ⚠ SEARCH FOR A FILE, WITHOUT FREEZING THE APP ────────────────────────────────────────
//
// The interesting part is not the input box — it is that the only recursive filesystem walk in this app is
// now triggered by TYPING. Every bound below exists because an unbounded walk over a real repository is a UI
// freeze and a memory spike caused by holding down a key.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const handler = strip(readFileSync(join(__dirname, "..", "main", "handlers", "files.ts"), "utf8"));
const ui = strip(readFileSync(join(__dirname, "components", "FileSearch.tsx"), "utf8"));
const sidebar = strip(readFileSync(join(__dirname, "components", "Sidebar.tsx"), "utf8"));
/** The search box moved here from the sidebar, so the mount assertions read App now. */
const app = strip(readFileSync(join(__dirname, "App.tsx"), "utf8"));

const walk = handler.slice(handler.indexOf('"files:searchFiles"'));

describe("⚠ the walk is bounded on every axis", () => {
  it.each([
    ["results returned", /MAX_RESULTS = \d+/],
    ["entries examined", /MAX_VISITED = [\d_]+/],
    ["recursion depth", /MAX_DEPTH = \d+/],
  ])("caps %s", (_what, pattern) => {
    expect(walk).toMatch(pattern);
  });

  it("stops walking once the result list is full", () => {
    expect(walk).toMatch(/files\.length >= MAX_RESULTS/);
  });

  /** Shed load OBSERVABLY: a capped list must not be presented as a complete one. */
  it("reports that a capped list is partial", () => {
    expect(walk).toMatch(/truncated = true/);
    expect(walk).toMatch(/return \{ files, truncated \}/);
    expect(ui, "and the UI says so").toMatch(/Narrow the search/);
  });

  /**
   * ⚠ THE PATH GUARD IS CHECKED TWICE, and the second time is the one that matters: a symlink INSIDE the
   * project pointing out of it would otherwise let a search list — and then open — arbitrary files on the
   * machine. A lexical check on the root cannot see that.
   *
   * ⚠ AND THE ROOT CHECK IS THE REAL-PATH VARIANT TOO NOW. This route was never exploitable — the
   * per-hit check below already refused a symlinked-out result — but the root was the last lexical
   * `assertWithinProject` on the project boundary once the three symlink-unsafe handlers
   * were converted. Both layers stay; what changed is that there is no longer an entry
   * point on this boundary that decides confinement textually.
   */
  it("guards the root and every candidate", () => {
    expect(walk).toMatch(/assertRealPathWithinProject\(rootPath, \{ mustExist: true \}\)/);
    /**
     * ⚠ THE CANDIDATE CHECK IS THE REAL-PATH ONE NOW, and the change is the point rather than a
     * rename. This walk FOLLOWS symlinks (`readdirSync` does), and the lexical `isWithinProject` it
     * used to call cannot see that a hit resolves out of the project — so one link in a tree turned
     * search-then-open into a general-purpose file reader, with `files:readFile` (also lexical at the
     * time) completing the pair. Both are real-path checked now, and they must AGREE: a result this
     * lists is a path the renderer will ask to read next.
     */
    expect(walk, "each hit re-checked after resolution").toMatch(/isRealPathWithinProject\(full\)/);
  });

  it("skips the directories a recursive walk must never enter", () => {
    for (const dir of ["node_modules", ".git", "dist", ".next"]) {
      expect(walk, `${dir} must be skipped`).toContain(`"${dir}"`);
    }
  });

  /** An unreadable directory is one permission error, not a failed search. */
  it("survives a directory it cannot read", () => {
    expect(walk).toMatch(/catch \{[\s\S]{0,120}?return;/);
  });

  /** An empty query is no question, so it must not become "walk the whole project". */
  it("returns nothing for an empty query", () => {
    expect(walk).toMatch(/if \(!needle\) return \{ files: \[\], truncated: false \}/);
  });

  /**
   * Matching the RELATIVE PATH, not just the basename: "api/routes" should find `src/api/routes.ts`, and a
   * project with twenty `index.ts` files is unusable when only the name is matched.
   */
  it("matches the relative path", () => {
    expect(walk).toMatch(/relPath\.toLowerCase\(\)\.includes\(needle\)/);
  });
});

describe("⚠ typing does not fire a walk per keystroke", () => {
  it("debounces before searching", () => {
    expect(ui).toMatch(/DEBOUNCE_MS = \d+/);
    expect(ui).toMatch(/setTimeout\(/);
    expect(ui, "and cancels the pending one").toMatch(/clearTimeout\(timer\)/);
  });

  /**
   * ⚠ AN OUT-OF-ORDER ANSWER IS THE SUBTLE ONE. Two walks can be in flight when typing resumes, and the
   * slower may land last — showing results for "comp" under the query "components". A sequence number means
   * only the newest request may write state.
   */
  it("ignores a stale response", () => {
    expect(ui).toMatch(/seq = useRef\(0\)/);
    expect(ui).toMatch(/if \(mine !== seq\.current\) return/);
  });

  it("caps the height of the result list", () => {
    // The results sit at the BOTTOM of the panel; an unbounded list would push the tree off the top.
    expect(ui).toMatch(/max-h-\d+ overflow-y-auto/);
  });

  it("announces the result count to assistive tech", () => {
    expect(ui).toMatch(/role="status"/);
    expect(ui).toMatch(/aria-live="polite"/);
  });

  /** A list of twenty identical `index.ts` rows is unusable, so each row shows its directory. */
  it("shows each hit's directory, not only its name", () => {
    /**
     * ⚠ THE MECHANISM CHANGED, THE GUARANTEE DID NOT. This asserted a literal
     * `relPath.split("/").slice(0, -1)`, which is exactly the expression that breaks on Windows: a
     * `\`-separated path has no "/" to split on, so `slice(0, -1)` of a one-element array is empty and
     * every hit showed "." instead of its folder. `parentDirOf` accepts both separators.
     */
    expect(ui).toMatch(/parentDirOf\(hit\.relPath\)/);
    // Still falls back to "." when the hit is at the project root, which has no parent to show.
    expect(ui).toContain('|| "."');
  });
});

describe("⚠ it is mounted in the top bar, not the sidebar", () => {
  /**
   * ⚠ THE LOCATION CHANGED, so these assertions changed with it. First it was low in the project's left
   * panel; then it moved to match a reference layout, which has it in a
   * full-width bar above the open-file tabs. The old assertions pinned the sidebar mount, which is now the
   * defect rather than the contract.
   */
  it("is mounted in the top strip and no longer in the sidebar", () => {
    expect(app, "the strip owns it now").toMatch(/<FileSearch\s+rootPath=\{activeProject\.path\}/);
    expect(sidebar, "the sidebar must not mount a second copy").not.toContain("<FileSearch");
    expect(sidebar, "and must not import one").not.toMatch(/import \{ FileSearch \}/);
  });

  /**
   * ⚠ ABOVE THE TABS AND ABOVE `<main>`. Inside the editor column it would only exist once a file was already
   * open, which is backwards for the control you use to find one.
   */
  /**
   * ⚠ IN THE WINDOW TITLE BAR — the desktop title bar that holds the close, minimize and expand buttons,
   * centred in it.
   *
   * This has moved three times, so the assertion is about the CURRENT home and the two it must not slip back
   * to: the sidebar (too narrow) and a strip of its own below the title bar (a row of height for one field).
   */
  it("is mounted in the title-bar strip, ahead of everything else", () => {
    const search = app.indexOf("<FileSearch");
    const titleBar = app.indexOf('WebkitAppRegion: "drag"');
    const main = app.indexOf("<main");

    expect(search).toBeGreaterThan(-1);
    expect(search, "after the drag region opens").toBeGreaterThan(titleBar);
    expect(search, "and before the panes").toBeLessThan(main);
    /**
     * ⚠ EXACTLY ONE MOUNT. My first attempt here asserted `app` equalled `app` with the component removed,
     * which is false whenever the component exists — a broken assertion that failed on correct code. Counting
     * is what was meant: a leftover copy in a strip of its own would be two search boxes, and two would fight
     * over the same `file-search` element id.
     */
    expect([...app.matchAll(/<FileSearch/g)].length, "one search box, not two").toBe(1);
  });

  /**
   * ⚠ `no-drag` IS WHAT MAKES THE FIELD USABLE. Inside a `WebkitAppRegion: "drag"` strip the OS takes the
   * mouse to move the window, so without this the box cannot be clicked, focused or selected in — it would
   * look like a search box and behave like a window handle.
   */
  it("opts the field out of the window drag region", () => {
    const search = app.indexOf("<FileSearch");
    const wrapper = app.lastIndexOf('WebkitAppRegion: "no-drag"', search);

    expect(wrapper, "the field's own wrapper must opt out").toBeGreaterThan(app.indexOf('WebkitAppRegion: "drag"'));
  });

  /**
   * ⚠ CENTRED IN WHAT IS GENUINELY FREE, not in the flex row. `titleBarStyle: "hiddenInset"` means macOS
   * draws close/minimise/zoom at the left inset — the OS's pixels — and the status pill sits at the right,
   * changing width with its text. Both ends are reserved so the field cannot slide under either.
   */
  it("reserves the traffic lights and the status pill, then centres between them", () => {
    const band = app.slice(app.indexOf("pointer-events-none absolute inset-y-0"), app.indexOf("<FileSearch"));

    expect(band, "clear of the traffic lights").toMatch(/left-\[\d+px\]/);
    expect(band, "clear of the status pill").toMatch(/right-\[\d+px\]/);
    expect(band).toContain("justify-center");
  });

  /**
   * ⚠ AND THE BAND MUST NOT EAT THE DRAG. It spans most of the title bar; without `pointer-events-none` the
   * window would only be draggable at its edges, which is a worse bug than the one being fixed.
   */
  it("lets the drag through everywhere except the field", () => {
    const band = app.slice(app.indexOf("pointer-events-none absolute inset-y-0"), app.indexOf("<FileSearch"));

    expect(band).toContain("pointer-events-none");
    expect(band, "and the field itself takes them back").toContain("pointer-events-auto");
  });

  /** Gated on a PROJECT, since there is nothing to search without one. */
  it("appears whenever a project is open", () => {
    /**
     * ⚠ ASSERTED BY THE BINDING, NOT BY PROXIMITY. This was
     * `/\{activeProject && \([\s\S]{0,400}?<FileSearch/` — a 400-character budget between the guard and the
     * element, which widening the profile chip tipped over at 447 without changing the behaviour at all.
     * A character count is not the property.
     *
     * `rootPath={activeProject.path}` IS the property, and it is stronger: `activeProject` is nullable, so
     * TypeScript only permits `.path` where the guard has narrowed it. The compiler enforces what the
     * regex was approximating.
     */
    expect(app).toMatch(/\{activeProject && \(/);
    expect(app).toMatch(/<FileSearch rootPath=\{activeProject\.path\}/);
  });

  /**
   * ⚠ THE RESULTS MUST OUTRANK THE PANES. The title bar is now the FIRST element in the window, so everything
   * the dropdown has to cover comes after it in the DOM and would paint on top. The panes use `z-10` and
   * `z-20` internally and none of them creates a stacking context, so they compare directly with this.
   */
  it("floats its results above the panes", () => {
    const source = strip(readFileSync(join(__dirname, "components", "FileSearch.tsx"), "utf8"));
    const barBranch = source.slice(source.indexOf("isBar"));

    expect(barBranch).toContain("absolute");
    expect(barBranch).toMatch(/top-full/);
    /**
     * ⚠ EVERY z-index IN THE BRANCH, NOT THE FIRST. The bar renders two floating things — the result list and
     * the "No matching files" note — and taking the first match let a mutation drop the LIST to `z-10` while
     * the note kept `z-50`, so the assertion passed with the results hidden behind the panes.
     */
    const zIndexes = [...barBranch.matchAll(/z-(\d+)/g)].map((m) => Number(m[1]));

    expect(zIndexes.length, "the floating elements must carry a z-index").toBeGreaterThanOrEqual(2);
    for (const z of zIndexes) expect(z, "above the panes' z-20").toBeGreaterThan(20);
  });

  /**
   * ⚠ THE SAME HANDLER THE TREE USES, which is what makes the tab rules apply to a searched file too. Wiring
   * it straight to `setTabs` would bypass `openTab` — and with it the cap and the refusal to evict a file with
   * unsaved changes.
   */
  it("opens the file through the same handler the tree uses", () => {
    expect(app).toMatch(/<FileSearch[\s\S]{0,80}?onOpenFile=\{handleOpenFile\}/);
    expect(app, "the tree uses it too").toMatch(/onOpenFile=\{handleOpenFile\}/);
  });
});

// ── ⚠ OPENING A RESULT ENDS THE SEARCH ───────────────────────────────────────────────────
//
// The list stayed open over the very file it had just opened — so the thing you asked to see was covered by
// the list you asked it from — and the next search began by selecting and deleting the old query.
describe("⚠ selecting a result closes and clears", () => {
  const source = strip(readFileSync(join(__dirname, "components", "FileSearch.tsx"), "utf8"));
  /** The row's own handler, not the clear button's. */
  const rowHandler = source.slice(source.indexOf("onOpenFile?.(hit.path)"), source.indexOf("title={hit.relPath}"));

  it("clears the query, which is what closes the list", () => {
    expect(rowHandler, "the list is rendered from the query").toContain('setQuery("")');
  });

  /**
   * ⚠ AND BLURS. In the title bar a focused-but-empty field keeps its ring over the window chrome, which
   * reads as "still searching" when the search is finished.
   */
  it("takes focus off the field", () => {
    expect(rowHandler).toMatch(/inputRef\.current\?\.blur\(\)/);
  });

  /** The file must still open — clearing is in addition to the callback, not instead of it. */
  it("still opens the file", () => {
    expect(rowHandler).toContain("onOpenFile?.(hit.path)");
    const open = rowHandler.indexOf("onOpenFile?.(hit.path)");
    const clear = rowHandler.indexOf('setQuery("")');
    expect(open, "opened before the state is torn down").toBeLessThan(clear);
  });
});
