import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hex as paletteHex, TOKEN_NAMES } from "./palette.testkit";

/**
 * EVERY VIEW WEARS THE SAME DARK SURFACE.
 *
 * ── ⚠ WHY A TEST AND NOT JUST THE EDIT ──
 *
 * The full suite passed BEFORE this re-theme and would have passed after a half-finished one: no test
 * referenced any of these five files, so 657 green tests said nothing about whether a white panel was still
 * sitting inside a gray-900 shell. That is the same gap that let a broken Tailwind config ship — a file
 * nothing evaluates, or in this case nothing inspects.
 *
 * So this asserts the property that was actually asked for: no light-theme background survives in the views,
 * and the tokens used are the app's own.
 *
 * ── ⚠ AND IT COMPUTES CONTRAST RATHER THAN TRUSTING MY COMMENTS ──
 *
 * The interesting half. The files claim specific ratios in their comments; those claims are only worth
 * something if something checks them. The WCAG maths below is ~15 lines, so every pairing this re-theme
 * introduced is verified from the hex values rather than from what I wrote down — and it already caught two
 * real failures I would otherwise have shipped (see the toggle test).
 */

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(local(rel), "utf8");

/** The five files this change covers. TeamDocs is included because it renders INSIDE PhasesView's Build
 *  phase — themeing the parent and not the child would have left a white block in the middle of it. */
const VIEWS = {
  PhasesView: read("./components/PhasesView.tsx"),
  BoardView: read("./components/BoardView.tsx"),
  TeamChatView: read("./components/TeamChatView.tsx"),
  SettingsView: read("./components/SettingsView.tsx"),
  TeamDocs: read("./components/TeamDocs.tsx"),
};

/**
 * ── THE ONBOARDING SCREENS, ADDED AFTER A REPORTED DEFECT ──
 *
 * These four were the last light-themed surfaces: a participant met a white page, signed in, and
 * then landed in a dark app. Worse than inconsistent — `SelectAssistantView`'s heading and all
 * three assistant NAMES carried no text colour at all, so they inherited the browser default and
 * rendered near-invisible on the pale fill. Reported from a screenshot: the title and the names
 * looked disabled while their descriptions did not.
 *
 * They are a separate group because they are the only views that legitimately show a `blue-600`
 * primary button on `surface-panel` (the in-app views use `claude-accent` links instead), so the
 * "no stray light values" sweep below applies to both groups while the button rule does not.
 */
const ONBOARDING = {
  /**
   * ⚠ THE ONE SURFACE EVERY LAUNCH PASSES THROUGH, so a light value here would be the first thing every
   * participant sees, every time. Grouped with onboarding rather than the in-app views because it is
   * shown before any of them and shares their palette.
   */
  LoadingView: read("./components/LoadingView.tsx"),
  SelectAssistantView: read("./components/SelectAssistantView.tsx"),
  JoinTeamView: read("./components/JoinTeamView.tsx"),
  SignInView: read("./components/SignInView.tsx"),
  PlatformSetupView: read("./components/PlatformSetupView.tsx"),
};

/** Comments discuss the old light values to explain the change, so they would defeat every check here. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/* ── WCAG relative luminance and contrast, from the spec ────────────────────────────────── */

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The tokens, duplicated from the tailwind config — see the test that keeps them honest. */
const T = {
  bg: "#111827",
  panel: "#1f2937",
  raised: "#374151",
  text: "#e5e7eb",
  muted: "#9ca3af",
  faint: "#8b93a1",
  accent: "#d97757",
  strong: "#a8432c",
  /** The APP's own blue — deliberately not any assistant's. See the `brand` group in the config. */
  brandAccent: "#93c5fd",
  brandStrong: "#2563eb",
  brandDark: "#1d4ed8",
  ok: "#74c991",
  error: "#c74e39",
  errorText: "#f48771",
  warning: "#e1c08d",
  white: "#ffffff",
};

/**
 * ── ⚠ A LIGHT FILL MUST FLIP THE INK, AND ONE BUTTON DID NOT ──────────────────────────────
 *
 * `brand-accent` (#93c5fd) is a LIGHT colour. It is correct as ink on a dark surface and correct as a
 * hover FILL — but only if the label goes dark with it. White on it measures 1.80:1.
 *
 * The file editor's Save button shipped `bg-brand-strong text-white hover:bg-brand-accent` with no
 * `hover:text-surface-bg`, so its label all but vanished under the pointer. It was already wrong before
 * the palette moved (white on the old accent is 3.12:1, under the 4.5:1 floor) — the light blue only made
 * an invisible defect obvious.
 *
 * ⚠ SWEPT ACROSS EVERY VIEW, not just the one that was broken, and judged per `className` expression —
 * the fill and the ink have to appear together to be correct, so the expression is the unit.
 */
