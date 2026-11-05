import { useState, useEffect, useRef } from "react";
import { formatStatusSuffix } from "../lib/transcript";
import { assistantTheme } from "../lib/assistant-theme";

/**
 * ── THE WAITING INDICATOR ──
 *
 * Replaces a static "Thinking..." that could not distinguish a slow turn from a hung one. A turn
 * legitimately takes 6+ seconds before the first token and an agentic turn with tool use runs far
 * longer, so a participant staring at three bouncing dots has no evidence the app is alive. Three things
 * fix that: a glyph that animates, a word that CHANGES, and — the part that matters most — an
 * elapsed clock and a rising token count.
 *
 * ── EVERY CONSTANT HERE IS COPIED FROM THE EXTENSION, NOT CHOSEN ──
 *
 * Source: `~/.vscode/extensions/anthropic.claude-code-2.1.226-darwin-arm64/webview/index.js`, the
 * component minified as `jQe`. Reading it corrected four things this file previously got wrong by
 * inferring them from a screenshot:
 *
 *   1. The glyph is not a rotating ✳. It is a SIX-FRAME CYCLE `· ✢ * ✶ ✻ ✽` played forward then
 *      backward (`UQe=[...zQe,...[...zQe].reverse()]`) at 120ms a frame.
 *   2. The word list is the EXTENSION'S OWN 84 words, which is not the CLI binary's 145. They overlap
 *      heavily but differ in both directions — the extension has Coalescing, Spelunking, Sussing and
 *      Schlepping, which the CLI lacks; the CLI has Moonwalking, Gitifying and Quantumizing, which the
 *      extension lacks. This file previously carried the CLI's list. The extension is the reference being
 *      compared against, so this is now the extension's.
 *   3. The words do not rotate on a fixed interval. The schedule is `[2000,3000,5000]` and then 5000
 *      for ever — fast at first, settling down.
 *   4. The word is padded to `max(wordLength)+3` so the row cannot reflow, which is the same problem the
 *      old fixed `w-[11rem]` solved by a different means. The extension's approach is kept in spirit
 *      (a reserved box) rather than by literal space-padding, since padding a string is invisible to a
 *      screen reader but a `tabular-nums` fixed box is not.
 *
 * The word list is user-visible copy and it is Anthropic's: copy it verbatim from the installed
 * extension, and do not add, remove or reorder entries.
 *
 * ⚠ UPDATED, AND THE PREVIOUS INSTRUCTION HERE SAID THE OPPOSITE. This comment used to
 * read "do not 'correct' the British spellings (Channelling, Philosophising, Unravelling)" -
 * reasonable at the time, because those were the spellings the extension shipped and they look
 * exactly like the kind of thing a well-meaning reviewer anglicises by mistake.
 *
 * Upstream has since changed them to Channeling / Philosophizing / Unraveling. So the belief the
 * old note protected was falsified by Anthropic themselves, and holding the British forms would
 * have meant defending a copy against the thing it is a copy OF. vscode-parity.test.ts caught the
 * divergence, which is the entire reason that file exists.
 *
 * The durable rule is therefore "match the installed extension", not "keep these three words".
 * If upstream changes spelling again, follow it again.
 */
const ACTIVITY_WORDS = [
  "Accomplishing", "Actioning", "Actualizing", "Baking", "Booping",
  "Brewing", "Calculating", "Cerebrating", "Channeling", "Churning",
  "Clauding", "Coalescing", "Cogitating", "Computing", "Combobulating",
  "Concocting", "Considering", "Contemplating", "Cooking", "Crafting",
  "Creating", "Crunching", "Deciphering", "Deliberating", "Determining",
  "Discombobulating", "Doing", "Effecting", "Elucidating", "Enchanting",
  "Envisioning", "Finagling", "Flibbertigibbeting", "Forging", "Forming",
  "Frolicking", "Generating", "Germinating", "Hatching", "Herding",
  "Honking", "Ideating", "Imagining", "Incubating", "Inferring",
  "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling",
  "Mustering", "Noodling", "Percolating", "Perusing",
  "Philosophizing", "Pontificating", "Pondering", "Processing", "Puttering",
  /**
   * ⚠ DO NOT PUT A WORD IN QUOTES INSIDE THIS ARRAY, EVEN IN A COMMENT. vscode-parity.test.ts reads
   * this array as TEXT and extracts every /"([A-Za-z]+)"/ it finds, so a quoted word in a comment
   * counts as a list entry. The first draft of this note named the removed word in quotes and the
   * parity test went on failing — reporting the word as present, just in a different position.
   *
   * Scheming (no quotes, deliberately) was dropped by extension 2.1.285 and removed here to match.
   * Musing was dropped by extension 2.1.301 and removed here to match.
   */
  "Puzzling", "Reticulating", "Ruminating", "Schlepping",
  "Shimmying", "Simmering", "Smooshing", "Spelunking", "Spinning",
  "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering",
  "Transmuting", "Unfurling", "Unraveling", "Vibing", "Wandering",
  "Whirring", "Wibbling", "Working", "Wrangling",
] as const;

