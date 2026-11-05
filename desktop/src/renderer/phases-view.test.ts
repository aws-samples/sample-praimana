import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  PHASE_LINK_FIELDS,
  linkFieldsFor,
  encodeLinks,
  decodeLinks,
  hasAnyLink,
  isSafeHttpUrl,
} from "@praimana/shared";

/**
 * The phase screen's two behavioural rules, and the dead button that is not coming back.
 *
 * ── WHY SOURCE ASSERTIONS RATHER THAN RENDERING ──
 *
 * This package has no jsdom/RTL setup — every existing renderer test
 * (option-buttons, brand-parity) is either pure logic or a source read. Adding a DOM
 * harness for one component is a bigger change than the component, so these follow
 * the file's own convention: the rules that would silently regress are asserted
 * against the source, and the pure mapping is reimplemented and exercised directly.
 */

const SRC = join(__dirname, "components", "PhasesView.tsx");
const src = readFileSync(SRC, "utf8");

/**
 * ⚠ NO LONGER A HAND-WRITTEN MIRROR. This file used to reimplement `linkConfigFor` in three lines, because the
 * rule lived inside a `.tsx` that this package cannot import without a DOM transform — and the source
 * assertions below existed to stop the copy drifting from the real table.
 *
 * The rule now lives in `@praimana/shared` (constants/phase-links.ts), a plain module, so the tests call the REAL function. That is
 * strictly better: a mirror can agree with its assertions and still disagree with the component.
 */
const isLinkPhase = (name: string) => linkFieldsFor({ name }) !== null;

describe("which phases take a LINK instead of notes", () => {
  it("⚠ DEMO TAKES LINKS AND BUILD NO LONGER DOES", () => {
    /**
     * Build asked for the deployed application URL, which it cannot answer — nothing is deployed for most of a
     * workshop, so the field reported "No live application URL yet" for most of its life. Build's real
     * artefacts are the documents `TeamDocs` renders in that phase; Demo is when a team presents a running
     * thing, so that is where the question belongs.
     */
    expect(isLinkPhase("Demo")).toBe(true);
    expect(isLinkPhase("Build"), "Build takes free-form notes now").toBe(false);
  });

  it("Demo asks for BOTH the app URL and the recording", () => {
    /**
     * A phase stores ONE content string, and Demo already asked for a video link — so the choice was to
     * keep both in that one field rather than lose either. Both labels are asserted because dropping one
     * silently is the likeliest way this regresses.
     */
    const fields = linkFieldsFor({ name: "Demo" })!;
    expect(fields.map((f) => f.label)).toEqual(["Live application URL", "Demo video link"]);
  });

  it("Ideation and the other phases take free-form notes", () => {
    for (const n of ["Ideation", "Problem", "Architecture", "Retrospective", "Build"]) {
      expect(isLinkPhase(n), `${n} should take notes`).toBe(false);
    }
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    // The names come from workshop data a facilitator typed, not from a constant, so
    // "build ", "BUILD" and "Build" all have to land on the same branch.
    for (const n of ["demo", "DEMO", "  Demo  ", "dEmO"]) {
      expect(isLinkPhase(n), `${JSON.stringify(n)} should be a link phase`).toBe(true);
    }
  });

  it("does not match a phase that merely CONTAINS build or demo", () => {
    // Substring matching would wrongly turn "Demo Prep" or "Rebuild" into a URL field
    // and hide the textarea a team needed.
    expect(isLinkPhase("Demo Prep")).toBe(false);
    expect(isLinkPhase("Rebuild")).toBe(false);
    expect(isLinkPhase("Build & Demo")).toBe(false);
    expect(isLinkPhase("Demonstration")).toBe(false);
  });

  it("the table is keyed by NAME, not by phase id", () => {
    // Phase ids are per-workshop ULIDs, so an id-keyed table would work in dev and
    // silently fall back to a textarea in every other workshop. Asserted against the real module now.
    expect(Object.keys(PHASE_LINK_FIELDS)).toEqual(["demo"]);
  });

  it("⚠ ONLY DEMO IS A LINK PHASE, and nothing re-adds Build", () => {
    /**
     * Was a regex over `const LINK_PHASES` in the component; the table is importable now, so this reads the
     * real object. A third key here means someone added a link phase without deciding whether it can actually
     * answer the question — which is exactly the mistake Build was.
     */
    expect(Object.keys(PHASE_LINK_FIELDS)).toEqual([
      "demo",
    ]);
  });
});

