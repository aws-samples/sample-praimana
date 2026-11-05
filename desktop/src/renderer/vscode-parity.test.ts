import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { hex as paletteHex, TOKEN_NAMES } from "./palette.testkit";

/**
 * THE DESKTOP CHAT MUST LOOK LIKE THE OFFICIAL CLAUDE CODE VS CODE EXTENSION.
 *
 * ── WHY THIS FILE EXISTS ──
 *
 * The layout was first built from a SCREENSHOT, and four things looked right and were wrong: the spinner
 * is a six-glyph cycle rather than a rotating ✳, the activity words are the extension's own 84 rather than
 * the CLI binary's 145, the "bullets" are a timeline with a connecting rule, and the tool panel's clip is a
 * gradient mask rather than a crop. Reading the extension's real stylesheet caught all four.
 *
 * So the values in our source are now COPIES of someone else's, and a copy with no test is a copy that
 * drifts. These assertions read the INSTALLED EXTENSION and compare.
 *
 * ── ⚠ SKIPPED, NOT FAILED, WHEN THE EXTENSION IS ABSENT ──
 *
 * CI has no VS Code and no `~/.vscode/extensions`. A hard failure there would be a test asserting a fact
 * about the developer's laptop, which is not a property of this repository — and the standing rule is
 * never to weaken an assertion to get green, so the honest form is to skip with the reason visible rather
 * than to soften the comparison. On a machine that HAS the extension, every assertion below runs for real.
 */

/**
 * Newest installed `anthropic.claude-code-*` webview directory, or null.
 *
 * ⚠ ORDERED BY VERSION NUMBER, NOT BY STRING. A plain `.sort()` compares digit by digit, so the first
 * time a component rolls past a power of ten — `2.1.99` then `2.1.100` — it ranks the OLDER build
 * highest and every assertion below silently compares against a stale bundle. Nothing fails; the test
 * just stops testing the thing it names, which is the worse outcome of the two.
 */
function findWebview(): string | null {
  const root = join(homedir(), ".vscode", "extensions");
  if (!existsSync(root)) return null;
  /** `anthropic.claude-code-2.1.247-darwin-arm64` -> [2, 1, 247]; missing parts sort lowest. */
  const version = (dir: string): number[] =>
    (dir.match(/-(\d+(?:\.\d+)*)/)?.[1] ?? "0").split(".").map(Number);
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith("anthropic.claude-code-"))
    .sort((a, b) => {
      const [va, vb] = [version(a), version(b)];
      for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const diff = (va[i] ?? 0) - (vb[i] ?? 0);
        if (diff !== 0) return diff;
      }
      // Same version, two platform builds: fall back to the name so the choice is deterministic.
      return a.localeCompare(b);
    });
  for (const dir of dirs.reverse()) {
    const candidate = join(root, dir, "webview");
    if (existsSync(join(candidate, "index.css")) && existsSync(join(candidate, "index.js"))) {
      return candidate;
    }
  }
  return null;
}

const webview = findWebview();
const read = (p: string) => readFileSync(p, "utf8");
const local = (rel: string) => read(fileURLToPath(new URL(rel, import.meta.url)));

const TAILWIND = read(
  fileURLToPath(new URL("../../tailwind.config.ts", import.meta.url))
);
const ACTIVITY = local("./components/ActivityPhrase.tsx");
const TOOL_STEP = local("./components/ToolStep.tsx");

/** `describe.skipIf` keeps the reason on screen instead of silently passing zero tests. */
const withExtension = describe.skipIf(webview === null);

withExtension("colours are the extension's, not chosen by eye", () => {
  it("the timeline dot colours match .dotSuccess / .dotFailure / .dotWarning", () => {
    /**
     * Parsed out of the extension's own rules rather than hardcoded here — a hardcoded expectation would
     * just be a second copy of the same guess, and would not notice an upstream change.
     */
    const css = read(join(webview!, "index.css"));
    const hexFor = (dotClass: string) =>
      css.match(
        new RegExp(`\\.dot${dotClass}_[A-Za-z0-9_]+:before\\{background-color:(#[0-9a-f]{6})`, "i")  // nosemgrep: detect-non-literal-regexp,missing-template-string-indicator
      )?.[1];

    const success = hexFor("Success");
    const failure = hexFor("Failure");
    const warning = hexFor("Warning");

    expect(success, "could not parse .dotSuccess from the extension").toBeTruthy();
    /* App side reads the DARK palette (index.css): the extension is dark, so that is the mode that must
       match it. Values moved out of the config into the stylesheet — see palette.testkit. */
    expect(paletteHex("tool-ok", "dark"), `tool.ok must be ${success}`).toBe(success);
    expect(paletteHex("tool-error", "dark"), `tool.error must be ${failure}`).toBe(failure);
    expect(paletteHex("tool-warning", "dark"), `tool.warning must be ${warning}`).toBe(warning);
  });

  it("the terracotta accent matches --app-claude-orange", () => {
    const css = read(join(webview!, "index.css"));
    const orange = css.match(/--app-claude-orange:(#[0-9a-f]{6})/i)?.[1];

    expect(orange, "could not parse --app-claude-orange").toBeTruthy();
    expect(paletteHex("claude-accent", "dark")).toBe(orange);
  });
});

withExtension("the spinner is the extension's glyph cycle", () => {
  it("uses the same six base glyphs in the same order", () => {
    /**
     * The extension's `zQe=["·","✢","*","✶","✻","✽"]`. A rotating ✳ was the screenshot-era guess and it is
     * a different animation entirely — one glyph turning versus six glyphs pulsing.
     */
    const js = read(join(webview!, "index.js"));
    const glyphs = js.match(/=\["·","✢","\*","✶","✻","✽"\]/);

    expect(glyphs, "the extension's glyph array moved or changed").toBeTruthy();
    expect(ACTIVITY).toContain('["·", "✢", "*", "✶", "✻", "✽"]');
  });

  it("plays them forward then REVERSED, as the extension does", () => {
    // `UQe=[...zQe,...[...zQe].reverse()]` — ten frames from six glyphs, so the cycle reads as a pulse
    // rather than a loop with a visible seam.
    expect(ACTIVITY).toContain("[...SPINNER_BASE, ...[...SPINNER_BASE].reverse()]");
  });

  it("advances every 120ms", () => {
    const js = read(join(webview!, "index.js"));
    expect(js, "the extension's 120ms interval changed").toMatch(/\},120\)/);
    expect(ACTIVITY).toContain("SPINNER_MS = 120");
  });
});