/**
 * The spinner frames, forward then backward — the extension's `UQe`, built from its `zQe` exactly as it
 * does. Ten frames from six glyphs, so the cycle reads as a pulse rather than a loop with a seam.
 */
const SPINNER_BASE = ["·", "✢", "*", "✶", "✻", "✽"] as const;
const SPINNER_FRAMES = [...SPINNER_BASE, ...[...SPINNER_BASE].reverse()];

/** 120ms a frame — the extension's `setInterval(…,120)`. */
const SPINNER_MS = 120;
/**
 * The word schedule, the extension's `[2000,3000,5000]` then 5000 for ever. Deliberately NOT a single
 * interval: early changes prove liveness quickly, and slowing down afterwards stops the row becoming a
 * distraction over a fifteen-minute turn.
 */
const WORD_DELAYS_MS = [2000, 3000, 5000];
const WORD_DELAY_STEADY_MS = 5000;
/** The clock's resolution. One state update per second, on one small component. */
const TICK_MS = 1000;
/**
 * How often the screen-reader sentence is allowed to change. See the a11y note below: 30s means at most
 * two announcements a minute instead of twenty.
 */
const ANNOUNCE_EVERY_MS = 30000;

/**
 * Pick a word that is NOT the one already showing. Rotating into the same word reads as a frozen UI —
 * the exact failure this component exists to cure — and with 84 words an unguarded random pick does that
 * roughly every 12th rotation. Drawing from the 83 OTHER words makes a repeat impossible rather than rare.
 *
 * ⚠ THE EXTENSION DOES NOT DO THIS: its `qj` picks uniformly and can repeat. Kept as a deliberate
 * divergence rather than parity — a duplicate pick is invisible in a terminal that reprints a line, and
 * very visible in a component whose whole job is to look alive.
 */
function nextWordIndex(current: number, poolSize: number): number {
  const i = Math.floor(Math.random() * (poolSize - 1));
  return i < current ? i : i + 1;
}

/**
 * Words carrying a vendor's brand, dropped for any OTHER vendor's assistant.
 *
 * Only one entry qualifies today. It stays in `ACTIVITY_WORDS` because that array is a verbatim copy of the
 * extension's own list and a test asserts it matches exactly — so the filtering happens at the point of USE,
 * which keeps the copy honest while stopping "Clauding…" appearing over a Codex turn.
 */
const BRANDED_WORDS: Record<string, string[]> = {
  Claude: ["Clauding"],
};

/**
 * The rotation pool for one assistant: every word except another vendor's branded ones.
 *
 * Memoised by name — the array is 84 strings and the caller passes a constant, so recomputing it per render
 * would be pure waste on a component that re-renders every second.
 */
const WORD_POOL_CACHE = new Map<string, readonly string[]>();
/**
 * ── ⚠ CODEX DOES NOT NARRATE, AND CLAUDE'S WHIMSY IS CLAUDE'S ─────────────────────────────
 *
 * A previous round removed the one BRANDED word ("Clauding") from Codex's pool and kept the other 83 —
 * Percolating, Simmering, Flibbertigibbeting. They are generic, but they are still Anthropic's product
 * VOICE, and Codex's own UI does not do this: it says it is working and shows a quiet indicator. Rotating
 * "Flibbertigibbeting…" over another vendor's turn is a costume, not a feature.
 *
 * So the STYLE is per assistant, resolved here rather than at the two call sites:
 *
 *   "words"    — the extension's rotating pool, its self-rescheduling 2s/3s/5s cadence and six-frame
 *                glyph. Claude's own behaviour, kept verbatim for Claude.
 *   "thinking" — one steady word and three dots that fade in and out. What was asked for, and what
 *                Codex's own interface does.
 */