describe("⚠ EVERY LIGHT HOVER FILL CARRIES DARK INK", () => {
  const ALL = { ...VIEWS, ...ONBOARDING, App: read("./App.tsx"), ModelPicker: read("./components/ModelPicker.tsx") };

  it("white ink on the light accent would be 1.80:1, so no expression may pair them", () => {
    expect(contrast(T.white, T.brandAccent), "the reason this rule exists").toBeLessThan(3);
    expect(contrast(T.bg, T.brandAccent), "and why surface-bg is the right ink").toBeGreaterThanOrEqual(4.5);
  });

  for (const [name, src] of Object.entries(ALL)) {
    it(`${name} never hovers to the light accent while keeping white ink`, () => {
      const offenders = [...strip(src).matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
        .map((m) => m[1] ?? m[2] ?? "")
        .filter((e) => e.includes("hover:bg-brand-accent") && !e.includes("hover:text-surface-bg"))
        .map((e) => e.replace(/\s+/g, " ").trim().slice(0, 110));

      expect(offenders, `${name} hovers to a light fill without darkening the label`).toEqual([]);
    });
  }
});

describe("the token values match the palette", () => {
  it("⚠ so this file cannot drift from what the app renders", () => {
    /**
     * The maths in this file uses the `T` table above — the DARK values. It is only meaningful if those are
     * the values the app actually renders in dark mode.
     *
     * ⚠ THIS USED TO READ HEXES OUT OF `tailwind.config.ts`, and it can't any more: the config maps every
     * token to `rgb(var(--x) / <alpha-value>)` and the values moved to `index.css`, where light and dark sit
     * side by side. So the check now compares `T` against the parsed DARK palette — the same source
     * `palette.testkit` gives the other suites — and one place holds the numbers.
     */
    const pairs: [string, string][] = [
      ["surface-bg", T.bg],
      ["surface-panel", T.panel],
      ["surface-raised", T.raised],
      ["surface-text", T.text],
      ["surface-muted", T.muted],
      ["surface-faint", T.faint],
      ["claude-accent", T.accent],
      ["claude-strong", T.strong],
      ["brand-accent", T.brandAccent],
      ["brand-strong", T.brandStrong],
      ["brand-dark", T.brandDark],
      ["tool-ok", T.ok],
      ["tool-warning", T.warning],
      ["tool-error-text", T.errorText],
    ];
    for (const [token, value] of pairs) {
      expect(paletteHex(token, "dark"), `${token} (dark)`).toBe(value);
    }
  });

  /**
   * ⚠ AND LIGHT MUST DESCRIBE THE SAME TOKENS. A palette with a hole — a token defined in dark and missing
   * in light — renders that token as nothing in one mode, which is exactly the failure two modes introduce
   * and nothing else here would catch.
   */
  it("both modes define the identical token set", () => {
    expect(TOKEN_NAMES.length, "some tokens exist").toBeGreaterThan(15);
    for (const token of TOKEN_NAMES) {
      expect(() => paletteHex(token, "light"), `${token} missing in light`).not.toThrow();
    }
  });
});

describe("⚠ NO LIGHT-THEME BACKGROUND SURVIVES", () => {
  /**
   * The literal request. `bg-white` on TeamChatView's root and header were the most visible offenders — a
   * white panel inside a dark shell — but a `bg-gray-50` card is the same fault at lower contrast.
   */
  const FORBIDDEN_BG =
    /\bbg-(?:white|gray|slate|zinc|neutral|stone|blue|red|green|yellow|amber|indigo|violet|purple|pink|rose|emerald|cyan|sky|teal|lime|orange|fuchsia)-?\d*\b/g;

  for (const [name, source] of Object.entries(VIEWS)) {
    it(`${name} uses only surface backgrounds`, () => {
      const code = strip(source);
      const found = [...code.matchAll(FORBIDDEN_BG)].map((m) => m[0]);

      /**
       * THREE ALLOWANCES, each deliberate, narrow, and separately verified below:
       *
       *   `bg-white` on a toggle KNOB — it sits on the coloured track, not on a page surface, and 5.99:1 on
       *     the on-state makes it the conventional and legible choice.
       *   `bg-black/50` on a modal BACKDROP — a scrim is meant to be black regardless of theme.
       *   `bg-*-400` for the per-sender AVATAR fills — six hues are the point (they identify people), and
       *     surface tokens cannot express that. Their legibility is asserted in "avatar fills" below rather
       *     than assumed here, which is what stops this allowance becoming a hole.
       */
      const allowed = new Set(["bg-white", "bg-black"]);
      const leftovers = found.filter((c) => !allowed.has(c) && !/-400$/.test(c));

      expect(leftovers, `${name} still has light backgrounds`).toEqual([]);

      /**
       * ⚠ AND `bg-white` MUST NOT SIT ON A CONTAINER, which the allow-list alone cannot tell. Mutation
       * testing proved the hole: reverting TeamChatView's ROOT to `bg-white` passed every assertion above,
       * because the class was on the allow-list for the toggle knobs. So its context is checked too — a knob
       * is a small `h-4 w-4` span, never something with `flex`, `h-full` or padding.
       */
      const onContainer = [
        ...code.matchAll(/className="[^"]*\bbg-white\b[^"]*"/g),
      ].filter((m) => /\b(?:flex|h-full|min-h|overflow|px-\d|py-\d|p-\d)\b/.test(m[0]));
      expect(
        onContainer.map((m) => m[0].slice(0, 80)),
        `${name}: bg-white belongs on a toggle knob, not a container`
      ).toEqual([]);
    });
  }

  it("⚠ EVERY VIEW SETS ITS OWN BACKGROUND, rather than inheriting one", () => {
    /**
     * Mutation testing found this gap: deleting `bg-surface-bg` from the Phases and Settings roots passed
     * every other assertion, because "no LIGHT background" and "has a DARK background" are different claims
     * and only the first was being made.
     *
     * It matters beyond tidiness — an unset background inherits whatever is behind it, so the view would be
     * correct only for as long as its parent happens to be dark, and would silently break if `<main>` ever
     * changed. Each of the four top-level views therefore states its own.
     */
    /**
     * ⚠ CHECKED ON THE MAIN `return`, NOT ANYWHERE IN THE FILE. A third mutation showed why: PhasesView also
     * sets `bg-surface-bg` on its LOADING state, so a whole-file `toContain` kept passing while the real root
     * had lost it. The loading branch returns early, so the region after the LAST `return (` is the one that
     * renders for the life of the view.
     */
    for (const name of ["PhasesView", "BoardView", "TeamChatView", "SettingsView"] as const) {
      const code = strip(VIEWS[name]);
      /**
       * The COMPONENT's return, found by its indentation: two spaces, i.e. directly inside the function body.
       * `lastIndexOf("return (")` was wrong — it matched a nested return inside PhasesView's `.map()` over
       * phases, which is a row, not the root.
       */
      const returns = [...code.matchAll(/^ {2}return \(/gm)];
      expect(returns.length, `${name}: found the component's own return`).toBeGreaterThan(0);
      const mainReturn = code.slice(returns[returns.length - 1].index ?? 0);
      /**
       * ⚠ THE ROOT'S OWN `className`, NOT A WINDOW OF CHARACTERS. A 400-char slice was too loose: TeamChatView
       * sets `bg-surface-bg` again on its transcript a few lines down, so removing it from the ROOT still
       * passed. Extracting the first className after the return is what makes the assertion about the element
       * it names.
       */
      const rootClass = mainReturn.match(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{`([\s\S]*?)`\})/);
      expect(rootClass, `${name}: parsed the root element's className`).toBeTruthy();
      expect(
        rootClass![1] ?? rootClass![2] ?? rootClass![3] ?? "",
        `${name} must set bg-surface-bg on its ROOT element, not inherit it`
      ).toContain("bg-surface-bg");
    }
  });

  it("⚠ avatar fills are the ONLY 400-level allowance, and every one is legible", () => {
    /**
     * The allowance above lets `bg-*-400` through, so this is what keeps it honest: each of the six hues is
     * checked against the DARK initial that sits on it, and the set is pinned so a `bg-blue-400` card cannot
     * quietly join them.
     */
    const AVATARS: Record<string, string> = {
      "emerald-400": "#34d399",
      "violet-400": "#a78bfa",
      "amber-400": "#fbbf24",
      "rose-400": "#fb7185",
      "cyan-400": "#22d3ee",
      "indigo-400": "#818cf8",
    };

    const failures = Object.entries(AVATARS)
      .map(([name, hex]) => ({ name, ratio: contrast(T.bg, hex) }))
      .filter((a) => a.ratio < 4.5);
    expect(failures, "dark initials on avatar fills").toEqual([]);

    // And only these six appear, in only this one file.
    for (const [name, source] of Object.entries(VIEWS)) {
      const used = [...strip(source).matchAll(/\bbg-[a-z]+-400\b/g)].map((m) => m[0].slice(3));
      const unexpected = used.filter((u) => !(u in AVATARS));
      expect(unexpected, `${name} uses a 400-level fill that is not an avatar`).toEqual([]);
    }
  });

  it("the allowances are each used at most where claimed", () => {
    /**
     * A guard on the guard: if `bg-white` started appearing on cards again, the allow-list above would let
     * it through — so its count is bounded to the toggle knobs that legitimately use it.
     *
     * ⚠ COUNTED AGAINST THE NUMBER OF TOGGLES, NOT A LITERAL. This said `toBeLessThanOrEqual(2)` and broke
     * when a third toggle was added for the agent's file-write opt-out — a correct change failing a test
     * whose real claim is "one knob per toggle, and no stray `bg-white` anywhere else". Deriving the bound
     * keeps that claim exact as toggles come and go, and still fails on a `bg-white` card.
     */
    const code = strip(VIEWS.SettingsView);
    const toggles = [...code.matchAll(/role="switch"/g)].length;
    expect(toggles, "there must be some toggles to bound against").toBeGreaterThan(0);
    const knobs = [...code.matchAll(/\bbg-white\b/g)];
    expect(knobs.length, "one knob per toggle and nothing else").toBeLessThanOrEqual(toggles);
  });
});

describe("⚠ CONTRAST IS COMPUTED, NOT CLAIMED", () => {
  /** WCAG AA: 4.5:1 for body text, 3:1 for large text and non-text indicators. */
  const TEXT_FLOOR = 4.5;
  const INDICATOR_FLOOR = 3;

  it("every text pairing the re-theme introduced passes AA", () => {
    const pairings: Array<[string, string, string, string]> = [
      [T.text, T.panel, "text", "body and headings on cards"],
      [T.text, T.raised, "text", "labels on inputs and hover rows"],
      [T.muted, T.bg, "muted", "secondary prose"],
      [T.muted, T.panel, "muted", "secondary copy on a card"],
      [T.faint, T.bg, "faint", '"empty" / "unassigned"'],
      [T.faint, T.panel, "faint", "the same, on a card"],
      [T.accent, T.panel, "accent", "links, the AI pill, the in-progress pill"],
      [T.errorText, T.panel, "error-text", "errors, HIGH priority, Sign Out"],
      [T.warning, T.panel, "warning", "warnings, MEDIUM priority"],
      [T.ok, T.panel, "ok", "success notices, the completed pill"],
      [T.white, T.strong, "white", "text on every primary button"],
    ];

    const failures = pairings
      .map(([fg, bg, name, use]) => ({ name, use, ratio: contrast(fg, bg) }))
      .filter((p) => p.ratio < TEXT_FLOOR);

    expect(failures, "text under 4.5:1").toEqual([]);
  });

  it("dark text on a LIGHT fill passes too — the avatars and step circles", () => {
    /**
     * ⚠ THIS IS WHERE THE RE-THEME FOUND A PRE-EXISTING BUG. TeamChatView's avatars were white initials on
     * 500-level fills, and every one of the six FAILED — white on amber-500 is 2.15:1, on emerald-500 2.54:1,
     * against a 4.5:1 floor. Faithfully mirroring those values would have carried the bug across, so they
     * moved to 400-level with dark text. The same inversion applies to PhasesView's step circles.
     */
    for (const [fill, label] of [
      [T.ok, "completed step ✓"],
      [T.accent, "in-progress step"],
    ] as const) {
      expect(contrast(T.bg, fill), `dark text on ${label}`).toBeGreaterThanOrEqual(TEXT_FLOOR);
    }

    // And the old values really were failing, which is why this test exists rather than a comment.
    expect(contrast(T.white, "#f59e0b"), "white on amber-500 was the worst case").toBeLessThan(TEXT_FLOOR);
  });

  it("⚠ BOTH TOGGLE STATES are perceivable — two failures found by computing this", () => {
    /**
     * Neither state was legible by eye and both were settled by the maths.
     *
     *   OFF as `surface-raised` measures 1.72:1 against the background — an off toggle read as NO toggle,
     *   so OFF is `surface-muted` (6.99:1).
     *
     *   ON is `brand-strong`, which measures 3.43:1 and therefore clears the 3:1 non-text floor ON ITS OWN.
     *   It still carries a `brand-accent` border, and that is deliberate rather than leftover: the border is
     *   a redundant cue for anyone who does not register the hue, and the knob's POSITION plus `aria-checked`
     *   carry the state a third and fourth way.
     *
     * ⚠ THE OLD TERRACOTTA FILL DID NOT CLEAR THE FLOOR — 2.96:1, which is why the border was originally
     * required rather than optional. Asserted below so a future palette change that drops back under 3:1
     * cannot quietly rely on a border this test does not force.
     */
    expect(contrast(T.raised, T.bg), "raised is why OFF could not be raised").toBeLessThan(INDICATOR_FLOOR);
    expect(contrast(T.strong, T.bg), "the old fill needed the border").toBeLessThan(INDICATOR_FLOOR);

    expect(contrast(T.muted, T.bg), "OFF track").toBeGreaterThanOrEqual(INDICATOR_FLOOR);
    expect(contrast(T.brandStrong, T.bg), "ON fill stands alone now").toBeGreaterThanOrEqual(INDICATOR_FLOOR);
    expect(contrast(T.brandAccent, T.bg), "ON border, the redundant cue").toBeGreaterThanOrEqual(INDICATOR_FLOOR);

    /**
     * ⚠ COUNTED, NOT MERELY FOUND — a `toContain` passed while one toggle was reverted, because another
     * still satisfied it. Mutation testing caught that twice in this file.
     *
     * ⚠ AND COUNTED AGAINST THE NUMBER OF TOGGLES rather than a literal `2`, for the reason given on the
     * `bg-white` bound above: the claim is "EVERY toggle carries both cues", which a hard number expresses
     * only until the next one is added.
     */
    const code = strip(VIEWS.SettingsView);
    const toggles = [...code.matchAll(/role="switch"/g)].length;
    const on = [...code.matchAll(/border-brand-accent bg-brand-strong/g)];
    const off = [...code.matchAll(/border-transparent bg-surface-muted/g)];
    expect(on.length, "EVERY toggle's ON state carries the accent border").toBe(toggles);
    expect(off.length, "EVERY toggle's OFF state is muted, not raised").toBe(toggles);
    expect(code, "and neither reverts to the invisible raised track").not.toMatch(
      /border-transparent bg-surface-raised/
    );
  });

  it("selection and status borders clear the indicator floor", () => {
    for (const [colour, label] of [
      [T.accent, "selected assistant / in-progress phase"],
      [T.ok, "completed phase"],
    ] as const) {
      expect(contrast(colour, T.panel), label).toBeGreaterThanOrEqual(INDICATOR_FLOOR);
    }
  });
});

describe("⚠ KIRO GOT THE BACKGROUND AND NOTHING ELSE", () => {
  /**
   * ⚠ WHY THAT CAUTION IS JUSTIFIED. `KiroChatView.tsx` is 1,146 lines carrying Kiro's entire ACP integration:
   * the streaming client, the tool-call blocks, permission handling, session start/stop. It works, and a
   * palette edit that clipped a handler would surface as a broken assistant in a workshop rather than as a
   * failing build — `window.electronAPI` is typed `any`, so the compiler cannot see those calls.
   *
   * So these tests assert the palette changed AND that nothing else did.
   */
  const KIRO = read("./components/KiroChatView.tsx");
  const kiroCode = strip(KIRO);

  it("uses the shared dark surface", () => {
    expect(kiroCode, "its root").toContain("bg-surface-bg");
    expect(kiroCode, "and its chrome").toContain("bg-surface-panel");
  });

  it("no light-theme background survives", () => {
    const found = [
      ...kiroCode.matchAll(
        /\bbg-(?:white|gray|slate|blue|red|green|yellow|amber|indigo|violet|pink|rose)-?\d*(?:\/\d+)?\b/g
      ),
    ].map((m) => m[0]);
    expect(found, "Kiro still has light backgrounds").toEqual([]);
  });

  it("⚠ EVERY ACP CALL IS STILL THERE", () => {
    /**
     * THE ASSERTION THAT MAKES THE EDIT SAFE TO HAVE MADE. These are Kiro's whole reason for working: the
     * streaming client, its listeners, and the stop path. A palette pass has no business touching any of them,
     * and nothing else in the repo would notice if it had.
     */
    for (const call of [
      "api.kiroAcpStart",
      "api.kiroAcpSend",
      "api.kiroAcpStop",
      "api.kiroAcpCancel",
      "api.onKiroAcpMessageChunk",
      "api.onKiroAcpToolCall",
      "api.onKiroAcpToolCallUpdate",
      "api.onKiroAcpTurnEnd",
      "api.onKiroAcpError",
      "api.onKiroAcpExited",
      "api.removeKiroAcpListeners",
    ]) {
      expect(kiroCode, `${call} must survive a palette change`).toContain(call);
    }
  });

  it("⚠ THE COMPOSER NOW MATCHES CLAUDE'S, a LATER redesign", () => {
    /**
     * ⚠ THIS ASSERTION REVERSED, and deliberately. It used to require the composer to be UNCHANGED, because
     * Kiro was limited to a palette-only pass — the file carries the whole ACP integration and was meant to
     * stay untouched. Kiro's input box was then deliberately made the same as Claude's and Codex's, for a
     * consistent user experience.
     *
     * So the shape is now pinned the other way. A test that describes a layout should change when the layout is
     * deliberately redesigned; what must NOT change is the behaviour, which the next test covers.
     */
    /**
     * ⚠ THE RING IS THE PROPERTY; THE HUE IS NOT. This asserted `focus-within:border-claude-accent`
     * literally, and broke the moment Kiro was given its own accent instead of
     * orange. The composer must still be ONE CARD THAT SHOWS FOCUS;
     * which token draws it is a branding decision that is free to change per assistant.
     *
     * `transparent` is excluded because it would satisfy a naive "has a focus-within border" check
     * while showing the keyboard user nothing at all.
     */
    const ring = /focus-within:border-([\w-]+)/.exec(kiroCode);
    expect(ring, "one bordered card with a focus ring").not.toBeNull();
    expect(ring![1], "and the ring is a real colour").not.toBe("transparent");
    expect(kiroCode, "the shared send icon, not a copy").toContain("<SendIcon />");
    /**
     * ⚠ THE LITERAL MOVED INTO `ComposerKeyHint`, THE GUARANTEE DID NOT. All three composers carried a
     * near-identical inline span, every one of them `aria-hidden` — so the keyboard contract reached
     * sighted users only, and the textareas had no accessible name at all. The component now renders
     * the glyphs AND an sr-only sentence that `aria-describedby` points at, which is why the string is
     * no longer in the view. Asserting the USAGE keeps what this case protects: drop the hint from a
     * composer and it still fails.
     */
    expect(kiroCode, "and the keyboard hint is a real element").toContain("<ComposerKeyHint");
  });

  it("⚠ AND ITS TEXTAREA IS readOnly WHILE STREAMING, NOT disabled", () => {
    /**
     * A real fix carried across with the layout, not a cosmetic change. A `disabled` textarea DROPS FOCUS the
     * moment a turn starts and cannot take it back, so the participant had to click into the box again after
     * every single reply. `readOnly` refuses input while keeping focus and the caret.
     */
    expect(kiroCode).toContain("readOnly={streaming}");
    expect(kiroCode).toContain("aria-disabled={streaming}");
    expect(kiroCode, "no disabled attribute on the composer textarea").not.toMatch(
      /placeholder=\{streaming[\s\S]{0,200}\sdisabled=\{streaming\}/
    );
  });

  it("⚠ BEHAVIOUR SURVIVED THE LAYOUT CHANGE", () => {
    /**
     * THE ASSERTION THAT MADE THE EDIT SAFE TO MAKE. Restructuring a composer inside a 1,146-line file that
     * carries an assistant's whole integration is exactly where a handler gets dropped — and
     * `window.electronAPI` is typed `any`, so the compiler would not notice.
     *
     * Every control must still be wired to the SAME function it was before.
     */
    for (const handler of ["handleInputChange", "handleKeyDown", "handleSend()", "handleCancel"]) {
      expect(kiroCode, `${handler} must survive the rebuild`).toContain(handler);
    }
    expect(kiroCode, "and the textarea keeps its ref, for autoGrow").toContain("ref={textareaRef}");
  });

  /**
   * ── ⚠ THIS TEST REVERSED ON THE MODEL PICKER, AND THE PREMISE IS WHY ──────────────────────
   *
   * It used to assert `not.toContain("ModelPicker")`, justified as "Kiro has no model list to offer" — so
   * importing the picker "would add a dead control". That was true when it was written and is now false on
   * both counts:
   *
   *   • MEASURED: `kiro-cli chat --list-models --format json` returns 21 models with a stated default, and
   *     the ACP `session/new` response carries the same catalogue. Kiro can be enumerated.
   *   • WANTED: model choice on Kiro and Claude, not only on Codex.
   *
   * So the control is no longer dead, and the assertion is inverted rather than deleted — the reasoning is
   * kept here because "Kiro has no models" was repeated in three places and is the reason nobody looked
   * again for months.
   *
   * ⚠ THE `ActivityPhrase` HALF IS UNCHANGED AND STILL RIGHT. Kiro has its own working indicator, so a
   * second spinner would genuinely be a duplicate — that argument never depended on the model catalogue.
   */
  it("gains the SHARED model picker, and still not Claude's activity phrase", () => {
    expect(kiroCode, "the picker is imported, not reimplemented").toContain(
      'import { ModelPicker } from "./ModelPicker"'
    );
    expect(kiroCode, "and it is rendered in the composer").toMatch(/<ModelPicker/);
    /**
     * ⚠ THE CHOICE MUST REACH THE SEND, or the picker is decoration. `--model` is a spawn argument for
     * kiro-cli, so main restarts the ACP client when this value changes; a picker whose value never left the
     * component would silently do nothing, which is the exact defect the old assertion was protecting
     * against by refusing the control altogether.
     */
    expect(kiroCode, "the selection is passed to the send").toMatch(
      /selectedModel \? \{ model: selectedModel \}/
    );

    expect(kiroCode, "Kiro keeps its own working indicator").not.toContain("ActivityPhrase");
    /**
     * ⚠ THE LITERAL MOVED, THE FACT DID NOT. This asserted the string "Kiro is working" inline; the
     * composer's placeholder now comes from `lib/composer-placeholder.ts`, whose streaming branch
     * produces "<assistant> is working…" for both views. So the evidence is the CALL plus the absence
     * of `ActivityPhrase` — Kiro still has a plain working indicator rather than Claude's rotating
     * phrase, which is the thing this case is actually about.
     */
    expect(kiroCode, "the placeholder comes from the shared helper").toContain("composerPlaceholder({");
    expect(kiroCode, "and it is told when a turn is in flight").toMatch(
      /composerPlaceholder\(\{[\s\S]{0,200}streaming,/
    );
  });

  it("keeps its status colours meaningful, and paired with an icon", () => {
    // Tool state is carried by STATUS_ICON as well as by colour, so the re-theme did not make hue the only
    // signal — which is the rule the rest of this file enforces.
    expect(kiroCode).toContain("STATUS_ICON[tool.status]");
    expect(kiroCode).toContain("text-tool-ok");
    expect(kiroCode).toContain("text-tool-error-text");
  });
});

describe("⚠ THE THREE REPORTED BUGS ARE FIXED AT THEIR CALL SITES", () => {
  /**
   * The logic is unit-tested in `lib/assistants.test.ts`. These assert the components USE it — "the helper
   * exists" and "the UI calls it" are different claims, and only the second one fixed anything.
   */
  const chat = strip(read("./components/AssistantChatView.tsx"));
  const kiro = strip(read("./components/KiroChatView.tsx"));
  const sidebar = strip(read("./components/Sidebar.tsx"));
  const app = strip(read("./App.tsx"));

  it("the read-only test goes through canSendInSession", () => {
    // Not a raw `!==` between two vocabularies, which is what inverted it.
    expect(chat).toContain("!canSendInSession(activeSession?.ai_provider, currentCli)");
    expect(chat, "no raw provider comparison survives").not.toMatch(
      /ai_provider !== currentCli/
    );
    expect(chat, 'and no "cli" wildcard').not.toMatch(/ai_provider !== "cli"/);
  });

  it("⚠ THE HISTORY ICON NO LONGER FALLS BACK TO THE SELECTED ASSISTANT", () => {
    /**
     * `ai_provider || currentCli` was half the icon bug: an untagged chat adopted whatever was selected, so
     * switching to Kiro appeared to relabel the whole history.
     */
    expect(chat).not.toMatch(/ai_provider \|\| currentCli/);
    expect(chat).toContain("provider={(session as any).ai_provider}");
  });

  it("Kiro's history draws the icon of whatever MADE each chat", () => {
    // It hardcoded `kiroIcon` on every row and merely greyed out the others, so a Codex chat appeared as a
    // washed-out Kiro logo.
    expect(kiro).toContain("<SessionIcon");
    /**
     * ⚠ AND IT IS FED THE SESSION'S OWN PROVIDER. Mutation testing found this gap: `<SessionIcon provider="kiro">`
     * satisfies "the component is used" while reproducing the exact bug — every row drawn as Kiro. The component
     * existing and the component being given the right input are different claims.
     */
    expect(kiro).toMatch(/<SessionIcon\s+provider=\{session\.ai_provider\}/);
    expect(kiro).toContain("assistantIdOf(session.ai_provider)");
    expect(kiro, "the dimming stays — it means 'not usable here', not 'which assistant'").toContain("dimmed");
  });

  it("both views normalise instead of matching literal strings", () => {
    expect(chat).toContain("assistantIdOf");
    expect(kiro).toContain("assistantIdOf");
    expect(kiro, "no hand-enumerated spellings").not.toMatch(
      /ai_provider === "kiro" \|\| session\.ai_provider === "kiro-cli"/
    );
  });

  it("⚠ THE SIDEBAR HAS A RIGHT BORDER, which the dark theme made necessary", () => {
    /**
     * It never had one and never needed one — `gray-900` against WHITE views made the edge obvious. Now every
     * view is the same near-black, so there was no seam at all. The re-theme removed a boundary that had been
     * doing its work implicitly.
     */
    expect(sidebar).toMatch(/border-r border-surface-line/);
  });

  it("and the editor seam is coloured too", () => {
    // An uncoloured `border-r` inherits the text colour — the same class of bug as the uncoloured borders found
    // in TeamDocs.
    expect(app, "no bare border-r in the main area").not.toMatch(/min-w-0 border-r overflow-hidden/);
    expect(app).toContain("border-r border-surface-line");
  });
});

describe("⚠ TEAM CHAT'S COMPOSER MATCHES THE AI CHATS'", () => {
  const team = strip(read("./components/TeamChatView.tsx"));

  it("uses the same card, hint and send icon", () => {
    /**
     * ⚠ THE CARD, NOT THE COLOUR. This asserted `focus-within:border-claude-accent` — i.e. it pinned team
     * chat to CLAUDE'S terracotta. The request behind this suite was "the same input style … same box",
     * which is about the card, the hint and the send control; the hue was incidental, and pinning it meant
     * a human-conversation surface was contractually required to wear an assistant's brand colour.
     *
     * So the shape assertions stay exactly as they were and the hue moves to team chat's own token. What
     * this test protects is unchanged: swap the card, drop the hint, or hand-roll the send glyph and it
     * still fails.
     */
    expect(team).toContain("rounded-lg border border-surface-line bg-surface-panel");
    expect(team, "focus lands on the CARD, not the textarea").toContain("focus-within:border-");
    expect(team, "the shared keyboard hint — see ComposerKeyHint").toContain("<ComposerKeyHint");
    expect(team).toContain("<SendIcon />");
  });

  /**
   * ── ⚠ NO ASSISTANT'S HUE ANYWHERE IN TEAM CHAT ────────────────────────────────────────────
   *
   * Terracotta is Claude's, and this view used it for the participant's own bubble, the composer's focus
   * ring and the send button — so people talking to each other were dressed as the AI, and stayed that way
   * while the participant was working with Kiro or Codex.
   *
   * ⚠ ASSERTED AS AN ABSENCE, because that is the failure mode. Any of the three could be reverted
   * individually and the view would still mostly look right, which is exactly how one orange control
   * survives a re-theme.
   */
  it("wears no assistant's colour", () => {
    for (const hue of ["claude-strong", "claude-accent", "kiro-strong", "kiro-accent", "kiro-bubble", "codex-accent"]) {
      expect(team, `team chat must not use ${hue}`).not.toContain(hue);
    }
  });

  it("dresses its own bubble, ring and send button in team chat's blue", () => {
    expect(team, "own message bubble").toContain("bg-brand-strong text-white");
    expect(team, "composer focus ring").toContain("focus-within:border-brand-accent");
    expect(team, "send button, hovering to the darker blue").toContain("hover:bg-brand-dark");
  });

  /**
   * ── ⚠ THE NEW BLUE IS NOT A DOWNGRADE, AND THIS IS THE PROOF ──────────────────────────────
   *
   * Replacing a hue is where a re-theme quietly loses contrast: the old one was chosen and measured, the
   * new one is chosen because it looks right. So each figure is asserted against the terracotta it
   * replaced rather than only against the WCAG floor — a change that passed AA while being *worse* than
   * what it replaced would otherwise slip through.
   */
  it("⚠ SEPARATES BETTER THAN THE TERRACOTTA IT REPLACES, not merely legally", () => {
    // The message text itself. AA for body copy.
    expect(contrast(T.white, T.brandStrong), "white on the own-message bubble").toBeGreaterThanOrEqual(4.5);

    // Own bubble against THEIR bubble — the distinction the whole layout rests on.
    expect(
      contrast(T.brandStrong, T.panel),
      "own vs their bubble must be at least as separated as before"
    ).toBeGreaterThan(contrast(T.strong, T.panel));

    // And against the page behind both of them.
    expect(
      contrast(T.brandStrong, T.bg),
      "bubble vs page must be at least as separated as before"
    ).toBeGreaterThan(contrast(T.strong, T.bg));

    // The send button's own shape, per WCAG 1.4.11.
    expect(contrast(T.brandStrong, T.bg), "send button shape on the page").toBeGreaterThanOrEqual(3);

    // Hover darkens and keeps the white glyph, so there is no ink swap to get wrong.
    expect(contrast(T.white, T.brandDark), "white survives the hover fill").toBeGreaterThanOrEqual(4.5);
  });

  /**
   * ⚠ `faint` IS LEGAL ONLY BECAUSE THE FOOTER IS OUTSIDE THE BUBBLE. The timestamp and copy control sit
   * on the page, where `faint` measures 5.73:1. On the blue fill it is 1.67:1 — effectively invisible. This
   * pins the reason, so moving that footer inside the bubble fails here rather than shipping unreadable
   * timestamps.
   */
  it("keeps the timestamp on the page, where `faint` is readable", () => {
    expect(contrast(T.faint, T.bg), "faint on the page").toBeGreaterThanOrEqual(4.5);
    expect(contrast(T.faint, T.brandStrong), "faint on the bubble would be illegal").toBeLessThan(3);

    /**
     * ⚠ JUDGED PER `className` EXPRESSION rather than by parsing the markup. The first version of this
     * matched the two `<div>`s and their intervening comment with a regex, which broke the moment the
     * source was comment-stripped — a brittle assertion about nesting, dressed up as a contrast check.
     *
     * The invariant that actually matters is simpler and is what this pins: no single element carries BOTH
     * the blue fill and the faint ink. If someone moves the timestamp inside the bubble, the two land in
     * one expression and this fails.
     */
    const exprs = [...team.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].map(
      (m) => m[1] ?? m[2] ?? ""
    );
    const both = exprs.filter((e) => e.includes("bg-brand-strong") && e.includes("surface-faint"));
    expect(both, `faint ink on the blue fill: ${both.join(" | ")}`).toEqual([]);
  });

  it("⚠ IS A TEXTAREA NOW, so a team message can hold a newline", () => {
    /**
     * A BEHAVIOUR CHANGE, not a styling one, and worth naming: it was an `<input type="text">`, which cannot
     * hold a newline at all — so a team message was forced onto one line while the AI composers had always
     * allowed Shift+Enter. Matching the box without matching that would have given the same appearance and a
     * worse control.
     */
    expect(team).toContain("<textarea");
    expect(team, "the single-line input is gone").not.toMatch(/<input\s+type="text"/);
    expect(team, "and Shift+Enter inserts a newline").toMatch(/e\.key === "Enter" && !e\.shiftKey/);
  });

  it("keeps focus while sending, like the AI composers", () => {
    // A `disabled` field drops focus and cannot take it back, so the participant had to click into the box again
    // after every message.
    expect(team).toContain("readOnly={sending}");
    expect(team).toContain("aria-disabled={sending}");
  });

  it("collapses back to one row after a send", () => {
    // Otherwise a multi-line message leaves the composer tall and empty.
    expect(team).toContain("autoGrow(inputRef.current)");
  });

  it("still sends through the same handler", () => {
    // The whole point of a restyle: the wiring is untouched.
    expect(team).toContain("api.sendTeamMessage");
    expect(team).toContain("onSubmit={handleSend}");
  });
});

describe("⚠ THE STALE ASSISTANT BUG", () => {
  /**
   * `ai_command` was read ONCE, in an effect keyed on `[project.id]`. Switching assistant does not remount this
   * component — `useAcpMode` only changes for Kiro — so `currentCli` held the PREVIOUS assistant for the life of
   * the view. The welcome text, every avatar and the theme flag all read that one value.
   */
  const chat = strip(read("./components/AssistantChatView.tsx"));

  it("⚠ RE-READS `ai_command` AFTER MOUNT", () => {
    /**
     * The fix, and the assertion that would have caught the bug. An effect keyed on `[project.id]` alone can
     * never observe an assistant change, because the project has not changed.
     */
    expect(chat).toMatch(/setInterval\(read, \d+\)/);
    expect(chat, "and it is torn down").toMatch(/clearInterval\(timer\)/);
    expect(chat, "and only re-renders on an actual change").toMatch(
      /setCurrentCli\(\(prev\) => \(prev === cmd \? prev : cmd\)\)/
    );
  });

  it("the welcome text and the trust banner name the SELECTED assistant", () => {
    // Both hardcoded "Claude" or read a stale value. `assistantLabel` is the single source.
    expect(chat).toContain("Welcome to {assistantLabel(currentCli)}");
    expect(chat).toMatch(/\{assistantLabel\(currentCli\)\} needs permission/);
    expect(chat, "no hardcoded product name in the banner").not.toMatch(/Claude needs permission/);
  });

  it("⚠ CODEX GETS THE DARK SURFACE, keeping its bubble LAYOUT", () => {
    /**
     * The separation the single flag was hiding. Kiro already proved these are independent: it kept its own
     * bubbles and took the dark palette in a change that touched only class names.
     */
    expect(chat).toContain("const usesDarkSurface = true;");
    expect(chat).toContain("const usesTimeline = usesSdk;");
    expect(chat, "Codex bubbles are dark now").toContain("darkBubbleClass(");
    expect(chat, "and the bubble branch still exists").toContain("if (!usesTimeline) {");
  });

  /**
   * ── ⚠ CODEX WEARS CODEX'S INK, NOT CLAUDE'S ───────────────────────────────────────────────
   *
   * This view serves BOTH, and its two prose bundles were module constants with
   * `prose-code:text-claude-accent` baked in — so every inline code span in a Codex reply rendered in
   * Claude's terracotta. Same class of bug as team chat's bubble, one layer down and easier to miss,
   * because it only shows on messages that happen to contain code.
   *
   * ⚠ ASSERTED AS AN ABSENCE PLUS A DERIVATION. Absence alone would pass if someone hardcoded
   * `text-codex-accent` instead — equally wrong for Claude. The colour has to come FROM the theme, so the
   * builders must be called with `theme.ink` and must not name any assistant themselves.
   */
  it("builds its prose from the active assistant's ink, naming no assistant", () => {
    expect(chat, "prose bundle is a builder, not a constant").toContain("assistantProseClass(");
    expect(chat, "bubble bundle is a builder, not a constant").toContain("darkBubbleClass(");

    // Both derive from the theme rather than from a literal.
    expect(chat).toContain("assistantProseClass(theme.proseCode)");
    expect(chat).toContain("darkBubbleClass(theme.proseCode)");

    // And no assistant's hue is written into this view at all.
    for (const hue of ["claude-accent", "claude-strong", "kiro-accent", "codex-accent"]) {
      expect(chat, `${hue} must not be hardcoded in a view two assistants share`).not.toContain(hue);
    }
  });

  /**
   * ⚠ `renderBlocks` IS TOP-LEVEL, so it cannot see `theme` — its colours are parameters. They are
   * REQUIRED rather than defaulted, and that matters: the old signature defaulted `caret` to
   * `"bg-claude-assistant"`-style terracotta, which meant forgetting to pass it produced Claude's colour
   * silently for Codex instead of a type error. Both call sites pass both values.
   */
  it("passes the timeline's colours in, with no assistant-flavoured default", () => {
    expect(chat).toMatch(/\{ live = false, caret, proseCode \}: \{ live\?: boolean; caret: string; proseCode: string \}/);
    expect(chat, "no defaulted colour can smuggle one assistant's hue in").not.toMatch(
      /caret = "bg-[a-z]+-(accent|strong)"/
    );
    /**
     * ⚠ CALL SITES ONLY. A bare `renderBlocks\([^)]*\)` also matches the DEFINITION, whose parameter list
     * naturally contains no `theme.` — so the first version of this test failed against the very signature
     * it was asserting. The negative lookahead skips the definition, which is the only occurrence whose
     * arguments begin on the next line.
     */
    const calls = [...chat.matchAll(/renderBlocks\((?!\s*\n)[^)]*\)/g)].map((m) => m[0]);
    expect(calls.length, "both call sites").toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c, `${c} must pass the prose ink`).toContain("proseCode: theme.proseCode");
      expect(c, `${c} must pass caret`).toContain("caret: theme.caret");
    }
  });

  /**
   * ⚠ THIS TEST USED TO PERMIT THE LIGHT BUBBLE — AND THAT PERMISSION WAS THE BUG.
   *
   * It asserted `SHARED_BUBBLE_CLASS` was used ONLY by the shared-chat modal, on the reasoning that the
   * modal was "a dialog over the app's light chrome". True when written; false once `usesDarkSurface`
   * became unconditionally `true`. Nothing re-derived it, so a rule that had become wrong went on being
   * enforced, and the dialog stayed the one white panel in a dark app.
   *
   * So the class is gone, and the assertion is now the opposite one.
   */
  it("⚠ there is NO light bubble class left — the shared-chat viewer is dark too", () => {
    expect(chat, "the light bubble class was deleted, not merely unused").not.toContain(
      "SHARED_BUBBLE_CLASS"
    );
    /**
     * ⚠ THE SHARED VIEWER IS NO LONGER A MODAL. It used to be a `fixed inset-0` dialog whose panel took
     * `border border-surface-line bg-surface-bg shadow-xl`; it now renders in the window
     * like the chat itself, so it is now `SharedThreadPanel` — an in-window pane on the app's own dark
     * `surface-*` tokens, with no `shadow-xl` dialog treatment and no light backdrop.
     */
    expect(chat, "the old light modal backdrop is gone").not.toContain("fixed inset-0 z-50");
    expect(chat, "the viewer is now an in-window pane").toContain("function SharedThreadPanel");
    expect(chat, "and it takes the app's own dark surface").toContain(
      "flex h-full flex-col overflow-hidden bg-surface-bg"
    );
  });

  /**
   * The modal is the LAST place a light class could hide: it is behind two clicks (open the history
   * panel, then a teammate's chat), so nobody sees it by accident while working. Hence a check on the
   * whole file rather than on the one snippet I happened to fix.
   */
  it("⚠ no light-palette Tailwind class is left UNGUARDED anywhere in the view", () => {
    /**
     * A light class is only legitimate as the DEAD branch of a dark-mode ternary — `usesDarkSurface` is
     * unconditionally `true` and `dark` defaults to it, so those branches cannot render. They are kept
     * because the light theme is still a documented option, not because they are reachable.
     *
     * Scoped per `className` EXPRESSION rather than per line: these ternaries wrap across up to six
     * lines, so a line-local check flags thirteen continuation lines whose guard sits just above. The
     * unit that either has a guard or does not is the whole class expression.
     */
    const LIGHT =
      /\b(bg-white|bg-gray-\d{2,3}|text-gray-\d{2,3}|border-gray-\d{2,3}|bg-blue-\d{2,3}|text-blue-\d{2,3})\b/;

    const offenders = strip(chat)
      .split(/className=/)
      .slice(1)
      .filter((expr) => LIGHT.test(expr))
      // `\bdark\b` and not `dark ?` — one guard puts the flag on its own line above the `?`.
      .filter((expr) => !/usesDarkSurface|\bdark\b/.test(expr))
      .map((expr) => expr.slice(0, 120).replace(/\s+/g, " ").trim());

    expect(offenders, "light classes reachable on the dark surface").toEqual([]);
  });

  it("⚠ THE PERMISSION CARD IS DARK — the surface that matters most", () => {
    /**
     * Found by auditing which light classes were REACHABLE on the dark surface, not by seeing it: the card only
     * appears when a tool asks for approval. It is where a participant authorises a file write, so a light jolt
     * exactly when they should read carefully is the worst place for one.
     *
     * `Allow` deliberately does NOT use the brand terracotta — looking like the everyday send button would
     * invite clicking it by muscle memory.
     */
    expect(chat).toContain("border-t border-tool-warning/40 bg-surface-panel");
    expect(chat).toContain("bg-tool-warning px-3 py-1.5 text-xs font-medium text-surface-bg");
    expect(chat, "and colour is not the only cue").toContain("Permission Required");
  });
});

describe("⚠ A MESSAGE AVATAR NAMES THE CHAT'S OWN ASSISTANT", () => {
  /**
   * THE CAUSE: the per-message avatar read `currentCli` — the SELECTED assistant — so a Claude transcript viewed
   * under Codex claimed Codex had written it. `activeSession.ai_provider` is the provider the chat was actually
   * created with.
   *
   * ⚠ CLAUDE SHOWS NONE, AND THAT IS PREFERRED. It is true and it is by design: the
   * timeline layout has no per-message avatars at all (dots on a spine instead), so only the BUBBLE path renders
   * one — which is the path Codex and the shared viewer use.
   */
  const chat = strip(read("./components/AssistantChatView.tsx"));
  const kiro = strip(read("./components/KiroChatView.tsx"));

  it("the bubble transcript uses the SESSION's provider, not the selected one", () => {
    expect(chat).toMatch(/provider=\{activeSession\?\.ai_provider \?\? currentCli\}/);
  });

  it("⚠ `currentCli` SURVIVES ONLY WHERE IT IS THE AUTHOR", () => {
    /**
     * Three places legitimately name the selected assistant: the header (whose label it is), the empty state
     * ("Welcome to X"), and the LIVE STREAM bubble — that turn is being produced right now, so the selected
     * assistant really is its author. Anywhere else is the bug.
     *
     * Counted rather than merely found: a `toContain` would pass with the transcript avatar reverted, because
     * the header would still satisfy it.
     */
    const fromCurrent = [...chat.matchAll(/<AIIcon[^/]*provider=\{currentCli\}/g)];
    expect(fromCurrent.length, "header, empty state, live stream — and no more").toBe(3);

    /**
     * ⚠ AND ALL THREE FOLLOW THE SURFACE. Mutation testing found this: nothing asserted their `dark` prop, so
     * every one could have been left at `dark={false}` — a light "?" disc on the dark transcript. The live-stream
     * avatar in particular WAS stale at `false`, left over from when that path was light, and only the audit
     * caught it.
     */
    const lightOnDark = [...chat.matchAll(/<AIIcon dark=\{false\}[^/]*provider=\{currentCli\}/g)];
    expect(
      lightOnDark.length,
      "no currentCli avatar may be hardcoded light — they all render on the dark surface"
    ).toBe(0);
  });

  it("no `|| \"claude\"` fallback anywhere", () => {
    /**
     * A teammate's chat with no recorded provider was labelled Claude — a guess, and the shared list is entirely
     * OTHER people's chats, so it is wrong more often there than anywhere else.
     */
    expect(chat).not.toMatch(/aiProvider \|\| "claude"/);
  });

  it("⚠ A TRANSCRIPT SHOWS NO ICON when the assistant is unknown", () => {
    /**
     * The chosen fallback: better no icon at all for chat messages. Naming the right assistant
     * IS possible now, so the icon shows whenever we know it — but a "?" repeated beside every message would be
     * noise, so an unknown provider renders nothing in a TRANSCRIPT.
     */
    expect(chat).toContain('placeholder = "disc"');
    expect(chat).toContain('if (placeholder === "none") return null;');
    const transcriptSites = [...chat.matchAll(/placeholder="none"/g)];
    expect(transcriptSites.length, "the bubble transcript and the shared viewer").toBe(2);
  });

  it("a LIST keeps the neutral disc, because the column aligns the rows", () => {
    // An empty gap in a list misaligns every row after it; a transcript has no such column.
    expect(chat, "the history list does not opt out").toMatch(
      /provider=\{\(session as any\)\.ai_provider\}\s*\/>/
    );
  });

  it("⚠ KIRO'S OWN TRANSCRIPT NAMES THE CHAT'S ASSISTANT", () => {
    /**
     * The previous round fixed Kiro's shared VIEWER and its history list, and left its own message rows —
     * `MessageBubble` hardcoded `kiroIcon`. This view can display a chat created by ANY assistant (read-only for
     * those, but still rendered), so every message claimed Kiro wrote it.
     */
    expect(kiro, "the session's provider is passed in").toContain("provider={activeSession?.ai_provider}");
    /**
     * ⚠ SIZE-AGNOSTIC ON PURPOSE. This pinned `size="lg"`, which had nothing to do with the reported
     * bug and broke when the transcript moved to the reference images' full-width layout — where the
     * mark sits in a small author row rather than a 32px gutter. What must hold is that the row is fed
     * the SESSION's provider instead of a hardcoded "kiro"; the dimensions are layout.
     */
    expect(kiro, "and the row renders it").toMatch(/<SessionIcon provider=\{provider \?\? "kiro"\}/);
    expect(
      [...kiro.matchAll(/<img src=\{kiroIcon\}/g)].length,
      "only the brand mark and two empty states may hardcode it"
    ).toBeLessThanOrEqual(4);
  });

  it("⚠ AND ITS TEAM-CHATS LIST DOES TOO", () => {
    /**
     * That list is entirely OTHER PEOPLE's shared chats, so a hardcoded Kiro logo was wrong for almost every
     * row — a teammate's Claude conversation appeared as Kiro's.
     */
    expect(kiro).toContain("<SessionIcon provider={thread.aiProvider} />");
  });

  it("⚠ KIRO'S SHARED VIEWER HAD THE SAME FAULT", () => {
    /**
     * The same issue affected both Kiro and Codex — and it was worse there: the
     * viewer exists to read OTHER people's chats, so hardcoding Kiro's logo was wrong almost every time.
     *
     * ⚠ THE VIEWER IS NOW `SharedThreadPanel`, a top-level component that receives the shared chat as a
     * `thread` prop (the viewer moved from a `fixed inset-0` modal to an in-window pane). So the provider
     * reads `thread.aiProvider`, not `viewingThread.aiProvider` — same invariant, the chat's OWN assistant,
     * asserted by count over the new name.
     */
    /**
     * ⚠ COUNTED BY THE `size="lg"` QUALIFIER, not by `thread.aiProvider` alone. The team-chats history
     * list ALSO renders `<SessionIcon provider={thread.aiProvider} />` per row (same prop name now the
     * panel takes a `thread` prop), so a bare count would pick that up too. The viewer's two icons — the
     * header and the message avatar — are the `size="lg"` ones; the list row is unsized.
     */
    const viewerIcons = [...kiro.matchAll(/<SessionIcon provider=\{thread\.aiProvider\} size="lg"/g)];
    expect(viewerIcons.length, "the viewer's header AND its message avatar").toBe(2);
    expect(kiro, "and its transcript shows none for unknown").toMatch(
      /thread\.aiProvider\} size="lg" placeholder="none"/
    );

    /**
     * And `SessionIcon` HONOURS the placeholder — the prop existing is not the same as the component acting on
     * it, which is an easy distinction to miss.
     */
    expect(kiro).toContain('if (placeholder === "none") return null;');
  });
});