/**
 * The extension's own activity-word array, parsed from its bundle. Shared by the exact-match
 * assertion and the anglicisation guard below so the two cannot disagree about what "upstream" is.
 */
function upstreamActivityWords(): string[] | null {
  if (!webview) return null;
  const js = read(join(webview, "index.js"));
  const start = js.indexOf('["Accomplishing","Actioning"');
  if (start < 0) return null;
  return [...js.slice(start, js.indexOf("]", start) + 1).matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
}

withExtension("the activity words are the EXTENSION'S list", () => {
  it("matches it exactly — same words, same order, same count", () => {
    /**
     * ⚠ THE LIST THAT WAS ALREADY WRONG ONCE. This file previously carried the CLI BINARY'S 145 words,
     * which overlap heavily but differ in both directions: the extension has Coalescing, Spelunking,
     * Sussing and Schlepping; the CLI has Moonwalking, Gitifying and Quantumizing. Comparing the whole
     * array rather than spot-checking a few is what makes that detectable.
     */
    const upstream = upstreamActivityWords();
    expect(upstream, "the extension's word array moved").not.toBeNull();

    const ours = [
      ...(ACTIVITY.match(/const ACTIVITY_WORDS = \[([\s\S]*?)\] as const;/)?.[1] ?? "").matchAll(
        /"([A-Za-z]+)"/g
      ),
    ].map((m) => m[1]);

    expect(upstream!.length, "sanity: parsed the upstream list").toBeGreaterThan(50);
    expect(ours).toEqual(upstream);
  });

  it("has no duplicates, so the no-repeat rotation cannot repeat anyway", () => {
    const ours = [
      ...(ACTIVITY.match(/const ACTIVITY_WORDS = \[([\s\S]*?)\] as const;/)?.[1] ?? "").matchAll(
        /"([A-Za-z]+)"/g
      ),
    ].map((m) => m[1]);

    expect(new Set(ours).size).toBe(ours.length);
  });

  /**
   * ⚠ REPLACED. This assertion used to pin three specific words - "keeps the British
   * spellings, which are Anthropic's copy and not typos", requiring Channelling, Philosophising and
   * Unravelling. It was right when written and it became wrong, because upstream changed those three
   * to Channeling / Philosophizing / Unraveling.
   *
   * ⚠ AND IT THEN DIRECTLY CONTRADICTED the `toEqual(upstream)` assertion above it: one test demanded
   * our list match the installed extension, the other demanded three words that no longer appear in
   * it. Both could not pass. Two tests in one file asserting opposite things is worse than either
   * being wrong on its own, because whichever one you look at first looks authoritative.
   *
   * So this now asserts the DURABLE property - no anglicisation drift in either direction - rather
   * than a snapshot of upstream's spelling choices on one particular day. The exact list is already
   * pinned by `toEqual(upstream)`; this catches the specific failure mode that motivated the
   * original assertion, a reviewer "correcting" copied text, without hardcoding which spelling
   * convention upstream currently prefers.
   */
  it("has not been anglicised away from the extension's own spellings", () => {
    const ours = [
      ...(ACTIVITY.match(/const ACTIVITY_WORDS = \[([\s\S]*?)\] as const;/)?.[1] ?? "").matchAll(
        /"([A-Za-z]+)"/g
      ),
    ].map((m) => m[1]);
    const upstream = upstreamActivityWords();
    if (!upstream) return; // withExtension already guards, but keep this honest if it is reused.

    // Any word differing ONLY by a -ise/-ize or -lling/-ling swap is the anglicisation mistake this
    // guards against, and is reported by name rather than as a bulk list diff.
    const fold = (w: string) => w.toLowerCase().replace(/s(e|ing|ed)\b/g, "z$1").replace(/ll/g, "l");
    const drifted = ours.filter((w) => {
      if (upstream.includes(w)) return false;
      return upstream.some((u) => fold(u) === fold(w));
    });

    expect(
      drifted,
      "these words differ from the extension only by spelling convention - copy them verbatim, " +
        "do not correct them in either direction",
    ).toEqual([]);
  });
});

withExtension("the tool panel's geometry is the extension's", () => {
  it("clips OUT at 60px with a 50px→60px gradient MASK, not a crop", () => {
    /**
     * `.toolBodyRowContent:not(.disableClipping){ mask-image:linear-gradient(to bottom,<bg> 50px,
     * transparent 60px); max-height:60px }`. A plain `overflow:hidden` cut would guillotine the last line
     * mid-glyph; the mask fades it, which is what makes the panel read as "there is more" rather than
     * "this is the end".
     */
    const css = read(join(webview!, "index.css"));
    expect(css).toContain("mask-image:linear-gradient(to bottom,");
    expect(css).toContain("50px,transparent 60px)");

    expect(TOOL_STEP).toContain("max-h-[60px]");
    expect(TOOL_STEP).toContain("mask-image:linear-gradient(to_bottom,#000_50px,transparent_60px)");
  });

  it("uses .5px hairline borders", () => {
    // `.toolBody{border:.5px …}` — a true hairline on a 2x display. 1px is visibly heavier.
    const css = read(join(webview!, "index.css"));
    expect(css).toMatch(/\.toolBody_[A-Za-z0-9_]+\{border:\.5px solid/);
    expect(TOOL_STEP).toContain("border-[.5px]");
  });

  it("lays the IN/OUT rows out as a subgrid", () => {
    /**
     * `.toolBodyGrid{grid-template-columns:max-content 1fr}` with `.toolBodyRow{grid-template-columns:
     * subgrid}`. Two independently-sized flex rows would drift out of alignment the moment one label was
     * wider than the other; the shared column track is what keeps a column of these scannable.
     */
    const css = read(join(webview!, "index.css"));
    expect(css).toContain("grid-template-columns:max-content 1fr");
    expect(css).toContain("grid-template-columns:subgrid");

    expect(TOOL_STEP).toContain("grid-cols-[max-content_1fr]");
    expect(TOOL_STEP).toContain("grid-cols-subgrid");
  });

  it("labels the rows IN and OUT", () => {
    const js = read(join(webview!, "index.js"));
    expect(js).toContain('children:"IN"');
    expect(js).toContain('children:"OUT"');
    expect(TOOL_STEP).toContain('label="IN"');
    expect(TOOL_STEP).toContain('label="OUT"');
  });

  it("bolds the tool name and keeps the description secondary", () => {
    // `.toolNameText{margin-right:4px;font-weight:700}` beside the secondary-foreground description.
    const css = read(join(webview!, "index.css"));
    expect(css).toMatch(/\.toolNameText_[A-Za-z0-9_]+\{margin-right:4px;font-weight:700\}/);
    expect(TOOL_STEP).toContain("mr-1 font-bold");
  });
});

withExtension("the timeline spine is the extension's, dot and rule", () => {
  it("places a 7px dot and a 1px connecting rule at the same offsets", () => {
    /**
     * `.timelineMessage{padding-left:30px}` with `:before{width:7px;height:7px;top:15px;left:9px}` and
     * `:after{width:1px;left:12px}`. The half-pixel offset between dot centre (12.5px) and rule (12px) is
     * REPRODUCED rather than "fixed", because matching is the goal.
     */
    const css = read(join(webview!, "index.css"));
    expect(css).toContain("padding-left:30px");

    /**
     * ⚠ REWRITTEN BECAUSE THE TEST BROKE AND THE CODE WAS RIGHT.
     *
     * This used to assert the literal substring "width:7px;height:7px;top:15px;left:9px". Extension
     * 2.1.281 reordered those declarations and refactored the offset into
     * `top:calc(var(--message-padding-top,8px) + 7px)`. The GEOMETRY is unchanged - 8 + 7 = 15px, the
     * same dot in the same place - but a fixed-order string match cannot see that, so the assertion
     * failed while reporting nothing true about our code.
     *
     * A brittle assertion that fails on a no-op upstream refactor is worse than no assertion: it
     * trains people to expect this file to be red, which is exactly how the REAL drift it caught in
     * the activity-word list would have been waved through. So it now parses the rule and checks each
     * property, and computes the calc rather than string-matching it.
     */
    const dot = css.match(/\.timelineMessage[A-Za-z0-9_]*:before\{([^}]*)\}/)?.[1] ?? "";
    expect(dot, "parsed the timeline dot rule").toBeTruthy();
    expect(dot, "7px dot").toMatch(/width:7px/);
    expect(dot, "7px dot").toMatch(/height:7px/);
    expect(dot, "9px from the left edge").toMatch(/left:9px/);

    // `top` is either a literal 15px (<=2.1.247) or calc(var(--message-padding-top,<pad>) + <off>)
    // (>=2.1.281). Both must come to 15px, which is what our hardcoded top-[15px] copies.
    const topCalc = dot.match(/top:calc\(var\(--message-padding-top,\s*(\d+)px\)\s*\+\s*(\d+)px\)/);
    const topLiteral = dot.match(/top:(\d+)px/);
    const topPx = topCalc
      ? Number(topCalc[1]) + Number(topCalc[2])
      : Number(topLiteral?.[1] ?? NaN);
    expect(
      topPx,
      "the dot's vertical offset must still resolve to 15px; if upstream changed the " +
        "--message-padding-top default or the addend, our top-[15px] has to follow",
    ).toBe(15);

    // The connecting rule: 1px wide at left:12px, giving the deliberate half-pixel offset from the
    // dot's 12.5px centre that the docblock above explains is reproduced rather than "fixed".
    const spine = css.match(/\.timelineMessage[A-Za-z0-9_]*:after\{([^}]*)\}/)?.[1] ?? "";
    expect(spine, "parsed the timeline spine rule").toBeTruthy();
    expect(spine, "1px connecting rule").toMatch(/width:1px/);
    expect(spine, "at 12px, half a pixel off the dot centre").toMatch(/left:12px/);

    expect(TOOL_STEP).toContain("pl-[30px]");
    expect(TOOL_STEP).toContain("h-[7px] w-[7px]");
    expect(TOOL_STEP).toContain("top-[15px]");
    expect(TOOL_STEP).toContain("left-[9px]");
    expect(TOOL_STEP).toContain("left-[12px]");
  });

  it("⚠ an in-progress dot BLINKS and takes no colour of its own", () => {
    /**
     * `.dotProgress:before{animation:1s linear infinite blink}` — with NO background-color. That is why
     * there is no third colour token: a running step keeps the default foreground and pulses. Inventing an
     * amber "running" hue was the screenshot-era guess.
     */
    const css = read(join(webview!, "index.css"));
    const rule = css.match(/\.dotProgress_[A-Za-z0-9_]+:before\{([^}]*)\}/)?.[1] ?? "";

    expect(rule, "parsed the .dotProgress rule").toBeTruthy();
    expect(rule).toContain("infinite");
    expect(rule, "upstream still gives it no colour").not.toContain("background-color");

    expect(TOOL_STEP, "ours blinks too").toContain("animate-dot-blink");
    expect(TAILWIND, "1s linear, as upstream").toContain('"dot-blink 1s linear infinite"');
  });

  it("uses the same blink keyframe shape", () => {
    // `0%,to{opacity:1} 50%{opacity:0}` — opacity only, so it composites and never triggers layout.
    const css = read(join(webview!, "index.css"));
    expect(css).toMatch(/@keyframes blink_[A-Za-z0-9_]+\{0%,to\{opacity:1\}50%\{opacity:0\}\}/);
    expect(TAILWIND).toContain('"50%": { opacity: "0" }');
  });
});