describe("⚠ TWO LINKS IN ONE STORED FIELD", () => {
  /**
   * A phase stores ONE `content` string and Demo now needs two URLs, so they share it. The encoding is the part
   * that can actually be wrong — and the LEGACY case is the part that would bite a real workshop, because rows
   * written before this change are in the database right now.
   */
  const fields = linkFieldsFor({ name: "Demo" })!;

  it("round-trips both values", () => {
    const encoded = encodeLinks(fields, {
      app: "https://app.example.com",
      video: "https://rec.example.com/1",
    });
    expect(decodeLinks(fields, encoded)).toEqual({
      app: "https://app.example.com",
      video: "https://rec.example.com/1",
    });
  });

  it("writes NO line for a blank field", () => {
    // Every other consumer of a phase's content renders it as prose — the portal, the insights prompt — so an
    // empty `video:` line would show up there as a label with nothing after it.
    expect(encodeLinks(fields, { app: "https://a.example.com", video: "" })).toBe(
      "app: https://a.example.com"
    );
    expect(encodeLinks(fields, { app: "", video: "" })).toBe("");
  });

  it("trims whitespace, including a pasted trailing newline", () => {
    expect(encodeLinks(fields, { app: "  https://a.example.com \n", video: "" })).toBe(
      "app: https://a.example.com"
    );
  });

  it("⚠ TREATS A PRE-CHANGE BARE URL AS THE FIRST FIELD", () => {
    /**
     * THE ASSERTION THAT MATTERS MOST HERE. Before this change Build and Demo stored a bare URL with no prefix.
     * Those rows exist. Without this, every one of them would vanish from the form the moment this shipped —
     * the participant would open Demo and find an empty box where their link used to be.
     */
    expect(decodeLinks(fields, "https://old-app.example.com")).toEqual({
      app: "https://old-app.example.com",
      video: "",
    });
  });

  it("does not mistake a PARTIALLY prefixed value for legacy content", () => {
    /**
     * Someone hand-edits one line, or an older version wrote only `app:`. The legacy fallback must not then
     * swallow line one as a bare URL — which is why it is guarded on "no prefix matched ANYWHERE" rather than
     * on "line 0 has no prefix".
     */
    expect(decodeLinks(fields, "app: https://a.example.com\nsome stray note")).toEqual({
      app: "https://a.example.com",
      video: "",
    });
  });

  it("ignores prose rather than pre-filling a URL box with half a sentence", () => {
    // Demo was a free-text field for some teams. Empty inputs are the honest result.
    const decoded = decodeLinks(fields, "We will demo the checkout flow end to end.");
    // The first line becomes the app field ONLY because there is no prefix anywhere — and that is the legacy
    // rule above. What must NOT happen is a second field inventing a value.
    expect(decoded.video).toBe("");
  });

  it("survives CRLF, which a pasted value carries", () => {
    // A CR retained inside the value would end up in the anchor's href and break the link.
    const decoded = decodeLinks(fields, "app: https://a.example.com\r\nvideo: https://v.example.com\r\n");
    expect(decoded.app).toBe("https://a.example.com");
    expect(decoded.video).toBe("https://v.example.com");
  });

  it("ignores an unrecognised prefix", () => {
    expect(decodeLinks(fields, "app: https://a.example.com\nslides: https://s.example.com")).toEqual({
      app: "https://a.example.com",
      video: "",
    });
  });

  it("returns empty values for empty or missing content", () => {
    for (const content of ["", "   ", null, undefined]) {
      expect(decodeLinks(fields, content)).toEqual({ app: "", video: "" });
    }
  });

  it("hasAnyLink distinguishes 'nothing yet' from 'something stored'", () => {
    /**
     * This is what decides between showing the links and showing the "nothing yet" prompt. Deriving that from
     * `phase.content` being non-empty would show an EMPTY link list for a Demo phase whose content is prose
     * from before the change.
     */
    expect(hasAnyLink({ app: "", video: "" })).toBe(false);
    expect(hasAnyLink({ app: "   ", video: "" })).toBe(false);
    expect(hasAnyLink({ app: "", video: "https://v.example.com" })).toBe(true);
  });
});

