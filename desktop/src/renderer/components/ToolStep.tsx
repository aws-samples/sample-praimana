import { useState } from "react";
import type { TranscriptBlock } from "../lib/transcript";

/**
 * ── ONE TOOL CALL, drawn the way the VS Code extension draws it ──
 *
 * Not inferred from a screenshot. Ported from the extension's own stylesheet and component, at
 * `~/.vscode/extensions/anthropic.claude-code-2.1.226-darwin-arm64/webview/`. The rules this file
 * implements, verbatim from `index.css`:
 *
 *   .toolNameText      { margin-right:4px; font-weight:700 }
 *   .toolNameTextSecondaryPlaintext { color:--app-secondary-foreground; word-break:break-all }
 *   .toolBody          { border:.5px solid --app-input-border; border-radius:5px; margin:8px 0 }
 *   .toolBodyGrid      { display:grid; grid-template-columns:max-content 1fr }
 *   .toolBodyRow       { grid-column:1/-1; grid-template-columns:subgrid;
 *                        border-top:.5px solid --app-input-border; padding:4px }
 *   .toolBodyRow:first-child { border-top:none }
 *   .toolBodyRowLabel  { grid-column:1; opacity:.5; font-family:mono; font-size:.85em;
 *                        padding:4px 8px 4px 4px }
 *   .toolBodyRowContent{ grid-column:2; white-space:pre-wrap; word-break:break-word; padding:4px }
 *   .toolBodyRowContent:not(.disableClipping) {
 *       mask-image:linear-gradient(to bottom, <bg> 50px, transparent 60px);
 *       overflow:hidden; max-height:60px }
 *
 * Three details that matter and that the screenshot could not show:
 *
 *   1. THE GRID IS A REAL GRID with `subgrid` rows, so the IN/OUT labels and the content share ONE column
 *      track across every row. Two independently-sized flex rows would drift out of alignment the moment
 *      one label was wider than the other.
 *   2. THE CLIP IS A MASK, NOT A CROP. `mask-image` fades the last 10px of a 60px box to transparent, so
 *      long output visibly trails off instead of being guillotined mid-glyph.
 *   3. `.5px` BORDERS, not 1px. On a 2x display that is a true hairline; Tailwind has no `border-[.5px]`
 *      preset, hence the arbitrary value below rather than `border`.
 *
 * WHY THE PANEL IS CLIPPED RATHER THAN SCROLLABLE. The extension clips, and it is also right here for a
 * reason of our own: this sits inside the transcript's own scroll container, and a nested scroller is a
 * trap for a mouse wheel — you scroll the chat, hit an OUT panel, and the page stops moving.
 *
 * The symptom this whole layout answers: the turn looked stuck or idle. The turn was
 * working the entire time; the UI simply never said what it was doing.
 */

/** The extension's 60px `max-height` with its 50px→60px mask. */
const CLIP_CLASS =
  "max-h-[60px] overflow-hidden " +
  "[mask-image:linear-gradient(to_bottom,#000_50px,transparent_60px)]";

export function ToolStep({
  block,
}: {
  block: Extract<TranscriptBlock, { kind: "tool" }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const running = block.output === null;

  return (
    <TimelineRow
      state={running ? "progress" : block.isError ? "failure" : "success"}
      srLabel={running ? "running" : block.isError ? "failed" : "completed"}
    >
      {/*
        Header: bold tool name then the assistant's own one-line reason. `font-bold` + `mr-1` is the
        extension's `.toolNameText`; the description is its `.toolNameTextSecondaryPlaintext`, which is
        secondary-foreground and `break-all` — a description can contain a path.
      */}
      <div className="text-sm leading-snug">
        <span className="mr-1 font-bold text-surface-text">{block.tool}</span>
        {block.description && (
          <span className="break-all text-surface-muted">{block.description}</span>
        )}
      </div>

      {/*
        `.toolBody` — a `.5px` hairline, 5px radius, 8px vertical margin. `grid-cols-[max-content_1fr]` is
        `.toolBodyGrid`: the label column sizes to the widest label and the content takes the rest.
      */}
      <div className="my-2 grid grid-cols-[max-content_1fr] overflow-hidden rounded-[5px] border-[.5px] border-surface-line bg-surface-panel">
        <Row label="IN">
          <span className="whitespace-pre-wrap break-words">{block.input}</span>
        </Row>

        {running ? (
          <Row label="OUT">
            <span className="italic text-surface-muted">running…</span>
          </Row>
        ) : (
          <Row
            label="OUT"
            /**
             * The clip lives on the CONTENT cell, not the row, so the `OUT` label stays pinned at the top
             * of a tall output instead of being centred against forty lines of it.
             */
            contentClassName={expanded ? "" : CLIP_CLASS}
            className={block.isError ? "text-tool-error-text" : undefined}
          >
            {block.output ? (
              <span className="whitespace-pre-wrap break-words">{block.output}</span>
            ) : (
              /*
               * An empty string is a REAL and common result — a successful `mv`, a grep that matched
               * nothing — and rendering it as blank space would read as a failed row. Bracketed and
               * italic so it cannot be mistaken for the command's own output.
               */
              <span className="italic text-surface-muted">(no output)</span>
            )}
          </Row>
        )}
      </div>

      {/*
        The toggle is only offered when something is actually hidden: an output shorter than the clip has
        nothing to expand to, and a control that visibly does nothing when clicked is worse than no
        control. The 240-char threshold approximates the 60px box's capacity — it does not need to be
        exact, only to never claim there is more when there is not.
      */}
      {!running && ((block.output?.length ?? 0) > 240 || block.truncated) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="rounded text-[11px] text-surface-muted underline decoration-dotted underline-offset-2 hover:text-surface-text focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-accent"
        >
          {expanded ? "Show less" : "Show more"}
          {/*
            ⚠ THE CEILING IS DISCLOSED. The main process clips tool output at 2,000 characters before it
            crosses the IPC boundary, so "Show more" cannot show the rest — and a reader who expanded a
            truncated output and drew conclusions from its last line would be reading a cut-off file as a
            complete one. The row says so rather than implying completeness.
          */}
          {block.truncated && " (output truncated)"}
        </button>
      )}
    </TimelineRow>
  );
}