withExtension("the token formatter is the extension's", () => {
  it("is a bare integer below 1000 and one decimal + k above", () => {
    // Upstream `Xbe`: `${e<1000?String(e):`${(e/1000).toFixed(1)}k`} tokens`.
    const js = read(join(webview!, "index.js"));
    /**
     * ── ⚠ THE SHAPE, NOT THE MINIFIER'S VARIABLE NAME ─────────────────────────────────────────
     *
     * This was `toContain("e<1000?String(e):…")`, pinning the identifier esbuild happened to assign
     * upstream. It held for 2.1.239 and 2.1.241 and broke on 2.1.246, where the same expression is
     * minified as `$<1000?String($):…` — verified across all four installed versions. Upstream's
     * BEHAVIOUR never changed; only a name nobody chose did, so the test was reporting a drift that
     * had not happened, on a machine that had merely auto-updated.
     *
     * ⚠ AND IT IS NOT LOOSER FOR IT. The backreference requires the SAME identifier in all three
     * positions, so the numbers stay pinned exactly: `<1000`, `/1000`, `toFixed(1)` and the literal
     * `k`. Confirmed by construction — a mismatched-name, `<10000` or `toFixed(2)` variant all fail
     * this pattern, which is the whole point of asserting a shape rather than a substring.
     */
    expect(js).toMatch(
      /([A-Za-z_$][\w$]*)<1000\?String\(\1\):`\$\{\(\1\/1000\)\.toFixed\(1\)\}k`/
    );

    const ours = local("./lib/transcript.ts");
    expect(ours).toContain("if (n < 1000) return String(Math.floor(n));");
    expect(ours).toContain("toFixed(1)}k");
  });
});

