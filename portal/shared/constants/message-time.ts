/**
 * ⚠ THE ONE PLACE THAT TURNS A STORED TIMESTAMP INTO WORDS — for BOTH front-ends.
 *
 * ── WHY THIS MOVED HERE, AND WHAT THE FOURTH COPY COST ──
 *
 * This rule ("Today 14:32" / "Yesterday 09:15" / "8 Aug 14:32", year only when it differs) had been
 * written FOUR times: the portal's `format-message-instant.ts`, the portal chat page's local
 * `formatDate`/`formatTime`, the desktop's `lib/instants.ts`, and the desktop `GitPanel`'s
 * `formatCommitInstant`. Each copy was defensible when written — the desktop one even says so:
 * *"deliberately not imported from it, since that module is Next-side and this is an Electron
 * renderer."*
 *
 * That reason was real and is now obsolete: this shared module is plain, dependency-free source
 * that BOTH front-ends already carry a copy of, so a pure function can live here and be imported
 * by a Next server component and an Electron renderer alike.
 *
 * The copies did not stay equal, which is the actual argument:
 *
 *   - `GitPanel.formatCommitInstant` had **no "Yesterday"** — a commit from yesterday read as
 *     "14 Aug 09:15" while a chat message from the same minute read "Yesterday 09:15".
 *   - `GitPanel` compared against `startOfToday` only, so it could never say "Yesterday" at all.
 *   - The portal's separator used `{weekday, month, day}` ("Fri, Aug 8") and the desktop's inline
 *     label used `{day, month}` ("8 Aug") — the same fact, two shapes, in two apps a facilitator
 *     and a participant compare across.
 *   - The hour-out zone bug (below) was fixed in two copies and left in the other two.
 *
 * Callers keep their own thin adapters (`portal/src/lib/format-message-instant.ts`,
 * `desktop/src/renderer/lib/instants.ts`) because each app has a different empty-value
 * convention and a different reason for being locale-aware. The RULE is here; the CONVENTION stays
 * with the caller.
 *
 * ── ⚠ SQLITE WRITES UTC WITH NO ZONE MARKER, AND V8 READS THAT AS LOCAL ──
 *
 * REPORTED, of the times being shown in the desktop app: they were an hour out.
 *
 * `chat_messages.created_at` defaults to `datetime('now')`, which SQLite renders as
 * `2026-08-14 20:13:58` — UTC, space-separated, no `Z`. That is not ISO 8601 (which requires the
 * `T`), so it falls to V8's implementation-defined parsing, which treats it as LOCAL. A message sent
 * at 21:13 BST is stored as 20:13 UTC and was then displayed as "20:13".
 *
 * ⚠ IT SELF-CORRECTS IN WINTER, which is why it survived review: at UTC+0 the wrong reading and the
 * right one agree, so the bug is invisible for five months of the year and off by one hour for seven.
 *
 * ⚠ ONLY ZONE-LESS STRINGS ARE TOUCHED. Anything carrying `Z` or `±HH:MM` came from a SERVER — the
 * team and ai services stamp `new Date().toISOString()` — and is already unambiguous. Appending `Z`
 * to those would introduce the very error this removes, so the pattern is anchored end-to-end and
 * matches nothing else.
 */
const ZONELESS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

/** Parse a stored timestamp, reading a zone-less value as UTC rather than as local. */
export function parseStoredInstant(raw: string): Date {
  return new Date(ZONELESS.test(raw) ? `${raw.replace(" ", "T")}Z` : raw);
}

/** Shared guard: parse, and return null for anything that cannot render as a real instant. */
function usableInstant(raw?: string | null): Date | null {
  if (!raw) return null;
  const at = parseStoredInstant(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Clock only — for rows whose DAY is already established by a separator above them. */
export function formatClock(raw?: string | null): string | null {
  const at = usableInstant(raw);
  if (!at) return null;
  return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The DAY, relative where that reads better: `Today` / `Yesterday` / `8 Aug` / `8 Jan 2025`.
 *
 * `now` is a parameter, not an ambient `Date.now()`, so "Today" is testable and a long-open tab
 * cannot be reasoned about incorrectly.
 *
 * `weekday: true` adds the weekday for a DAY SEPARATOR ("Fri 8 Aug"), where there is room for it and
 * where "which Friday was that?" is the question a reader actually has. Inline per-message labels
 * leave it off: they sit in dense bubbles and a narrow sidebar, and length is a real constraint
 * there.
 */
export function messageDayLabel(
  raw?: string | null,
  now: Date = new Date(),
  opts: { weekday?: boolean } = {}
): string | null {
  const at = usableInstant(raw);
  if (!at) return null;

  /**
   * ⚠ COMPARED BY CALENDAR DAY, NOT BY ELAPSED HOURS. A message sent at 23:50 is "Yesterday" at
   * 00:10, and a 24-hour subtraction would call it "Today".
   */
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfThatDay = new Date(at);
  startOfThatDay.setHours(0, 0, 0, 0);
  const daysAgo = Math.round(
    (startOfToday.getTime() - startOfThatDay.getTime()) / 86_400_000
  );

  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";

  /**
   * The YEAR appears only when it differs from the reader's current year — noise on the 51 weeks it
   * agrees, but "12 Jan" for a message from a PREVIOUS January reads as three weeks ago rather than
   * fifteen months, which is the ambiguity that matters. Included for a FUTURE year too, so a
   * clock-skewed row is still legible rather than quietly mislabelled.
   */
  const sameYear = at.getFullYear() === now.getFullYear();
  return at.toLocaleDateString([], {
    ...(opts.weekday ? { weekday: "short" } : {}),
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * A message's full instant — the day and the clock, both facts rather than one replacing the other.
 *
 * For surfaces where each row carries its own timestamp (AI transcripts, thread and session lists,
 * commit rows). A flat list with no day separator MUST use this: a bare clock makes a message from
 * last Friday indistinguishable from one sent minutes ago, which is the defect this exists to
 * prevent.
 */
export function formatMessageInstant(
  raw?: string | null,
  now: Date = new Date()
): string | null {
  const day = messageDayLabel(raw, now);
  const time = formatClock(raw);
  if (!day || !time) return null;
  return `${day} ${time}`;
}