describe("⚠ THE THREE COMPOSERS SHARE ONE SEND ICON", () => {
  /**
   * `AssistantChatView` serves Claude AND Codex; Kiro is a separate component. So "the same" had to mean sharing the
   * icon rather than copying it — a duplicated 8-line SVG is how two send buttons end up a stroke width apart,
   * which is the inconsistency being removed.
   */
  const chat = strip(read("./components/AssistantChatView.tsx"));
  const kiro = strip(read("./components/KiroChatView.tsx"));

  it("both import it, neither defines it", () => {
    for (const [name, code] of [["AssistantChatView", chat], ["KiroChatView", kiro]] as const) {
      expect(code, `${name} imports the shared icon`).toContain('from "./SendIcon"');
      expect(code, `${name} must not define its own`).not.toContain("function SendIcon");
    }
  });

  it("it lives in one place", () => {
    expect(read("./components/SendIcon.tsx")).toContain("export function SendIcon");
  });

  it("both composers use the same card and hint", () => {
    // The two properties that make them feel like one product: the focus ring on the card, and the hint as a
    // real element rather than placeholder text that vanishes when you type.
    /**
     * ⚠ SHARED STRUCTURE, NOT A SHARED HUE — narrowed when Kiro got its own blue accent. Requiring the
     * identical class made "same user experience" mean "same brand colour", which is the one thing the
     * two views should NOT share: an accent that is Claude's terracotta in Kiro's chat tells the
     * participant nothing about which assistant they are talking to.
     */
    for (const [name, code] of [["AssistantChatView", chat], ["KiroChatView", kiro]] as const) {
      expect(code, `${name}: focus ring on the card`).toMatch(/focus-within:border-[\w-]+/);
      expect(code, `${name}: keyboard hint`).toContain("<ComposerKeyHint");
    }
  });
});