export type ActivityStyle = "words" | "thinking";

export function activityStyleFor(assistant: string): ActivityStyle {
  return assistant.toLowerCase().includes("claude") ? "words" : "thinking";
}

function wordsFor(assistant: string): readonly string[] {
  const cached = WORD_POOL_CACHE.get(assistant);
  if (cached) return cached;
  const foreign = new Set(
    Object.entries(BRANDED_WORDS)
      .filter(([owner]) => owner !== assistant)
      .flatMap(([, words]) => words)
  );
  const pool: readonly string[] = foreign.size
    ? ACTIVITY_WORDS.filter((w) => !foreign.has(w))
    : ACTIVITY_WORDS;
  WORD_POOL_CACHE.set(assistant, pool);
  return pool;
}

/** The delay before the Nth word change. Matches the extension's `ege` schedule callback. */
function wordDelayAt(step: number): number {
  return step < WORD_DELAYS_MS.length ? WORD_DELAYS_MS[step] : WORD_DELAY_STEADY_MS;
}

/**
 * The waiting state for an in-flight assistant turn.
 *
 * MOUNT/UNMOUNT IS THE CONTRACT. This component runs timers, so the caller controls it by rendering it
 * or not — there is no "paused" prop. Render it only while genuinely waiting on the assistant and give
 * it a `key` per session so a session switch remounts it with a fresh clock rather than showing another
 * chat's elapsed time.
 *
 * @param retrying `cliStatus === "retrying"`. A fault, not whimsy: the word rotation is suppressed and
 *   replaced with the literal fault text. The clock KEEPS running, because "how long has it been
 *   retrying" is the most useful number on screen at that moment.
 * @param outputTokens Running total from `cli:usage`. Rendered as `↓ 38.9k tokens` — the extension's
 *   format. Zero means "none yet", and the suffix omits the clause rather than printing `↓ 0 tokens`.
 */
