import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/renderer/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
      /*
       * ── ⚠ THE VALUES ARE IN `src/renderer/index.css`, NOT HERE ─────────────────────────────
       *
       * Every token below maps to a CSS custom property so the app can carry TWO palettes — light and
       * dark — behind one set of class names. `bg-surface-panel` is written once in a component and
       * resolves to whichever mode is active; nothing in the ~930 usages had to change.
       *
       * ⚠ `rgb(var(--x) / <alpha-value>)` AND NOT `var(--x)`. The alpha placeholder is what keeps the
       * opacity modifiers working — `brand-accent/40`, `surface-panel/60`, `tool-ok/15`,
       * `tool-warning/40`. With a bare `var()` Tailwind cannot inject the alpha and those seven usages
       * render nothing at all.
       *
       * The measured ratios for both modes live beside the values in index.css, so a value and its
       * justification cannot drift into two files.
       */
        /**
         * Claude brand terracotta, taken from the official VS Code extension's
         * webview stylesheet so the desktop chat reads as the same product.
         *
         * TWO tokens, not one, and the split is a contrast requirement rather
         * than taste:
         *   accent (#d97757) measures 3.12:1 on white — legal for a non-text
         *     graphical indicator (WCAG 1.4.11 needs 3:1) and NOT legal for
         *     body text. Glyphs, carets, borders and rules only.
         *   strong (#a8432c) measures 5.99:1 on white — the terracotta to use
         *     whenever the colour lands on actual words (inline code, labels).
         * Using `accent` for small text is the one mistake this pair exists to
         * prevent, so keep the names in mind when reaching for it.
         */
        claude: {
          accent: "rgb(var(--claude-accent) / <alpha-value>)",
          strong: "rgb(var(--claude-strong) / <alpha-value>)",
        },

        /**
         * ── KIRO'S OWN ACCENT, BECAUSE IT IS NOT A CLAUDE PRODUCT ─────────────────────────────
         *
         * THE GOAL: match the real Kiro assistant's layout — its font colour and message boxes instead
         * of orange.
         *
         * ⚠ THE KIRO VIEW WAS WEARING CLAUDE'S TERRACOTTA — fifteen `claude-accent` / `claude-strong`
         * references in `KiroChatView.tsx`. Two different assistants presented in one brand's colour, so
         * the accent said nothing about which one you were talking to. Kiro's own UI is blue; these are
         * that blue, adapted to THIS app's surfaces rather than copied as literal hexes.
         *
         * ⚠ THE SURFACES DELIBERATELY DO NOT CHANGE. Kiro's IDE sits on a navy background; this app is
         * `gray-900` (#111827) everywhere — sidebar, titlebar, every panel — and the rule is to
         * keep the desktop theme's colours. A navy chat pane beside a gray-900 sidebar is the
         * exact mismatch the earlier re-theme fixed. So what is adopted from the images is the LAYOUT,
         * the text colour and the message boxes; what stays is the chrome.
         *
         * Ratios MEASURED against the surfaces each token can actually land on, not assumed:
         *
         *   accent #93c5fd — 9.84:1 on bg, 8.14:1 on panel, 5.72:1 on RAISED.
         *     ⚠ `raised` is the binding one and it is why this is blue-300 rather than blue-400: inline
         *     code renders on `bg-surface-raised` at `text-xs`, and blue-400 (#60a5fa) measures 4.05:1
         *     there — under AA's 4.5:1 for text that is not large. The brighter tone is legal on all
         *     three surfaces, so ONE token is safe everywhere, unlike the claude pair above.
         *
         *   strong #2563eb — white on it 5.17:1 (AA for the send glyph's label), and 3.43:1 against the
         *     page background, which is WCAG 1.4.11's 3:1 for a control's own shape. blue-700 (#1d4ed8)
         *     carried white better (6.70:1) but measured only 2.65:1 as a shape, i.e. a button whose
         *     boundary was under the non-text minimum.
         *
         *   bubble #22436b — the participant's own message box, `surface-text` on it at 8.14:1. Muted on
         *     purpose: the images show the user's turn as a slightly-lifted navy panel, not a saturated
         *     fill, and it replaces `claude-strong`'s loud terracotta block.
         *     ⚠ The box reads 1.76:1 against the page, i.e. BELOW 3:1 — acceptable only because the fill
         *     is not the sole cue for authorship: the turn is also right-aligned, and its text carries
         *     full contrast. The previous terracotta sat in the same place (2.2:1), so this is not a
         *     regression, but do not make the fill the only signal.
         */
        kiro: {
          accent: "rgb(var(--kiro-accent) / <alpha-value>)",
          strong: "rgb(var(--kiro-strong) / <alpha-value>)",
          bubble: "rgb(var(--kiro-bubble) / <alpha-value>)",
        },

        /**
         * ── CODEX HAS NO BRAND HUE, AND THAT IS THE POINT ─────────────────────────────────────
         *
         * THE PROBLEM: Codex's model box was orange; it should follow Codex's own layout style.
         *
         * Codex shared `ChatView` with Claude, so it wore Claude's terracotta on its composer ring,
         * its send button, its caret and its model box. The reference screenshot of Codex's own UI has
         * no accent colour anywhere: near-white text, grey chrome, a plain arrow to send. So this is
         * one NEUTRAL token rather than a hue chosen to be "Codex-ish".
         *
         *   accent #d1d5db — 12.04:1 on bg, 9.96:1 on panel, 7.00:1 on RAISED. Legal on every surface
         *     including the one inline code sits on, which is what made a single token safe here where
         *     the claude pair needed two.
         *
         * ⚠ THERE IS DELIBERATELY NO `strong`. `claude.strong` and `kiro.strong` exist to carry WHITE
         * text on a saturated fill; nothing neutral can do that (white on #d1d5db is 1.27:1, and every
         * grey dark enough for white text measures under 1.4.11's 3:1 as a SHAPE against this
         * background — gray-600 is 2.35:1). Codex's send button therefore INVERTS: a light pill with a
         * dark glyph, `bg-codex-accent text-surface-bg`, which measures 12.04:1 in both directions.
         * The same inversion the team-chat avatars use, and for the same reason.
         */
        codex: {
          accent: "rgb(var(--codex-accent) / <alpha-value>)",
        },

        /**
         * ── ⚠ THE APP'S OWN COLOUR. THE ASSISTANTS' THREE ARE NOT IT. ─────────────────────────
         *
         * THE GOAL: the orange goes everywhere except the Claude assistant itself.
         *
         * The app's chrome — Save, Commit, Publish, + Add Task, active nav rows, focus rings, selected
         * files, unread badges, the phase status ring — was painted in `claude-strong` / `claude-accent`,
         * i.e. CLAUDE'S BRAND TERRACOTTA. Every assistant owns a hue (`lib/assistant-theme.ts`), so the
         * whole application was wearing one vendor's, and it kept wearing it while the participant worked
         * in Kiro or Codex. A "Commit" button is not an expression of which model you chose.
         *
         * ⚠ THIS GROUP MUST NOT BE FOLDED INTO `kiro`, THOUGH TWO HEXES COINCIDE. `accent` (#93c5fd) and
         * `kiro.accent`, and `strong` (#2563eb) and `kiro.strong`, are the same values today — both
         * arrived at independently, because these are simply the blues that measure correctly on this
         * surface. Sharing the tokens would mean a Kiro rebrand silently restyling the entire app, which
         * is the failure this group exists to end. Assistants keep `claude`, `kiro` and `codex`; the
         * application keeps this.
         *
         * ── MEASURED ON ALL THREE SURFACES, BECAUSE CHROME LANDS ON ALL THREE ──
         *
         *   accent #93c5fd   blue-300. 9.84:1 on `bg`, 8.14:1 on `panel`, 5.72:1 on `raised` — AA as TEXT
         *                    on every surface in the app, which the terracotta was NOT: `claude-accent`
         *                    measures 3.30:1 on `raised`, so links and labels on a raised panel (a
         *                    selected file row, a code block) were already failing. Fixing that is a
         *                    side-effect of this change, not the reason for it.
         *
         *                    ⚠ NOT blue-400 (#60a5fa), which was the obvious pick and measures 4.05:1 on
         *                    `raised` — under the 4.5:1 floor. It would have looked right and been wrong
         *                    in exactly the place the terracotta already was.
         *
         *   strong #2563eb   blue-600, the filled-button and own-bubble fill. White on it is 5.17:1 (AA
         *                    for a button's label) and it is 3.43:1 against the page, clearing WCAG
         *                    1.4.11's 3:1 for the control's own shape.
         *
         *   dark   #1d4ed8   blue-700, for a filled button's hover. White stays white on it (6.70:1), so
         *                    hovering darkens the fill and nothing else. The assistants instead hover to
         *                    their light accent and flip the ink to dark, because their accents are light
         *                    fills; one ink state is simpler and has no second case to get wrong.
         *
         * ⚠ WHERE `accent` IS A FILL RATHER THAN INK, THE INK MUST FLIP. `#93c5fd` is a light colour, so
         * `hover:bg-brand-accent` requires `hover:text-surface-bg` alongside it — white on it is 1.46:1.
         * A test asserts the pair, because dropping the ink half is invisible until someone hovers.
         */
        brand: {
          accent: "rgb(var(--brand-accent) / <alpha-value>)",
          strong: "rgb(var(--brand-strong) / <alpha-value>)",
          dark: "rgb(var(--brand-dark) / <alpha-value>)",
        },

        /**
         * ── THE DARK SURFACE, MATCHED TO THIS APP'S OWN CHROME ──
         *
         * THE GOAL: the chat theme matches the rest of the desktop app instead of neutral grey.
         *
         * ⚠ THESE WERE VS CODE'S VALUES AND THAT WAS THE BUG. The first version copied the extension's
         * webview literally — #1f1f1f, #262626 — which are NEUTRAL greys. This app's sidebar and titlebar
         * are Tailwind `gray-900` (#111827), a distinctly COOL blue-black. Put side by side, the chat read
         * as a foreign panel bolted onto the app: same darkness, visibly different hue.
         *
         * So the surfaces are now the app's own scale, and the three are Tailwind values rather than
         * invented ones — `gray-900/800/700` — because the sidebar, the titlebar and the Explorer already
         * use them. Matching the product beats matching the reference screenshot; the LAYOUT is the
         * extension's, the palette is ours.
         *
         *   bg     #111827  gray-900  the transcript itself, and the sidebar it sits beside
         *   panel  #1f2937  gray-800  headers, tool IN/OUT panels, the history rail
         *   raised #374151  gray-700  the user's own message box, hover states, selected rows
         *
         * ── CONTRAST, MEASURED ON THESE SURFACES ──
         *
         * Recomputed rather than carried over: the backgrounds changed, so every ratio changed with them.
         * Read as `bg / panel / raised`, because a label can appear on any of the three:
         *
         *   text   #e5e7eb  14.33 / 11.86 / 8.33   body copy, code, tool names   (gray-200)
         *   muted  #9ca3af   6.99 /  5.78 / 4.06   descriptions, secondary copy  (gray-400)
         *   faint  #8b93a1   5.73 /  4.74 / 3.33   the IN/OUT gutter labels
         *
         * ⚠ `muted` AND `faint` FAIL ON `raised` (4.06 and 3.33 against a 4.5 floor). That is not a defect
         * to be ignored — it is a constraint on WHERE they may be used: neither may sit on a raised fill.
         * Hover rows and the user's message box use `text`, which clears 8.33:1 there. This was measured,
         * not assumed, and it is the reason those two rows are not simply themed the same as the others.
         */
        surface: {
          bg: "rgb(var(--surface-bg) / <alpha-value>)",
          panel: "rgb(var(--surface-panel) / <alpha-value>)",
          raised: "rgb(var(--surface-raised) / <alpha-value>)",
          /**
           * The hairline between rows, at 1.72:1 on `bg` — deliberately low. It separates rows inside a
           * panel that is already identified by its own fill and its IN/OUT labels, so it is decoration
           * rather than a boundary anyone must perceive to use the control. Nothing is conveyed by it
           * alone. It is `gray-700`, the same rule the sidebar divides its sections with.
           */
          line: "rgb(var(--surface-line) / <alpha-value>)",
          /**
           * ⚠ THE BOUNDARY BETWEEN TWO PANES, and it is a SEPARATE token from `line` because it carries
           * information rather than decoration.
           *
           * THE PROBLEM: a pinned tab's window was not visibly separated. Pinning puts two panes in
           * one row and the seam between them was `border-l border-surface-line` — which measures 1.72:1
           * against the page, correct for a hairline INSIDE a panel where nothing depends on seeing it, and
           * far too faint when it is the thing telling you there are two panes at all.
           *
           * ⚠ THE FIRST FIX WAS `border-surface-raised` AND IT CHANGED NOTHING: `raised` and `line` are the
           * SAME HEX (#374151), so "a lighter line" was 2px of the identical colour. Measuring caught it.
           *
           * #6b7280 (gray-500) measured 3.67:1 on `bg` and 3.04:1 on `panel` — both clear WCAG 1.4.11's 3:1
           * for a non-text boundary, on either surface a pane may present. gray-600 reaches only 2.35 and
           * 1.94, so this is the first step on the scale that is legal in both places.
           */
          edge: "rgb(var(--surface-edge) / <alpha-value>)",
          text: "rgb(var(--surface-text) / <alpha-value>)",
          muted: "rgb(var(--surface-muted) / <alpha-value>)",
          faint: "rgb(var(--surface-faint) / <alpha-value>)",
        },

        /**
         * ── THE TIMELINE DOT VOCABULARY ──
         *
         * These are COPIED, not chosen. Literal values from the extension's own stylesheet, under
         * `~/.vscode/extensions/anthropic.claude-code-<version>/webview/index.css` — rules
         * `.timelineMessage.dotSuccess:before` and its siblings:
         *
         * ⚠ THE VERSION IS SPELLED OUT AS `<version>` RATHER THAN A `*` GLOB ON PURPOSE. A `*` immediately
         * before a `/` CLOSES THIS BLOCK COMMENT, which is exactly what happened here: the config stopped
         * parsing at that point, PostCSS failed on `index.css`, and the dev server would not start. The
         * error surfaced as `Unexpected token, expected ","` in sucrase — nothing about a comment — so the
         * two-character cause was well hidden. Do not reintroduce the glob.
         *
         *   .dotSuccess:before { background-color:#74c991 }
         *   .dotFailure:before { background-color:#c74e39 }
         *   .dotWarning:before { background-color:#e1c08d }
         *   .dotProgress:before { animation:1s linear infinite blink }   ← no colour of its own
         *
         * Note what that last rule means: an IN-PROGRESS dot keeps the DEFAULT colour and blinks. It is
         * not a third hue, which is why there is no token for it — `surface.muted` plays that part.
         *
         * ⚠ THESE STAY WHILE THE SURFACES MOVED TO OUR PALETTE, and the split is deliberate: the dots are
         * a STATUS VOCABULARY a Claude Code user already reads fluently, so changing their hues would cost
         * recognition for no gain. What had to match the app was the background; what should match Claude
         * is the meaning layered on it.
         *
         * Ratios RECOMPUTED against the new `surface.bg` (#111827) rather than carried over — the
         * background changed, so every figure did. Indicators are held to WCAG 1.4.11's 3:1:
         *
         *   ok      #74c991 — 8.88:1   completed tool call
         *   error   #c74e39 — 3.87:1   failed tool call, as a DOT ONLY
         *   warning #e1c08d — 10.24:1  the overflow note, and git's "modified"
         *
         * `error` at 3.87:1 is legal for a graphical indicator and ILLEGAL for text, which is the whole
         * reason `error-text` exists beside it: failed OUTPUT is words, so it uses #f48771 at 7.22:1.
         */
        tool: {
          ok: "rgb(var(--tool-ok) / <alpha-value>)",
          error: "rgb(var(--tool-error) / <alpha-value>)",
          warning: "rgb(var(--tool-warning) / <alpha-value>)",
          "error-text": "rgb(var(--tool-error-text) / <alpha-value>)",
        },
      },
      keyframes: {
        /**
         * The in-progress timeline dot. Copied from the extension's `blink_fL49mQ`:
         *
         *   @keyframes blink { 0%,to{opacity:1} 50%{opacity:0} }
         *
         * Opacity only, so it composites on its own layer and never triggers layout — which matters
         * because this runs for the whole duration of a turn behind a scrolling transcript.
         */
        "dot-blink": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        /** The extension's `fadeIn_fL49mQ`, used on the spinner row as it appears. */
        "row-fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
      /**
       * ── ⚠ `prose` FOLLOWS THE THEME; `prose-invert` NO LONGER APPEARS ANYWHERE ──────────────
       *
       * THE PROBLEM: in light mode, Markdown file preview text was grey and hard to read.
       *
       * Six call sites applied `prose prose-sm prose-invert` UNCONDITIONALLY, `prose-invert` being the
       * typography plugin's DARK palette — light-grey ink chosen for a dark background. On the light
       * theme's white surface that ink stays light grey, which is exactly the symptom. The md
       * preview was the most visible case because it is nothing but prose; the chat views had the same
       * defect in their headings, links, bold and rules, where `text-surface-text` on the wrapper
       * cannot help — as App.tsx's own comment said, `prose` styles the ELEMENTS, so no `text-*` on the
       * container reaches them.
       *
       * So the plugin's palette is driven from the surface tokens instead. These land INSIDE `.prose`
       * (which is where the plugin declares them, so a `:root` block would lose to it), and the tokens
       * are already redefined under `[data-theme="light"]` — meaning one `prose` class is correct in
       * both themes and there is nothing left to remember at the call site.
       *
       * Bare `rgb(var(--token))` rather than the `<alpha-value>` form used above: these are raw CSS
       * variable values, not Tailwind colour utilities, so there is no alpha placeholder to substitute.
       */
      typography: {
        DEFAULT: {
          css: {
            "--tw-prose-body": "rgb(var(--surface-text))",
            "--tw-prose-headings": "rgb(var(--surface-text))",
            "--tw-prose-lead": "rgb(var(--surface-muted))",
            "--tw-prose-links": "rgb(var(--brand-accent))",
            "--tw-prose-bold": "rgb(var(--surface-text))",
            "--tw-prose-counters": "rgb(var(--surface-muted))",
            "--tw-prose-bullets": "rgb(var(--surface-edge))",
            "--tw-prose-hr": "rgb(var(--surface-line))",
            "--tw-prose-quotes": "rgb(var(--surface-text))",
            "--tw-prose-quote-borders": "rgb(var(--surface-line))",
            "--tw-prose-captions": "rgb(var(--surface-muted))",
            "--tw-prose-code": "rgb(var(--surface-text))",
            "--tw-prose-pre-code": "rgb(var(--surface-text))",
            "--tw-prose-pre-bg": "rgb(var(--surface-panel))",
            "--tw-prose-th-borders": "rgb(var(--surface-line))",
            "--tw-prose-td-borders": "rgb(var(--surface-line))",
          },
        },
      },
      animation: {
        /** 1s linear infinite — the extension's own timing for `.dotProgress`. */
        "dot-blink": "dot-blink 1s linear infinite",
        /** 0.3s ease-in-out, as on `.spinnerRow`. */
        "row-fade-in": "row-fade-in 0.3s ease-in-out",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};

export default config;