describe("colour is never the only signal", () => {
  it("every phase status has a NON-COLOUR signal — a word, or a distinct glyph", () => {
    /**
     * "is Ideation actually started?" is the question this screen exists to answer, and it must answer it
     * for someone who cannot distinguish the hues.
     *
     * ── ⚠ THIS TEST WAS `["Completed", "In progress", "Not started"]` AND IS DELIBERATELY NOT WEAKENED ──
     *
     * The "Completed" pill on phases was removed. Deleting that
     * string from the list would have quietly reduced an accessibility guarantee to two thirds of a rule,
     * so the rule is restated in the form it always meant: every state must be distinguishable WITHOUT
     * colour. Completed now satisfies it with a ✓ GLYPH where every other phase shows its NUMBER — a
     * difference in shape — which is why removing its word is safe and removing the other two would not
     * be. "In progress" and "Not started" both render a plain number, so for them the words are the only
     * non-colour signal that exists.
     */
    const code = strip(VIEWS.PhasesView);
    for (const word of ["In progress", "Not started"]) {
      expect(code, `${word} has no marker of its own, so the WORD must be printed`).toContain(word);
    }
    expect(code, "COMPLETED must be marked by a ✓ rather than by hue alone").toContain(
      '=== "COMPLETED" ? "✓"'
    );
  });

  it("task priority prints its own name", () => {
    // The badge renders `task.priority.toLowerCase()`, so the red/amber fill reinforces a word rather than
    // replacing one. That is what makes using hue here legitimate at all.
    expect(strip(VIEWS.BoardView)).toContain("task.priority.toLowerCase()");
  });

  it("toggles expose their state to assistive tech", () => {
    const code = strip(VIEWS.SettingsView);
    expect(code).toContain("aria-checked={notifySound}");
    expect(code).toContain("aria-checked={telemetryEnabled}");
    expect(code).toContain('role="switch"');
  });
});

