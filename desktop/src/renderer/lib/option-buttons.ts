// Detect an "option list" at the tail of an assistant message so the renderer
// can offer quick-reply buttons (e.g. Approve / Edit the grid / Reject).
//
// The assistant's output is free-form, so this is a deliberately conservative
// heuristic: it looks for a run of >= 2 consecutive lines shaped like
//   "<Short Label> — <description>"
// where the label is capitalized, short (<= 5 words), and the separator is an
// em/en dash or a spaced hyphen. Prose lines (no dash, long left side, or a
// lowercase start) don't match, so a trailing sentence like
// "I'll wait for your choice…" is correctly ignored.

export interface ChatOption {
  /** The keyword sent back to the assistant when clicked, e.g. "Approve". */
  label: string;
  /** The explanatory text after the dash (for tooltip/aria). */
  description: string;
}

// Separators we accept between label and description: em dash, en dash, or a
// hyphen padded by spaces. A bare hyphen without spaces is NOT accepted (it
// shows up inside ordinary words/paths).
const SEPARATOR = /\s+(?:—|–|-)\s+/;

// Leading list/number markers to strip before reading the label.
const LEADING_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;

const MAX_LABEL_WORDS = 5;
const MAX_LABEL_CHARS = 40;

function parseOptionLine(rawLine: string): ChatOption | null {
  const line = rawLine.replace(LEADING_MARKER, "").trim();
  if (!line) return null;

  const match = SEPARATOR.exec(line);
  if (!match || match.index === undefined) return null;

  const description = line.slice(match.index + match[0].length).trim();
  // Strip surrounding markdown emphasis before validating (**Approve** → Approve).
  const label = line.slice(0, match.index).trim().replace(/^[*_`]+|[*_`]+$/g, "").trim();
  if (!label || !description) return null;

  // Label must read like a choice keyword: starts uppercase, short.
  if (!/^[A-Z]/.test(label)) return null;
  if (label.length > MAX_LABEL_CHARS) return null;
  if (label.split(/\s+/).length > MAX_LABEL_WORDS) return null;

  return { label, description };
}

/**
 * Return the option list found in `content`, or an empty array if none.
 * Picks the longest run of consecutive matching lines (>= 2 required).
 */
export function parseChatOptions(content: string): ChatOption[] {
  if (!content) return [];

  const lines = content.split("\n");
  let best: ChatOption[] = [];
  let run: ChatOption[] = [];

  const flush = () => {
    if (run.length > best.length) best = run;
    run = [];
  };

  for (const line of lines) {
    if (line.trim() === "") {
      // Blank lines don't break a run — options are often single-spaced or not.
      continue;
    }
    const opt = parseOptionLine(line);
    if (opt) {
      run.push(opt);
    } else {
      flush();
    }
  }
  flush();

  if (best.length < 2) return [];

  // De-duplicate by label, preserving order.
  const seen = new Set<string>();
  return best.filter((o) => {
    const key = o.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