/**
 * These run EVERYWHERE, including CI. They assert properties of this repository rather than of the
 * developer's laptop, so there is nothing to skip.
 */
describe("the reference status-line format", () => {
  it("keeps the exact glyphs `·` and `↓` and the ellipsis character", () => {
    /**
     * `Herding… (15m 28s · ↓ 38.9k tokens)` is the reference format, verbatim. Quoted UI copy, so a
     * "tidier" ASCII `-`, `v` or `...` is a regression rather than a cleanup. The behavioural assertion
     * lives in transcript.test.ts; this one guards the CHARACTERS in the source.
     */
    const ours = local("./lib/transcript.ts");
    expect(ours).toContain("· ↓ ");
    expect(ACTIVITY, "the trailing ellipsis is one character, not three dots").toContain("}…`");
  });
});

describe("⚠ CHAT HISTORY AND SHARING SURVIVED THE REBUILD", () => {
  /**
   * AN EXPLICIT REQUIREMENT: chat history and chat sharing must both keep working.
   *
   * A fair thing to worry about. This change rewrote the transcript, the state model and the palette of the
   * component that HOSTS both features, and a re-theming pass is exactly the kind of edit that quietly
   * deletes a branch it was only supposed to recolour. Type-check would not notice: a dropped `<button>` is
   * still valid TSX.
   *
   * So this pins the CONTROLS and their HANDLERS together. A control with no handler is a dead button, and a
   * handler with no control is unreachable code — both look fine in a diff.
   */
  const chat = local("./components/AssistantChatView.tsx");
  /** Comments discuss these features at length, so they would defeat presence checks. */
  const code = chat.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the history panel still renders, with both tabs", () => {
    expect(code).toContain("{showHistory && (");
    expect(code).toContain("Chat History");
    expect(code, "my own chats").toContain(">\n              Chats\n            </button>");
    expect(code, "teammates' shared chats").toContain("Team Chats");
    expect(code).toContain('setHistoryTab("mine")');
    expect(code).toContain('setHistoryTab("team")');
  });

  it("the panel's visibility is still PERSISTED across launches", () => {
    // It is a preference, and a preference that resets on restart is not one. Easy to lose in a re-theme
    // since the setting write lives in the toggle rather than in the markup.
    expect(code).toContain('api.setSetting("chat_history_visible"');
    expect(code).toContain('api.getSetting("chat_history_visible")');
  });

  it("selecting a past chat still loads its messages", () => {
    // The entire point of the panel. `handleSelectSession` must both persist the choice and load the rows.
    expect(code).toContain("onClick={() => handleSelectSession(session)}");
    expect(code).toMatch(/async function handleSelectSession[\s\S]{0,320}loadMessages\(session\.id\)/);
    expect(code).toMatch(/async function handleSelectSession[\s\S]{0,320}active_session_id/);
  });

  it("the last active chat is still restored on launch", () => {
    // A restart must not drop the participant into a blank chat; history is in SQLite for this reason.
    expect(code).toMatch(/getSetting\("active_session_id"\)[\s\S]{0,200}handleSelectSession\(last\)/);
  });

  it("Share and Unshare are both still present AND wired to their handlers", () => {
    expect(code).toContain("onClick={handleShare}");
    expect(code).toContain("onClick={handleUnshare}");
    expect(code).toContain("api.shareSession(activeSession.id)");
    expect(code).toContain("api.unshareSession(activeSession.id)");
  });

  it("⚠ sharing still CONFIRMS before publishing the conversation", () => {
    /**
     * THE ASSERTION THAT MATTERS MOST IN THIS BLOCK. Sharing publishes a whole transcript to everyone on the
     * team — outward-facing and awkward to undo socially even though `unshareSession` exists. The confirm
     * dialog is a safety mechanism, and the standing rule is that safety mechanisms are never removed to
     * tidy a flow.
     */
    expect(code).toMatch(/window\.confirm\([\s\S]{0,200}Share this chat with your team/);
    expect(code, "and a declined confirm must abort").toContain("if (!confirmed) return;");
    /**
     * ⚠ AND THE RESULT MUST NOT BE SHORT-CIRCUITED. Asserting the dialog is CALLED is not enough:
     * `const confirmed = true || window.confirm(…)` leaves the call in the source, keeps the guard below
     * it, and still publishes without asking. A mutation test proved that exact bypass slipped past the
     * two assertions above, so the assignment itself is pinned.
     */
    expect(code).toMatch(/const confirmed = window\.confirm\(/);
  });

  it("sharing is still refused without a team, rather than failing at the API", () => {
    // A clear message beats a 4xx surfaced as a toast.
    expect(code).toMatch(/if \(!hasTeam\)[\s\S]{0,140}Join a team before sharing/);
  });

  it("the shared-state dot and badge still reflect `shared_at`", () => {
    // The only way to tell, from the list, which chats are already published.
    expect(code).toContain("{session.shared_at && (");
    expect(code).toContain("activeSession.shared_at ? (");
  });

  it("a teammate's shared chat still opens in the read-only viewer", () => {
    expect(code).toContain("onClick={() => openSharedThread(thread)}");
    // The fetch now lives in `makeSharedFetcher`, which the panel calls with its paginate/tail args.
    expect(code).toContain("api.getSharedMessages(threadId, args)");
    /**
     * ⚠ IN THE WINDOW NOW, NOT A POPUP. The read-only viewer used to be a `fixed inset-0` modal gated on
     * `{viewingThread && (`; it now renders in the chat column like the chat window
     * itself. It is now the `SharedThreadPanel`, shown full-column while `viewingThread && !pinnedThread`
     * and docked as a second pane while `pinnedThread` is set.
     */
    expect(code).toContain("<SharedThreadPanel");
    expect(code).toContain("{viewingThread && !pinnedThread ?");
    // READ-ONLY: the panel has NO composer — it takes `thread`/`fetcher`/`onClose`, never a textarea.
    expect(code, "the SharedThreadPanel renders no textarea").not.toMatch(
      /function SharedThreadPanel\([\s\S]*?<textarea/
    );
  });

  it("a shared chat can be PINNED beside the live chat and kept live", () => {
    /**
     * The pin docks a teammate's thread as a second column so the participant keeps working while watching
     * it. Session-only (never written to settings), polled every 15s, and refreshed at once on an
     * `ai-share` event. The live indicator confirms it is polling.
     */
    expect(code, "a pin toggle exists").toContain("onTogglePin");
    expect(code, "pinning moves a thread into the dock").toContain("function pinSharedThread");
    expect(code, "and unpinning clears it").toContain("function unpinSharedThread");
    expect(code, "polled on a 15s interval").toMatch(/setInterval\([\s\S]{0,80}15_000\)/);
    expect(code, "with a live indicator").toContain("<LiveIndicator");
    // Session-only: the pinned thread must never be persisted to settings.
    expect(code, "pin state is not persisted").not.toMatch(/setSetting\([^)]*pinned[_-]?thread/i);
  });

  it("the Team Chats list still refreshes when a teammate shares", () => {
    // Pushed over the team SSE stream; without this the list is stale until the panel is reopened.
    expect(code).toMatch(/kind === "ai-share"[\s\S]{0,80}loadSharedThreads\(\)/);
  });

  it("⚠ EVERY SURFACE IS DARK NOW — the conditional era is over", () => {
    /**
     * ⚠ THIS ASSERTION WAS INVERTED, and deliberately.
     *
     * It used to require every dark background to be gated on `usesTimeline`, because Codex kept the LIGHT
     * bubbles and would otherwise have inherited a half-dark window. Codex's background was then white, not
     * matching Claude and Kiro — so Codex took the dark surface too, and the rule it was enforcing
     * became the bug.
     *
     * What replaced it is a SEPARATION the old single flag conflated:
     *
     *   `usesDarkSurface`  the palette. True for every assistant.
     *   `usesTimeline`     the LAYOUT — timeline versus bubbles. Claude only, still deferred for Codex.
     *
     * Wiring the palette to the layout predicate is what made deferring Codex's transcript also leave it white.
     * The names are now the documentation.
     */
    expect(code, "the palette flag exists and is unconditional").toMatch(
      /const usesDarkSurface = true;/
    );
    expect(code, "and the layout flag is still Claude-only").toContain("const usesTimeline = usesSdk");

    /**
     * The property that matters now: no LIGHT background survives in the chat chrome at all. The
     * shared-chat viewer USED TO be exempt — it was a light `fixed inset-0` modal over the app's chrome —
     * but it is now an in-window dark pane (`SharedThreadPanel`, `surface-*` tokens), so there is no longer
     * a light region to carve out. The whole source is checked.
     */
    expect(code, "the old light modal is gone").not.toContain("fixed inset-0 z-50");

    const light = [
      ...code.matchAll(
        /className="[^"{]*\b(?:bg|text|border)-(?:white|gray|blue|red|green|amber|yellow)-\d+[^"]*"/g
      ),
    ].map((m) => m[0].slice(0, 80));
    expect(light, "no light classes left in the chat chrome").toEqual([]);
  });});

describe("⚠ THE DARK SURFACE MATCHES THIS APP, NOT VS CODE", () => {
  /**
   * The first version copied the extension's webview literally — #1f1f1f, #262626 — which are NEUTRAL
   * greys. This app's own sidebar and titlebar are Tailwind `gray-900` (#111827), a distinctly COOL
   * blue-black. Side by side, the chat read as a foreign panel bolted onto the app: same darkness, visibly
   * different hue.
   *
   * These assertions compare against the app's ACTUAL chrome rather than against a value typed twice.
   */
  const SIDEBAR = local("./components/Sidebar.tsx");
  const APP = local("./App.tsx");

  /** Tailwind 3's `gray` scale — the source of the app's chrome. */
  const GRAY = { 900: "#111827", 800: "#1f2937", 700: "#374151", 400: "#9ca3af", 200: "#e5e7eb" };

  it("the app chrome this must match is the surface-bg TOKEN, not a literal", () => {
    /**
     * ⚠ THE PREMISE, CHECKED FIRST. Every assertion below is only meaningful while the sidebar and titlebar
     * really are the app's base surface. If someone restyles them, this test should fail HERE with a clear
     * reason rather than silently keep pinning the chat to a colour nothing else uses any more.
     *
     * ⚠ AND IT DID ITS JOB. It failed when the sidebar and titlebar moved off `bg-gray-900` — which was not
     * a restyle but a BUG FIX: a literal grey cannot follow the theme, so the left panel and the header
     * frame stayed dark in light mode (reported). The premise is now the token, which is the thing that
     * must hold; `surface-bg` still RESOLVES to gray-900 in dark, and the assertion below pins that, so the
     * parity this file exists to protect is unchanged in dark and finally correct in light.
     */
    expect(SIDEBAR, "the sidebar column").toContain("bg-surface-bg");
    expect(APP, "the titlebar").toContain("bg-surface-bg");
    // No literal may creep back into either surface — that is what broke light mode.
    expect(SIDEBAR, "the sidebar column").not.toContain("bg-gray-900");
    expect(APP, "the titlebar").not.toContain("bg-gray-900");
  });

  it("surface.bg IS the sidebar's colour", () => {
    expect(paletteHex("surface-bg", "dark")).toBe(GRAY[900]);
  });

  it("panel and raised come from the same scale", () => {
    // gray-800 and gray-700 — the values the sidebar already uses for its own sections and hover states,
    // so the chat's depth steps are the app's depth steps.
    expect(paletteHex("surface-panel", "dark")).toBe(GRAY[800]);
    expect(paletteHex("surface-raised", "dark")).toBe(GRAY[700]);
    expect(paletteHex("surface-line", "dark")).toBe(GRAY[700]);
  });

  it("⚠ VS CODE'S NEUTRAL GREYS ARE GONE", () => {
    /**
     * The actual regression. These are the exact values that produced the reported mismatch, so their
     * absence is the check — a future "let me match the screenshot more closely" pass would reintroduce
     * precisely these.
     *
     * ⚠ COMMENTS STRIPPED FIRST, and the reason is the first version of this test: the config's own docblock
     * explains the change by NAMING the old values, so a whole-file scan failed on its own documentation.
     * A test that cannot tell a value from the prose about it would have forced deleting the explanation to
     * go green — which is the wrong half to give up.
     */
    /* Values live in index.css now, and BOTH modes are scanned — light did not exist when this was
       written, and a neutral grey creeping into either palette is the regression. */
    for (const mode of ["dark", "light"] as const) {
      for (const token of TOKEN_NAMES) {
        for (const neutral of ["#1f1f1f", "#262626", "#2d2d2d", "#333333"]) {
          expect(paletteHex(token, mode), `${neutral} in ${mode}`).not.toBe(neutral);
        }
      }
    }
  });

  it("the text tokens are from the app's scale too", () => {
    expect(paletteHex("surface-text", "dark")).toBe(GRAY[200]);
    expect(paletteHex("surface-muted", "dark")).toBe(GRAY[400]);
  });

  it("⚠ but the STATUS colours stay Claude's", () => {
    /**
     * The split is deliberate and worth pinning: the surfaces became ours, the dot vocabulary did not. Those
     * hues are a status language a Claude Code user already reads fluently, so restyling them would cost
     * recognition for no gain. What had to match the app was the BACKGROUND.
     */
    expect(paletteHex("tool-ok", "dark")).toBe("#74c991");
    expect(paletteHex("claude-accent", "dark")).toBe("#d97757");
  });

  it("⚠ contrast is DOCUMENTED against the new surfaces, including the failures", () => {
    /**
     * The backgrounds changed, so every ratio changed with them — and two tokens now FAIL on `raised`
     * (muted 4.06:1, faint 3.33:1 against a 4.5:1 floor). That is recorded as a constraint on where they may
     * be used rather than quietly ignored, because the token names do not encode it.
     */
    /* The measured ratios moved to index.css beside the values they describe. */
    const css = local("./index.css");
    expect(css, "the measured figures are stated").toContain("14.33");
    expect(css, "and so is the documented failure").toContain("4.06");
  });
});

describe("the composer — input, buttons and the model row", () => {
  const chat = local("./components/AssistantChatView.tsx");
  const code = chat.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /**
   * ── ⚠ THE PICKER'S INTERNALS MOVED FILE; THE ASSERTIONS FOLLOWED THEM ────────────────────
   *
   * `ModelPicker` was a private function in `AssistantChatView.tsx` and is now `components/ModelPicker.tsx`, because
   * Kiro's composer needed the SAME control rather than a copy of it — the reasoning `SendIcon` already
   * carries, and the requirement is model choice on Kiro and Claude as well.
   *
   * ⚠ EVERY ASSERTION BELOW IS KEPT, just pointed at whichever file now owns the claim. Splitting them this
   * way is deliberate: relaxing them to search both files concatenated would let the native `<select>`
   * disappear from the picker and still pass because some other file happened to contain the word.
   *
   *   `code`   — what CHATVIEW must still do: read the handler's default and render the picker with it.
   *   `picker` — what the CONTROL must still do: native select, 1M badge, default-vs-chosen.
   */
  const picker = local("./components/ModelPicker.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("names the DEFAULT MODEL rather than saying 'Uses CLI default'", () => {
    expect(code, "the vague label is gone").not.toContain("Uses CLI default");
    expect(code, "and the handler's defaultModel is finally read").toContain("result?.defaultModel");
    /* `resolveModel` went with the control it serves — see the note above this describe's `picker`. */
    expect(picker, "the picker resolves the default into a name").toContain("resolveModel(");
    /**
     * ⚠ AND THE PICKER IS ACTUALLY RENDERED, with the default fed into it.
     *
     * Mutation testing found this gap: the assertions above all passed while the component was renamed out
     * of existence, because none of them said the composer USES it. "The helper exists" and "the UI calls
     * it" are different claims, and only the second one is what the reader sees.
     */
    expect(code).toMatch(/<ModelPicker[\s\S]*?defaultModel=\{defaultModel\}/);
    /**
     * ⚠ ONE MUTATION HERE IS UNCATCHABLE AND THAT IS FINE. Renaming the component AND its call site together
     * survives every assertion in this file — correctly, because a symmetric rename changes no behaviour;
     * it is a refactor, not a regression. Removing the render REALLY breaks it, and that is caught by the
     * type-checker rather than here. Recorded so the gap is not mistaken for an oversight.
     */
  });

  it("⚠ THE TEXTAREA IS readOnly WHILE STREAMING, NOT disabled", () => {
    /**
     * A behaviour fix carried by the restyle, and the assertion that stops it regressing. A `disabled`
     * textarea drops focus when a turn starts and cannot take it back, so the participant had to click into
     * the box again after EVERY reply. `readOnly` keeps focus and the caret while still refusing input, and
     * the Enter guard already prevents a send.
     */
    expect(code).toContain("readOnly={streaming}");
    expect(code).toContain("aria-disabled={streaming}");
    expect(code, "no disabled attribute on the composer textarea").not.toMatch(
      /placeholder=\{streaming[\s\S]{0,300}\sdisabled=\{streaming\}/
    );
  });

  it("the keyboard hint is a real element, not the placeholder", () => {
    // A placeholder vanishes the moment you type, so the one affordance a new user needs disappeared exactly
    // when they were about to use it.
    // The glyphs live in `ComposerKeyHint` now, alongside an sr-only sentence for screen readers —
    // the point of this case (a real element, not a vanishing placeholder) is unchanged.
    expect(code).toContain("<ComposerKeyHint");
    expect(code).not.toContain("(Shift+Enter for newline)");
  });

  it("Stop is a neutral square, not a red word", () => {
    // Red on this surface was the loudest thing in the window and read as an error rather than a control.
    expect(code, "the red fill is gone").not.toContain("bg-red-500");
    expect(code).toContain('aria-label="Stop generating"');
  });

  it("Send carries the assistant's brand, on a fill that can hold its glyph", () => {
    /**
     * ⚠ THE COLOUR MOVED OUT OF THIS FILE, AND THE RULE MOVED WITH IT. This asserted
     * `bg-claude-strong text-white` literally — correct while AssistantChatView was Claude-only, and wrong once it
     * also rendered CODEX: "the input model is orange box" was the report. The colours now come from
     * `lib/assistant-theme.ts`, so what this view must do is USE the theme rather than name a hue.
     *
     * The contrast rule the old assertion protected is still enforced, in the place it now lives:
     * `assistant-theme.test.ts` asserts Claude's primary uses `strong` (#a8432c, which carries white at
     * 5.99:1) and never `accent` (#d97757, the indicator token — legal for a glyph, illegal behind words).
     */
    expect(code, "the send button takes its colours from the theme").toMatch(
      /className=\{`flex h-8 w-8[^`]*\$\{theme\.primaryButton\}`\}/
    );
    expect(code, "and no hue is hardcoded on it").not.toContain("bg-claude-strong text-white");
    expect(code).not.toContain("bg-blue-600 px-4 py-2.5");
  });

  it("the model row and the send control share the composer card", () => {
    // The "layout" half of the request: the model is a setting for what you are about to send, so it sits
    // with the thing that sends it rather than stranded on a strip below.
    /**
     * ⚠ HUE-AGNOSTIC, for the same reason as the send button above: the property is that the CARD shows
     * focus, not which colour draws it. The ring is now `theme.ring`, which is Claude's terracotta,
     * Codex's neutral grey or Kiro's blue depending on who is answering.
     */
    expect(code).toMatch(/transition-colors \$\{theme\.ring\}/);
    expect(code).toMatch(/<ModelPicker[\s\S]*?SendIcon/);
  });

  it("⚠ the model dropdown stays a NATIVE select", () => {
    /**
     * It is overlaid at `opacity-0` rather than replaced by a div menu — which keeps the platform dropdown,
     * keyboard behaviour, type-to-select and screen-reader semantics that a custom menu would all have to
     * reimplement. `sr-only` or `hidden` would break it: the element must still occupy the box to receive
     * the click and anchor the menu.
     */
    expect(picker).toMatch(/<select[\s\S]*?opacity-0/);
    expect(picker).toContain('aria-label="Model"');
    expect(picker, "the painted row must not be announced twice").toMatch(
      /aria-hidden="true"[\s\S]*?\{model\.name\}/
    );
  });

  it("shows the 1M badge for the extended-context variant", () => {
    // The most consequential fact about a model choice here — a turn that reads a large repo either fits or
    // does not — and the old row could not express it at all.
    expect(picker).toContain("model.extended && (");
    // Matched with tolerant whitespace: an exact-indentation string would break on any reformat, which
    // makes it a formatting test wearing a behaviour test's name.
    expect(picker).toMatch(/>\s*1M\s*<\/span>/);
  });

  it("distinguishes 'is the default' from 'was chosen'", () => {
    // Two different facts. A reader who cannot tell them apart cannot tell whether their pick took effect.
    expect(picker).toContain("model.isDefault && (");
  });
});

describe("⚠ KIRO IS UNTOUCHED BY ALL OF THIS", () => {
  /**
   * KIRO STAYS UNTOUCHED: this change is only for Claude Code. Kiro runs through its own ACP handler with
   * `--trust-all-tools` and works; this rebuild must be
   * structurally incapable of altering it.
   *
   * STRUCTURE, NOT A PREDICATE, is what makes that true — App.tsx routes on `useAcpMode` to a separate
   * component — so these assertions check the structure.
   */
  const KIRO = local("./components/KiroChatView.tsx");

  it("KiroChatView imports NONE of the new transcript modules", () => {
    // The strongest form available: a component that never imports the code cannot render it, whatever a
    // future predicate in AssistantChatView says.
    for (const mod of ["ToolStep", "lib/transcript", "ActivityPhrase"]) {
      expect(KIRO, `Kiro must not import ${mod}`).not.toContain(mod);
    }
  });

  it("still drives its own ACP channels and no SDK ones", () => {
    expect(KIRO).toContain("api.kiroAcpSend");
    expect(KIRO).not.toContain("claudeSdk");
  });

  it("App.tsx routes Kiro to its own component", () => {
    const app = local("./App.tsx");
    expect(app).toMatch(/useAcpMode \?[\s\S]{0,120}KiroChatView/);
  });

  it("the dark timeline is gated on the SDK predicate, which cannot select kiro", () => {
    /**
     * Belt and braces behind the structural separation. `usesTimeline = usesSdk` and `usesSdk` is an
     * EQUALITY on "claude", so no other assistant — present or future — inherits the dark transcript by
     * default.
     */
    const chat = local("./components/AssistantChatView.tsx");
    const code = chat.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    expect(code).toContain("const usesTimeline = usesSdk");
    expect(code).toContain('const usesSdk = currentCli === "claude"');
    expect(code).not.toMatch(/usesTimeline\s*=\s*currentCli\s*!==/);
  });

  it("⚠ CODEX KEEPS THE BUBBLES, deliberately deferred", () => {
    /**
     * Codex's layout waits for a comparison with the VS Code Codex plugin. The right reference for Codex is its own
     * extension's layout, not this one — and giving it the dark surface would give it a permanently empty
     * timeline and a status line stuck at `↓ 0 tokens`, since only claude-code.ts emits tool and usage
     * frames. So the bubble branch must still exist.
     */
    const chat = local("./components/AssistantChatView.tsx");
    expect(chat, "the light bubble path must survive for Codex").toContain("if (!usesTimeline) {");
    expect(chat).toContain("SHARED_BUBBLE_CLASS");
  });
});