describe("no behaviour changed — this was a palette pass", () => {
  it("every view keeps its handlers and its API calls", () => {
    /**
     * The risk in a 160-token restyle is a dropped branch or a lost handler, and neither would fail a
     * type-check inside a `className` edit. These are the calls each view cannot lose.
     */
    expect(strip(VIEWS.PhasesView)).toContain("api.savePhase");
    expect(strip(VIEWS.BoardView)).toContain("handleAddTask");
    expect(strip(VIEWS.TeamChatView)).toContain("api.sendTeamMessage");
    /**
     * ⚠ SIGN-OUT MOVED TO ACCOUNT and is asserted there instead. Settings no longer ends
     * sessions — it holds preferences — so requiring `handleSignOut` here would pin the old
     * layout in place. What Settings must not lose is the assistant switch, which is the one
     * irreversible-feeling action it still owns.
     */
    expect(strip(VIEWS.SettingsView)).toContain("handleSwitchAssistant");
    expect(strip(read("./components/AccountPanel.tsx"))).toContain("handleSignOut");
    expect(strip(VIEWS.TeamDocs)).toContain("api.docsUpload");
  });

  it("SettingsView keeps its bounded reading measure", () => {
    // `max-w-2xl` moved to an inner wrapper so the dark fill spans the window while the prose stays readable.
    // Losing it would stretch form rows across 1400px.
    expect(strip(VIEWS.SettingsView)).toContain("mx-auto max-w-2xl");
  });
});

