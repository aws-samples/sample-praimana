/**
 * ── PHASES WHOSE DELIVERABLE IS ONE OR MORE LINKS ──
 *
 * ── WHY THE MOVE IS RIGHT ──
 *
 * Build asked for the deployed application URL, which is a question it cannot answer: Build is where the work
 * happens, and for most of a workshop nothing is deployed yet. "No live application URL yet" was the honest
 * but useless result. Build's real artefacts are the DOCUMENTS a team produces, which is what `TeamDocs`
 * already renders in that phase. Demo is when a team presents a running thing, so that is where the question
 * belongs — and it is where a facilitator will want to click it.
 *
 * ── ⚠ WHY IT LIVES IN SHARED AND NOT IN THE DESKTOP ──
 *
 * It started in the desktop renderer, because the desktop was the only thing that wrote
 * these fields. Moved to shared when the PORTAL turned out to be rendering the raw stored string:
 *
 *     app: https://test.com video: https://test-watch.com
 *
 * — two labels and two URLs collapsed onto one line as prose, none of it clickable. A participant fills
 * these in on the desktop and a FACILITATOR or JUDGE opens them in the portal, so the two ends must
 * agree about the storage format and about which label belongs to which key. A second copy in the
 * portal is how they stop agreeing; the header of `constants/message-time.ts` records what four
 * divergent copies of a formatting rule cost the last time.
 *
 * ⚠ `placeholder` and `hint` ARE DESKTOP-ONLY and stay on the type anyway. They describe the EDIT
 * form, which only the desktop has — but splitting the type in two so the portal could avoid two
 * unused strings would mean two things to keep in step for no benefit. The portal reads `label`.
 *
 * ── ⚠ WHY THIS IS A MODULE AND NOT A LOOKUP TABLE ──
 *
 * A phase stores ONE `content` string, and Demo already asked for a video link. The design keeps both
 * rather than drop either, so two labelled URLs share one field. Encoding them, and reading them back out of
 * whatever a participant typed there BEFORE this change, has real edge cases: a legacy bare URL with no
 * prefix, CRLF from a pasted value, prose in a field that was free text until now.
 *
 * The desktop package's vitest is node-only with no jsdom, so a pure module was the only part of this
 * that could be tested at all — and the encoding is the part that can actually be wrong.
 */

export interface PhaseLinkField {
  /** Stable key, used as the storage prefix. Never shown to the participant. */
  key: string;
  label: string;
  placeholder: string;
  hint: string;
}

/**
 * Link fields per phase, keyed by lower-cased phase NAME.
 *
 * Name-keyed rather than id-keyed because ids are per-workshop ULIDs while the names are fixed by the workshop
 * format (`shared/constants/phases.ts`). Exact match, not substring: a "Demo Prep" phase must
 * keep its textarea.
 *
 * ⚠ BUILD IS DELIBERATELY ABSENT. It now falls through to the free-form textarea like every other phase, and
 * keeps its documents panel. Re-adding it here is what this change undoes.
 */
export const PHASE_LINK_FIELDS: Record<string, PhaseLinkField[]> = {
  demo: [
    {
      key: "app",
      label: "Live application URL",
      placeholder: "https://your-app.example.com",
      hint: "Where can a facilitator open your working application?",
    },
    {
      key: "video",
      label: "Demo video link",
      placeholder: "https://your-recording.example.com/watch/…",
      hint: "A link to your demo recording — anyone reviewing should be able to open it.",
    },
  ],
};

/** The link fields for a phase, or null when it takes free-form notes. */
export function linkFieldsFor(phase: { name: string }): PhaseLinkField[] | null {
  return PHASE_LINK_FIELDS[phase.name.trim().toLowerCase()] ?? null;
}

/**
 * ── THE STORAGE FORMAT ──
 *
 *     app: https://myapp.example.com
 *     video: https://recording.example.com/watch/1
 *
 * One `key: value` per line. Chosen over JSON for one reason that decides it: this field was free text before
 * and every OTHER consumer of a phase's content renders it as prose — the portal, the insights prompt. A JSON
 * blob would read as a JSON blob there; labelled lines read as what they are.
 *
 * A blank value writes NO line rather than an empty one, so a Demo phase with only the app URL filled in
 * stores exactly one line and still looks deliberate to anything reading it as text.
 */
export function encodeLinks(fields: PhaseLinkField[], values: Record<string, string>): string {
  return fields
    .map((f) => [f, (values[f.key] ?? "").trim()] as const)
    .filter(([, v]) => v.length > 0)
    .map(([f, v]) => `${f.key}: ${v}`)
    .join("\n");
}

/**
 * Read the stored values back.
 *
 * ⚠ THE LEGACY CASE IS THE WHOLE REASON THIS IS NOT A ONE-LINE SPLIT. Before this change, Build and Demo each
 * stored a BARE URL with no prefix, and those rows exist in the live database right now. So content with no
 * recognisable prefix at all is treated as the FIRST field's value — which for Demo means an old bare link
 * becomes the app URL rather than vanishing from the form the moment this ships.
 *
 * Unrecognised prefixes are ignored rather than guessed at: a participant who typed prose into this field gets
 * empty inputs, not a URL field pre-filled with half a sentence.
 */
export function decodeLinks(
  fields: PhaseLinkField[],
  content: string | null | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) out[f.key] = "";

  const raw = (content ?? "").trim();
  if (!raw) return out;

  const keys = new Set(fields.map((f) => f.key));
  // `\r?\n` — a value pasted from Windows carries CRs that would otherwise end up inside the URL and break
  // the anchor's href.
  const lines = raw.split(/\r?\n/);
  let matchedAny = false;

  for (const line of lines) {
    const match = line.match(/^\s*([a-z]+)\s*:\s*(.*)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (!keys.has(key)) continue;
    out[key] = match[2].trim();
    matchedAny = true;
  }

  /**
   * NO PREFIX ANYWHERE — a pre-change bare URL. It belongs to the first field.
   *
   * ⚠ Guarded on `matchedAny` rather than on "does line 0 look like a URL", because a partially-prefixed value
   * (someone hand-edited one line) must not have its other line swallowed as legacy content.
   */
  if (!matchedAny && fields.length > 0) {
    out[fields[0].key] = lines[0].trim();
  }

  return out;
}

/** True when at least one field has a value — i.e. there is something to render as a link. */
export function hasAnyLink(values: Record<string, string>): boolean {
  return Object.values(values).some((v) => v.trim().length > 0);
}

/**
 * Is this safe to render as an anchor?
 *
 * ⚠ A SECURITY CHECK, NOT A VALIDATION NICETY — and it fixes a real hole this change surfaced. The previous
 * code rendered `href={phase.content.trim()}` directly, so a participant who stored a `javascript:` URL had it
 * execute in the renderer's context on click. `data:` is the same class of problem.
 *
 * An allow-list of http/https is the only safe shape here; anything else is shown as plain text instead, which
 * still tells the reader what was stored without making it clickable.
 */
export function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