/**
 * ── THE TIMELINE SPINE ──
 *
 * The extension's `.timelineMessage`, which is the structure the whole transcript hangs off and the part
 * a screenshot reads as "a bullet list". It is not a list: it is `padding-left:30px` with two absolutely
 * positioned pseudo-elements —
 *
 *   :before { width:7px; height:7px; border-radius:50%; top:15px; left:9px }   ← the dot
 *   :after  { width:1px; top:0; bottom:0; left:12px }                          ← the connecting line
 *
 * — so consecutive rows are joined by a continuous 1px rule running through their dots. Reproduced here
 * with real elements rather than pseudo-elements because Tailwind cannot express `:has(+ .sibling)`,
 * which the extension uses to shorten the line on the LAST row. Instead the caller passes `isLast`, and a
 * row with no successor draws a stub.
 *
 * `top:15px` is not arbitrary: it centres the dot on the first line of 13px text. Kept as-is.
 */
export function TimelineRow({
  state,
  srLabel,
  isLast = false,
  children,
}: {
  state: "success" | "failure" | "warning" | "progress";
  /** Spoken status. The dot is `aria-hidden`, so this is the only channel that carries it. */
  srLabel?: string;
  isLast?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="relative pl-[30px]">
      {/*
        The connecting line. `left-[12px]` and the dot's `left-[9px]` + 7px width put the dot's centre at
        12.5px — half a pixel off the line, exactly as in the extension. Reproducing the offset rather
        than "fixing" it keeps the two products looking identical.

        On the last row it stops at the dot instead of running to the bottom edge, so the spine ends at
        the final step rather than trailing into empty space.
      */}
      <span
        aria-hidden="true"
        className={`absolute left-[12px] top-0 w-px bg-surface-line ${isLast ? "h-[18px]" : "bottom-0"}`}
      />
      {/*
        The dot. A PROGRESS dot keeps the default colour and BLINKS rather than taking a hue of its own —
        that is the extension's rule (`.dotProgress:before { animation:1s linear infinite blink }` with no
        background-color), and it is why there is no third colour token for it.
      */}
      <span
        aria-hidden="true"
        className={`absolute left-[9px] top-[15px] z-[1] h-[7px] w-[7px] rounded-full ${
          state === "success"
            ? "bg-tool-ok"
            : state === "failure"
              ? "bg-tool-error"
              : state === "warning"
                ? "bg-tool-warning"
                : "bg-surface-muted motion-safe:animate-dot-blink"
        }`}
      />
      {srLabel && <span className="sr-only">{srLabel}</span>}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * One `IN`/`OUT` line. `col-span-2` + `grid-cols-subgrid` is the extension's `.toolBodyRow`: the row
 * spans the panel and inherits the PARENT's column tracks, which is what keeps every label and every
 * content cell on the same two columns down the whole panel.
 */
function Row({
  label,
  children,
  className,
  contentClassName,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <div className="col-span-2 grid grid-cols-subgrid border-t-[.5px] border-surface-line p-1 first:border-t-0">
      {/*
        `opacity-50` on top of `surface-faint`, as the extension does — the label is the least important
        thing in the row and is meant to recede. ⚠ THAT IS WHY IT IS `aria-hidden`: 4.74:1 × 0.5 opacity
        does not meet the text contrast floor, so it cannot be the only carrier of anything. It is not —
        it labels content that is right beside it and reachable without it.
      */}
      <span
        aria-hidden="true"
        className="col-start-1 select-none px-2 py-1 pl-1 font-mono text-[.85em] uppercase text-surface-faint opacity-50"
      >
        {label}
      </span>
      <div
        className={`col-start-2 min-w-0 p-1 font-mono text-[.85em] leading-relaxed ${
          className ?? "text-surface-text"
        } ${contentClassName ?? ""}`}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The stand-in for tool calls the per-turn cap dropped.
 *
 * Its existence is the point: the cap is a memory bound, and a transcript that silently stopped listing
 * tool calls would be indistinguishable from an assistant that stopped making them. This says which of
 * the two happened.
 */
export function ToolStepOverflow({ hidden }: { hidden: number }) {
  return (
    <TimelineRow state="warning">
      <p className="py-1 text-xs italic text-surface-muted">
        {hidden} further tool call{hidden === 1 ? "" : "s"} in this turn — not shown, to keep this
        conversation bounded.
      </p>
    </TimelineRow>
  );
}