/**
 * ── ONBOARDING WEARS THE SAME THEME AS THE APP ──────────────────────────────────────────────
 *
 * The sign-in journey used to be light while everything behind it was dark. These pin the fix,
 * and the FIRST test is the one that matters: an element with a size and a weight but no COLOUR
 * is the actual defect that was reported, and it type-checks and lints perfectly.
 */
describe("the onboarding screens are themed like the rest of the app", () => {
  it("⚠ never states a size or weight without also stating a COLOUR", () => {
    /**
     * `<h1 className="text-2xl font-bold">` inherits whatever colour an ancestor happens to set — nothing did
     * — so it rendered as the browser default grey on a near-white card and read as disabled.
     *
     * Checked on the CLASS ATTRIBUTE rather than the element, because that is where the omission
     * lives and where a future edit would reintroduce it.
     */
    for (const [name, src] of Object.entries(ONBOARDING)) {
      const typographic = [...strip(src).matchAll(/className="([^"]*)"/g)]
        .map((m) => m[1])
        .filter((c) => /\b(text-(xs|sm|base|lg|xl|2xl|3xl)|font-(bold|semibold|medium))\b/.test(c))
        // A class list that sets only a weight on a wrapper whose child carries the colour is
        // fine; what is not fine is one that sets typography AND has no colour anywhere in it.
        .filter((c) => !/\btext-(surface|white|red|amber|blue|emerald|rose|tool)-?/.test(c));
      expect(typographic, `${name} has typography with no colour: ${typographic.join(" | ")}`).toEqual(
        []
      );
    }
  });

  it("uses no light-theme surfaces or text", () => {
    for (const [name, src] of Object.entries(ONBOARDING)) {
      const code = strip(src);
      for (const stray of ["bg-white", "bg-gray-50", "text-gray-", "border-gray-"]) {
        expect(code, `${name} still uses ${stray}`).not.toContain(stray);
      }
    }
  });

  /**
   * ── ⚠ DARK BLUE INK ON A DARK PANEL, WHICH THIS SWEEP USED TO MISS ────────────────────────
   *
   * The sweep above checks `text-gray-` and `bg-white` and says nothing about `text-blue-`, so
   * `SelectAssistantView`'s Setup Guide kept its light-theme inks through the entire re-theme — on the screen
   * a participant sees BEFORE they have done anything, holding the one link that tells them what to do.
   *
   * The 700–900 range is unusable on any fill this app has, and the numbers are COMPUTED below
   * rather than quoted, so the rule cannot drift from its own justification. The hover state was the
   * worst of them: identical luminance to the panel, i.e. pointing at the link erased it.
   *
   * `text-blue-600` is NOT forbidden — it is the onboarding group's link ink on `surface-panel` and
   * clears 4.5:1 there. The line is drawn where the measurement draws it.
   */
  it("⚠ uses no blue ink too dark to read on its own panels", () => {
    const BLUE: Record<string, string> = {
      "text-blue-700": "#1d4ed8",
      "text-blue-800": "#1e40af",
      "text-blue-900": "#1e3a8a",
    };
    // Verify the premise: every one of these fails AA on BOTH dark fills the group uses.
    for (const [cls, hex] of Object.entries(BLUE)) {
      expect(contrast(hex, T.raised), `${cls} on raised`).toBeLessThan(4.5);
      expect(contrast(hex, T.panel), `${cls} on panel`).toBeLessThan(4.5);
    }
    // blue-900 on raised is the pathological case — the same luminance as the fill.
    expect(contrast("#1e3a8a", T.raised)).toBeLessThan(1.1);

    /**
     * ⚠ JUDGED PER `className` EXPRESSION, NOT PER CLASS — and a blunt "no text-blue-700 anywhere"
     * rule was WRONG, which this found immediately. `JoinTeamView`'s team initial is
     * `bg-blue-100 text-blue-700`: dark ink on a LIGHT chip, measuring 5.49:1, and the same
     * inversion the team-chat avatars use deliberately. The defect is dark blue on a DARK fill
     * (1.54:1 on `raised`), so the pairing is what has to be inspected.
     */
    const LIGHT_FILL = /\bbg-(?:blue|sky|indigo)-(?:50|100|200)\b|\bbg-white\b/;

    for (const [name, src] of Object.entries(ONBOARDING)) {
      const offenders = [...strip(src).matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
        .map((m) => m[1] ?? m[2] ?? "")
        .filter((expr) => Object.keys(BLUE).some((c) => expr.includes(c)))
        // A light fill in the SAME expression makes the dark ink correct, not broken.
        .filter((expr) => !LIGHT_FILL.test(expr))
        .map((expr) => expr.slice(0, 100).replace(/\s+/g, " ").trim());

      expect(
        offenders,
        `${name} puts dark blue ink on a dark fill: ${offenders.join(" | ")}`
      ).toEqual([]);
    }
  });

  it("colours every border it draws", () => {
    /**
     * An UNCOLOURED `border-t` / `border-b` inherits the TEXT colour — so on a dark fill it draws
     * the rule in near-white. Exactly the defect already fixed on App.tsx's editor seam, and both
     * onboarding footers had it.
     */
    for (const [name, src] of Object.entries(ONBOARDING)) {
      const bare = [...strip(src).matchAll(/className="([^"]*)"/g)]
        .map((m) => m[1])
        .filter((c) => /\bborder(-[trbl])?\b/.test(c))
        /**
         * ⚠ `tool-` IS ALLOWED, and it is a widening rather than a weakening. The property under test
         * is "no BARE border", because an uncoloured `border-t` inherits the text colour and draws the
         * rule in near-white on a dark fill. `border-tool-error` is coloured and tokenised — legal as a
         * graphical indicator at 3.87:1, which is exactly what a border is — so it satisfies the rule.
         * The allowlist simply predated the alert boxes that use it.
         */
        .filter((c) => !/\bborder-(surface|tool|red|amber|blue|transparent)/.test(c));
      expect(bare, `${name} draws an uncoloured border: ${bare.join(" | ")}`).toEqual([]);
    }
  });

  it("keeps muted and faint OFF raised fills, where they measure below 4.5:1", () => {
    // The constraint documented in tailwind.config.ts: muted is 4.06:1 and faint 3.33:1 on
    // `raised`, both under the floor. Verified here rather than trusted.
    expect(contrast("#9ca3af", "#374151")).toBeLessThan(4.5);
    expect(contrast("#8b93a1", "#374151")).toBeLessThan(4.5);

    for (const [name, src] of Object.entries(ONBOARDING)) {
      const violations = [...strip(src).matchAll(/className="([^"]*)"/g)]
        .map((m) => m[1])
        .filter((c) => /bg-surface-raised/.test(c) && /text-surface-(muted|faint)/.test(c));
      expect(violations, `${name} puts muted/faint on a raised fill`).toEqual([]);
    }
  });

  /**
   * ⚠ A STATE-PREFIXED BACKGROUND IS NOT A BACKGROUND.
   *
   * An enabled input therefore fell back to the browser's white default, putting near-white text on white.
   *
   * The previous colour test could not catch this: the class list DID contain `bg-` and DID contain
   * a text colour. What was missing was an UNPREFIXED fill, which is what this asserts.
   */
  it("⚠ every text field sets an UNPREFIXED background, not just a disabled: one", () => {
    for (const [name, src] of Object.entries(ONBOARDING)) {
      const fields = [...strip(src).matchAll(/<(?:input|textarea)\b[\s\S]{0,900}?\/>/g)].map(
        (m) => m[0]
      );
      for (const field of fields) {
        const cls = /className="([^"]*)"/.exec(field)?.[1] ?? "";
        if (!cls) continue;
        const id = /id="([^"]*)"/.exec(field)?.[1] ?? "(no id)";
        // A base utility has no `state:` prefix — `bg-x` counts, `disabled:bg-x` and `hover:bg-x`
        // do not.
        const baseFill = cls.split(/\s+/).some((t) => /^bg-/.test(t));
        expect(baseFill, `${name} field "${id}" has no unprefixed background: ${cls}`).toBe(true);
      }
    }
  });

  it("keeps its body text and headings above the 4.5:1 floor", () => {
    // The values actually used, measured against the page fill they sit on.
    expect(contrast("#e5e7eb", "#111827")).toBeGreaterThanOrEqual(4.5); // surface.text
    expect(contrast("#9ca3af", "#111827")).toBeGreaterThanOrEqual(4.5); // surface.muted
    expect(contrast("#e5e7eb", "#1f2937")).toBeGreaterThanOrEqual(4.5); // text on a card
    expect(contrast("#9ca3af", "#1f2937")).toBeGreaterThanOrEqual(4.5); // muted on a card
  });
});