describe("⚠ A STORED URL CANNOT EXECUTE", () => {
  /**
   * A REAL HOLE THIS CLOSES. The previous code put
   * `phase.content` straight into `href`, so a participant who stored a `javascript:` URL had it run in the
   * Electron renderer's context when a facilitator clicked it — same origin as the app, with the preload bridge
   * in reach.
   */
  it("allows http and https", () => {
    expect(isSafeHttpUrl("https://app.example.com")).toBe(true);
    expect(isSafeHttpUrl("http://localhost:3000")).toBe(true);
    expect(isSafeHttpUrl("  https://app.example.com  ")).toBe(true);
  });

  it("REFUSES javascript:, data: and file:", () => {
    for (const bad of [
      "javascript:alert(document.cookie)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
    ]) {
      expect(isSafeHttpUrl(bad), `${bad} must not be clickable`).toBe(false);
    }
  });

  it("refuses anything that is not a URL at all", () => {
    for (const bad of ["", "   ", "not a url", "app.example.com", "//example.com"]) {
      expect(isSafeHttpUrl(bad)).toBe(false);
    }
  });

  it("the component actually USES the guard", () => {
    // The check existing is not the same as the render calling it — and only the second one protects anybody.
    expect(src).toMatch(/isSafeHttpUrl\(value\)/);
    expect(src, "and no raw content in an href").not.toMatch(/href=\{phase\.content/);
  });
});

describe("the Generate button is gone and stays gone", () => {
  it("no 'Generate from chat' button remains", () => {
    // It POSTed to a route that has never existed, so every click was a 404 shown as
    // "Generate failed". See BACKLOG item 7 before re-adding it.
    //
    // Strip comments before asserting: the file deliberately EXPLAINS why the button
    // is gone, and a bare string search would fail on that explanation. What must not
    // come back is the rendered label.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/Generate from chat/);
    expect(code).not.toMatch(/Generating\.\.\./);
  });

  it("the renderer no longer calls generatePhase", () => {
    expect(src).not.toMatch(/api\.generatePhase/);
  });

  it("still offers a way to fill every phase in by hand", () => {
    // Removing Generate must not leave a phase with no way to record anything —
    // "Write notes" for prose phases, "Add …" for the two link phases.
    expect(src).toMatch(/Write notes/);
    // "Add links" rather than the old `Add ${label}`: Demo now has two, so naming one of them would be wrong.
    expect(src).toMatch(/"Add links"/);
  });
});

describe("status is stated in words, not only in colour", () => {
  it.each(["In progress", "Completed", "Not started"])("renders %s", (label) => {
    expect(src).toContain(label);
  });

  it("derives status from currentPhaseOrder vs the phase's own order", () => {
    // The data was always right; the screen just never said it. Guard the comparison
    // so an inverted operator cannot mark finished phases as pending.
    expect(src).toMatch(/p\.order < currentOrder \? "COMPLETED"/);
    expect(src).toMatch(/p\.order === currentOrder \? "IN_PROGRESS"/);
  });
});

describe("a saved link is rendered safely", () => {
  it("opens in a new window WITHOUT handing over a window handle", () => {
    // These URLs are participant-supplied. Without rel=noreferrer the opened page can
    // reach back through window.opener, and this is an Electron renderer.
    expect(src).toMatch(/rel="noreferrer noopener"/);
    expect(src).toMatch(/target="_blank"/);
  });

  it("uses a url input for link phases and a textarea otherwise", () => {
    expect(src).toMatch(/type="url"/);
    expect(src).toMatch(/<textarea/);
  });

  it("labels the url input, so it is not an unexplained box", () => {
    /**
     * The id now carries the FIELD KEY too. It has to: two inputs in one phase sharing `phase-link-<id>` would
     * give the document duplicate ids, and a `<label htmlFor>` would then point at whichever came first — so
     * clicking the second field's label would focus the first field's box.
     */
    expect(src).toMatch(/htmlFor=\{`phase-link-\$\{phase\.id\}-\$\{field\.key\}`\}/);
    expect(src).toMatch(/id=\{`phase-link-\$\{phase\.id\}-\$\{field\.key\}`\}/);
  });
});

describe("the connection pill probes a route that exists", () => {
  const ping = readFileSync(join(__dirname, "..", "main", "handlers", "ai.ts"), "utf8");
  const handler = ping.match(/ipcMain\.handle\("ai:ping"[\s\S]*?\n {2}\}\);/)?.[0] ?? "";

  /**
   * Assert on the FETCHED URL, not on the whole handler: the body deliberately
   * mentions /v1/health in a comment explaining why it is no longer used, and a test
   * that forbade the string outright would fail on its own documentation.
   */
  const fetched = handler.match(/fetch\(`\$\{url\}([^`]*)`/)?.[1] ?? "";

  it("ai:ping FETCHES /v1/auth/config, not /v1/health", () => {
    expect(handler, "could not parse the ai:ping handler").toBeTruthy();
    expect(fetched, "could not parse the probed URL").toBeTruthy();
    expect(fetched).toBe("/v1/auth/config");
  });

  /**
   * The origin is no longer PINNED — it is configured, and discovered from a portal URL
   * (main/platform-config.ts). What still has to hold is that this handler goes through
   * the ONE accessor rather than reading the settings row itself: `backendOriginOrNull`
   * is where "not configured" is distinguished from "" and where the trailing slash is
   * stripped, and a raw `getSetting("server_url")` here would skip both.
   */
  it("ai:ping goes through the backend-origin accessor, not a raw settings read", () => {
    expect(handler).toMatch(/backendOriginOrNull\(\)/);
    expect(handler).not.toMatch(/getSetting\("server_url"\)/);
  });

  /**
   * ⚠ "NOT CONFIGURED" MUST NOT BE REPORTED AS OFFLINE. An app nobody has pointed at a
   * platform yet is not down; telling the user their backend is unreachable sends them to
   * debug a network instead of finishing setup. This pill has already been
   * wrong-by-default once (the /v1/health 404 above), which is the whole reason the
   * distinction is pinned by a test.
   */
  it("ai:ping reports unconfigured as its own state, before probing anything", () => {
    expect(handler).toMatch(/configured:\s*false/);
  });

  it("ai:ping is still bounded by a timeout", () => {
    expect(handler).toMatch(/controller\.abort\(\)/);
  });
});

/**
 * ── ⚠ THE BUILD PHASE MUST NOT CLAIM TO BE EMPTY ───────────────────────────────────────────
 *
 * It did, on both front-ends, and the badge was reporting the wrong field. It is derived from
 * `phase.content` — the phase's NOTES — while a team's FILES are in the docs store and are loaded by
 * `TeamDocs` when the row opens. Uploading a document never touches `content`, so Build read "• empty"
 * however many files it held, directly above a panel listing them.
 *
 * ⚠ AN ACCURATE BADGE WOULD NEED A FILE COUNT, which means asking the server for every row on arrival
 * instead of when a row is expanded. That costs more than the hint is worth, so Build stops asserting
 * the one thing it cannot see. "• has notes" is KEPT, because when Build has notes that is true.
 *
 * ⚠ COMMENTS ARE STRIPPED FOR THESE ASSERTIONS. The component's own comment explains the rule and
 * contains the label's text, so a raw `toContain` would be satisfied — or broken — by prose rather than
 * by code. The portal's `source-under-test.ts` records where that bit twice.
 */
describe("the collapsed row has NO content badge at all", () => {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

  /**
   * ── ⚠ THREE PASSES, AND THE THIRD IS THE RIGHT ONE ─────────────────────────────────────────
   * Three successive narrowings: suppress the badge on Build, then drop "empty" everywhere, then drop
   * the positive label too.
   *
   * The badge read `phase.content`, the phase's NOTES, while a team's FILES live in the docs store and
   * load only when the row opens — so Build said "empty" above a panel listing its files. Suppressing
   * it on Build, then dropping "empty" everywhere, then dropping the positive label too: each step was
   * right and each was too small. The real problem was the badge itself, using a field that answers one
   * narrow question to summarise a whole phase.
   */
  it("renders neither an emptiness claim nor a notes claim", () => {
    // Asserted on the LABELS, not the bare words: `emptyNote`-style identifiers and the status pill's
    // own strings are not badges. The portal's twin of this test failed exactly that way first.
    expect(code).not.toContain("• empty");
    expect(code).not.toContain("has notes");
    expect(code).not.toContain("link added");
  });

  it("KEEPS the status pill for the two states that have no marker", () => {
    /**
     * Progression is workshop-wide and facilitator-controlled; the pill reflects `currentPhaseOrder`, not
     * `content`, so removing the content badge must not take it with it.
     *
     * ⚠ "Completed" IS GONE BY REQUEST ("pleae remove completed on phases"), and only that one. A
     * completed phase's step marker is a ✓ GLYPH where the others show a NUMBER, so the word repeated a
     * signal already carried in SHAPE. "In progress" and "Not started" both show a plain number and have
     * no marker to tell them apart — for those two the words are the only non-colour signal there is.
     */
    expect(code).toContain("Not started");
    expect(code).toContain("In progress");
    expect(code).not.toContain('"Completed"');
    expect(code).toContain('=== "COMPLETED" ? "✓"');
  });

  it("no longer gates any badge on the phase, so isBuild is only for the documents panel", () => {
    expect(code).not.toContain("!isBuild");
    expect(code).toMatch(/isBuild && <TeamDocs \/>/);
  });
});

/**
 * ── THE FIRST PHASE GATES EDITING OF THE LATER ONES ────────────────────────────────────────
 *
 * Users can move on to Build and Demo only once Idea has notes of a minimum word count.
 *
 * The rule itself is tested in the shared package (constants/phase-progress.test.ts). What is asserted
 * here is that this view actually APPLIES it — and applies it to the right things.
 */
describe("the 100-word gate on later phases", () => {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");

  it("uses the SHARED rule rather than re-deriving a word count", () => {
    // A second implementation of "how many words is that" is how a participant ends up staring at
    // "100 / 100" beside a button that is still disabled.
    expect(code).toContain("isPhaseNotesUnlocked(phase, phases)");
    expect(code).toContain("countWords(draft)");
    expect(code).toContain("MIN_FIRST_PHASE_WORDS");
  });

  it("⚠ disables EVERY edit affordance, not just the first one", () => {
    // There are two ways into the editor — "Edit" on a written phase and "Write notes"/"Add links" on an
    // empty one. Gating only the first leaves the second wide open, and an empty later phase is exactly
    // the case the gate is for.
    const gated = code.match(/disabled=\{!notesUnlocked\}/g) ?? [];
    const editEntries = code.match(/onClick=\{\(\) => startEdit\(phase\)\}/g) ?? [];
    expect(editEntries.length).toBeGreaterThanOrEqual(2);
    expect(gated).toHaveLength(editEntries.length);
  });

  it("⚠ gates EDITING only — the row still opens and still shows what is there", () => {
    // Hiding a locked phase's content would make the gate feel like a punishment rather than an order of
    // work, and a team looking ahead at what Demo will ask them for is a good thing.
    expect(code).not.toMatch(/notesUnlocked && \(\s*<ReactMarkdown/);
    expect(code).toContain("{!notesUnlocked && (");
  });

  it("names the gating phase BY ORDER, never by array position", () => {
    // `phases[0]` is the assumption the shared module explicitly refuses to make, because the array
    // arrives from an API whose ordering is not part of any contract.
    expect(code).not.toContain("phases[0]");
    expect(code).toContain("p.order < lowest.order");
  });

  it("tells a blocked team the DISTANCE remaining, not just the rule", () => {
    // "Write 100 words in Ideation" on a phase that already has 80 reads as though nothing has been done.
    expect(code).toContain("firstPhaseWordsRemaining(phases)");
    expect(code).toContain("wordsShort");
  });
});