export function ActivityPhrase({
  retrying = false,
  outputTokens = 0,
  assistant = "Claude",
  startedAt: startedAt_,
}: {
  retrying?: boolean;
  outputTokens?: number;
  /**
   * The assistant's display name — "Claude", "Codex", "Kiro".
   *
   * TWO separate leaks, and only one of them was the word list:
   *
   *   1. The screen-reader sentence said "Claude is working on your request" for every assistant.
   *   2. `Clauding` is IN the word list, so a Codex user could be told "Clauding…". That list is Anthropic's
   *      product copy, lifted verbatim — putting it over another vendor's turn is wrong in both directions.
   *
   * `wordsFor` filters the branded word rather than replacing the list, because the remaining 83 are generic
   * whimsy (Percolating, Simmering, Wrangling) that read fine over any assistant and are the actual point.
   *
   * Defaults to "Claude" so an un-updated call site behaves exactly as before.
   */
  assistant?: string;
  /**
   * When the TURN started, in epoch ms — owned by the parent, not by this component.
   *
   * This component is rendered with `key={activeId}`, so changing the shown session REMOUNTS it — which is
   * correct for the word rotation and the spinner, but meant the clock restarted from mount every time. The
   * turn's start is a property of the turn, so it now comes from `AssistantChatView.turnStartedAt`, which
   * survives the unmount.
   *
   * Optional, and falling back to mount time, so a caller that has no timestamp (or a turn already in
   * flight when this shipped) still counts up from somewhere sane rather than rendering nothing.
   */
  startedAt?: number;
}) {
  /**
   * Wall-clock start, not an accumulated tick count. Electron throttles timers in a backgrounded window,
   * so counting ticks would silently under-report a wait that happened while the participant was in
   * another app — a frozen number that looks live. Deriving from a timestamp means the counter is
   * correct the instant the window comes back, however badly the timer was throttled or paused.
   */
  const mountedAtRef = useRef(Date.now());
  /**
   * The parent's turn timestamp when it has one, otherwise mount time.
   *
   * ⚠ NOT A `useRef` OF THE PROP. A ref initialised from a prop keeps the FIRST value it ever saw, so
   * a turn that starts while this component is already mounted — the normal case, since it renders as
   * soon as `streaming` flips — would go on measuring from the previous mount. Reading the prop on
   * every render is what makes the number follow the turn.
   */
  const startedAt = startedAt_ ?? mountedAtRef.current;

  /**
   * ONE state object, so the word and the clock land in a SINGLE render per tick instead of two.
   *
   * All of it is scoped HERE rather than in AssistantChatView on purpose: AssistantChatView has an effect that
   * scroll-anchors the transcript on every render, and a once-per-second re-render of the whole chat
   * would fight the scroll position and re-reconcile the entire message list for a ticking counter.
   */
  /**
   * The word pool for THIS assistant, resolved once. Read before the state initialiser because that
   * initialiser picks a starting index into it.
   */
  const words = wordsFor(assistant);
  const style = activityStyleFor(assistant);
  /**
   * ⚠ THE SPINNER GLYPH WAS `text-claude-accent` FOR EVERY ASSISTANT. Only Claude reaches the word
   * variant today, so this is belt-and-braces rather than a live bug — but the same hardcoding is what
   * put Claude's terracotta on Codex's composer, and leaving one instance behind is how it returns.
   */
  const accentClass = assistantTheme(assistant).ink;

  const [state, setState] = useState(() => ({
    elapsedMs: 0,
    wordIndex: Math.floor(Math.random() * words.length),
  }));

  /** The glyph frame. Separate state because it advances eight times more often than anything else. */
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    let clock: ReturnType<typeof setInterval> | null = null;
    let spinner: ReturnType<typeof setInterval> | null = null;
    let word: ReturnType<typeof setTimeout> | undefined;
    let wordStep = 0;

    const tick = () => {
      setState((prev) => ({ ...prev, elapsedMs: Date.now() - startedAt }));
    };

    /**
     * SELF-RESCHEDULING, not an interval, because the delay CHANGES between fires — 2s, then 3s, then
     * 5s for ever. This is the extension's `ege` hook in plain form.
     */
    const scheduleWord = () => {
      word = setTimeout(() => {
        setState((prev) => ({ ...prev, wordIndex: nextWordIndex(prev.wordIndex, words.length) }));
        wordStep += 1;
        scheduleWord();
      }, wordDelayAt(wordStep));
    };

    const start = () => {
      if (clock === null) clock = setInterval(tick, TICK_MS);
      if (spinner === null) {
        spinner = setInterval(() => {
          setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
        }, SPINNER_MS);
      }
      if (word === undefined) scheduleWord();
    };
    const stop = () => {
      if (clock !== null) {
        clearInterval(clock);
        clock = null;
      }
      if (spinner !== null) {
        clearInterval(spinner);
        spinner = null;
      }
      if (word !== undefined) {
        clearTimeout(word);
        word = undefined;
      }
    };

    /**
     * A hidden window paints nothing, so it should not tick — least of all the 120ms spinner. These run
     * for hours on workshop laptops and a backgrounded chat animating a glyph eight times a second is
     * battery spent on pixels nobody can see. `tick()` on the way back in refreshes the clock
     * immediately from the timestamp, so the participant never sees a stale value waiting for the next
     * interval.
     */
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        tick();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);

    // ALL FOUR handles released together. A leaked 120ms interval per turn would accumulate for the
    // whole session on a laptop that never gets restarted, and each leaked one keeps calling setState on
    // an unmounted tree.
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  /**
   * `% words.length` guards a switch BETWEEN assistants: the pools differ in length by one, so an index valid
   * for Claude's 84 can be out of range for Codex's 83 — and `undefined` would render as the literal string
   * "undefined…". The caller keys this component per session, not per assistant, so the switch is reachable.
   */
  const word = words[state.wordIndex % words.length];
  const suffix = formatStatusSuffix(state.elapsedMs, outputTokens);

  /**
   * ── WHY THE LIVE REGION DOES NOT CONTAIN THE WORD, THE CLOCK OR THE TOKENS ──
   *
   * A polite live region announces on text mutation. The visible content mutates every 120ms (glyph),
   * every second (clock) and every few seconds (word), so wiring it up live would read "Combobulating 4
   * seconds, Combobulating 5 seconds, Perambulating 6 seconds…" for ever and make the chat unusable with
   * a screen reader. The words are also deliberate nonsense — they carry liveness VISUALLY and carry
   * nothing at all when spoken.
   *
   * So the two channels are split:
   *   - visible row: `aria-hidden`, purely decorative to assistive tech.
   *   - live region: a sr-only STABLE sentence, so it announces once on appear.
   *
   * The one thing a screen-reader user still needs is the answer to "is this stuck", which silence
   * cannot give. Hence the sentence changes at 30-second milestones and only then — the text node is
   * identical between milestones, so React never touches the DOM and the region stays silent. Coarse on
   * purpose: the information is "still going, and it has been a while", not the second count.
   */
  const milestone = Math.floor(state.elapsedMs / ANNOUNCE_EVERY_MS);
  const sinceLabel = `${milestone * (ANNOUNCE_EVERY_MS / 1000)} seconds`;
  const announcement = retrying
    ? milestone === 0
      ? "Retrying the API call."
      : `Still retrying the API call after ${sinceLabel}.`
    : milestone === 0
      ? `${assistant} is working on your request.`
      : `${assistant} is still working, ${sinceLabel} so far.`;

  /**
   * ── ⚠ THE "thinking" VARIANT: ONE WORD, THREE BREATHING DOTS ───────────────────────────────
   *
   * Rendered here rather than as a separate component so the LIVE REGION, the elapsed clock and the retry
   * wording are shared — three behaviours that took real work to get right (a stable sr-only sentence that
   * announces on 30-second milestones instead of on every tick, and a wall-clock elapsed time that survives
   * Electron throttling a backgrounded window).
   *
   * The dots are `animate-pulse` with staggered delays: "coming and going", and under
   * `motion-reduce` they simply hold, which still marks the turn as live.
   */
  if (style === "thinking") {
    return (
      <div className="flex items-center gap-2 motion-safe:animate-row-fade-in [contain:layout_paint]">
        <span className="sr-only" role="status" aria-live="polite">
          {announcement}
        </span>

        <span aria-hidden="true" className="text-xs text-surface-muted">
          {retrying ? "Retrying API call" : "Thinking"}
        </span>

        <span aria-hidden="true" className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={`h-1 w-1 rounded-full motion-safe:animate-pulse ${
                retrying ? "bg-tool-warning" : "bg-surface-muted"
              }`}
              // Staggered so they read as a wave rather than a flash. 200ms apart over a 1s pulse.
              style={{ animationDelay: `${i * 200}ms` }}
            />
          ))}
        </span>

        {suffix && (
          <span aria-hidden="true" className="text-xs text-surface-faint">
            {suffix}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      /**
       * `contain: layout paint` fences this off from the transcript around it. The glyph mutates a text
       * node eight times a second inside a long scrolling list; without containment the browser is free
       * to consider the whole message list when reflowing, eight times a second, for ever.
       */
      className="flex items-center gap-2 motion-safe:animate-row-fade-in [contain:layout_paint]"
    >
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>

      {/* Everything below is the decorative twin of the sentence above. */}
      {/*
        The glyph sits in a fixed box because the six frames are not the same width — `·` and `✽` differ
        enough to shift the word beside them on every frame if left to size themselves.
      */}
      <span
        aria-hidden="true"
        className={`inline-block w-4 flex-shrink-0 text-center text-sm leading-none ${
          retrying ? "text-tool-warning" : accentClass
        }`}
      >
        {SPINNER_FRAMES[frame]}
      </span>

      {/*
        FIXED WIDTH, and it is the whole reason this row does not jitter — the same problem the extension
        solves by space-padding the string to `max(length)+3`. The words run from "Doing" (5 chars) to
        "Flibbertigibbeting" (18), so a content-sized box would resize on every change and drag the clock
        sideways with it. 11rem clears the longest word at text-xs with room to spare, and because it is
        rem it scales with browser zoom and OS font size in step with the text it reserves for.
      */}
      <span aria-hidden="true" className="w-[11rem] flex-shrink-0 text-xs text-surface-muted">
        {retrying ? "Retrying API call…" : `${word}…`}
      </span>

      {/*
        `(15m 28s · ↓ 38.9k tokens)` — the extension's format, exactly.

        NOT a fixed-width box, unlike the word: this string legitimately grows as the token clause appears
        and as the count crosses magnitudes, and reserving room for its longest form would leave a wide
        gap for the first seconds of every turn. `tabular-nums` is what keeps it steady where it matters —
        the digits occupy identical widths, so ticking seconds and a rising count do not shuffle the text.
      */}
      <span
        aria-hidden="true"
        className="flex-shrink-0 whitespace-nowrap text-xs text-surface-muted tabular-nums"
      >
        {suffix}
      </span>
    </div>
  );
}