/**
 * ── ⚠ THE GUARD'S COVERAGE LIST WAS THE BUG ───────────────────────────────────────────────────
 *
 * A scanner for light-theme leftovers already existed above — and it iterated `VIEWS`, which is
 * PhasesView, BoardView, TeamChatView, SettingsView and TeamDocs. The two surfaces a user sees FIRST,
 * the sidebar and the titlebar strip, were never in the list, so `bg-gray-900` sat on both of them
 * through every green run. Sidebar.tsx carried 24 palette literals and App.tsx four.
 *
 * ⚠ AND IT ONLY FORBADE BACKGROUNDS. A fixed `text-gray-400` is the same defect: legible on a dark
 * panel, wrong on a light one. 43 of AssistantChatView's 60 literals were text colours, which is why
 * a background-only scan reported that file as clean.
 *
 * So this block scans EVERY renderer component for EVERY themeable property. It is deliberately a
 * whole-directory sweep rather than another hand-maintained list: a list is what failed, and the next
 * component added would not have been on it either.
 */
describe("⚠ NO PALETTE LITERAL SURVIVES IN ANY COMPONENT", () => {
  /**
   * `bg-*-400` avatar fills, `bg-white` knobs and `bg-black/50` scrims keep their existing allowances
   * from the block above — this sweep is about the NEUTRAL scales, which are what a theme has to move.
   * A neutral literal has no legitimate use: every one of them has a `surface-*` token that resolves to
   * the same value in dark and to the right value in light.
   */
  const NEUTRAL_LITERAL =
    /\b(?:[a-z-]+:)?(?:bg|text|border|ring|divide|placeholder|from|via|to)-(?:gray|slate|zinc|neutral|stone)-\d{2,3}(?:\/\d+)?\b/g;

  const componentFiles = readdirSync(local("./components"))
    .filter((f) => f.endsWith(".tsx"))
    .sort();

  it("covers every component file, so a new one cannot slip past this sweep", () => {
    // A guard on the guard: if the directory read ever returns nothing, every assertion below would
    // pass vacuously — which is precisely the failure mode this whole block exists to correct.
    expect(componentFiles.length).toBeGreaterThan(20);
    expect(componentFiles).toContain("Sidebar.tsx");
  });

  for (const file of componentFiles) {
    it(`${file} uses tokens, not neutral literals`, () => {
      const code = strip(read(`./components/${file}`));
      const found = [...code.matchAll(NEUTRAL_LITERAL)].map((m) => m[0]);
      expect(found, `${file} has literals that cannot follow the theme`).toEqual([]);
    });
  }

  it("App.tsx too — it owns the titlebar strip that stayed dark", () => {
    const code = strip(read("./App.tsx"));
    const found = [...code.matchAll(NEUTRAL_LITERAL)].map((m) => m[0]);
    expect(found, "App.tsx has literals that cannot follow the theme").toEqual([]);
  });
});

/**
 * ── ⚠ `prose-invert` IS A THEME LEAK IN CLASS FORM ────────────────────────────────────────────
 *
 * `prose-invert` is Tailwind Typography's DARK palette — light-grey ink for a dark background. Six
 * call sites applied it unconditionally, which was right while the app was dark-only and became a
 * contrast bug the moment a light theme existed. It is the same class of defect as a hardcoded
 * `text-gray-400`, and the sweep above could not see it because the class name contains no colour.
 *
 * The plugin's palette now comes from the surface tokens (tailwind.config.ts), so plain `prose` is
 * correct in both themes. This guards the fix: reintroducing `prose-invert` anywhere brings back a
 * mode-specific palette that the tokens are there to make unnecessary.
 */
describe("⚠ NO UNCONDITIONAL prose-invert", () => {
  const proseFiles = [
    ...readdirSync(local("./components"))
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => `./components/${f}`),
    "./App.tsx",
  ];

  it("the typography palette is driven from the surface tokens", () => {
    // If this ever stops being true, `prose` reverts to the plugin's light-page defaults and every
    // markdown surface in the dark theme goes near-invisible — the FIRST bug reported here.
    const config = readFileSync(local("../../tailwind.config.ts"), "utf8");
    expect(config).toContain("--tw-prose-body");
    expect(config).toContain("rgb(var(--surface-text))");
  });

  for (const rel of proseFiles) {
    it(`${rel} does not use prose-invert`, () => {
      const code = strip(read(rel));
      expect(
        code.includes("prose-invert"),
        `${rel} pins the dark palette; the tokens make it unnecessary`
      ).toBe(false);
    });
  }
});
