/**
 * A CHAT MESSAGE'S INSTANT, with the date, which is the reported fix.
 *
 * ⚠ THE RULE MOVED TO `@praimana/shared` (`constants/message-time.ts`); this is now the
 * PORTAL'S ADAPTER over it. Read that header for the four-copy divergence this consolidation ended.
 * What stays here is the portal's own two conventions, both of which are genuinely local decisions:
 * the `""` return (below) and the locale-awareness argument (further below).
 *
 * ── THE BUG ──
 *
 * The AI chat page rendered every message and every thread with a bare clock time: "09:42". An AI
 * transcript is read long after it happened, an executive reviewing a team, a judge reading a
 * submission, a member scrolling back a week, and with no date, a conversation from last Tuesday
 * is indistinguishable from one this morning. Worse, a thread spanning three days looked like a
 * single sitting, which misrepresents the PACE of the work on a page whose numbers feed an
 * assessment of people.
 *
 * ── WHY THIS IS LOCALE-AWARE, WHEN format-datetime.ts DELIBERATELY IS NOT ──
 *
 * `formatInstantUtc` hand-rolls a fixed UTC format precisely to avoid hydration mismatches, and
 * that is right for the surfaces it serves: rows an administrator reads, where the value is
 * rendered during a server prerender.
 *
 * These two chat pages are different, and the difference is verifiable rather than a matter of
 * taste: every timestamp here sits inside a subtree that only renders after a client-side query
 * resolves (`threadsQuery.isLoading` returns a spinner first, and the message list is inside the
 * active thread's data). Nothing here is ever produced by the server render, so there is no pair
 * of values to disagree. That buys the reader their OWN timezone, which for a conversation they
 * took part in is the only reading that makes sense, "yesterday 18:40" has to mean their
 * yesterday, not UTC's.
 *
 * If either of these values is ever moved above its loading guard, it must switch to
 * formatInstantUtc or acquire the `nowMs`-after-mount treatment the insights page uses.
 *
 * ── THE RELATIVE LABELS ARE A FUNCTION OF `now`, PASSED IN ──
 *
 * `now` is an argument, not an ambient `Date.now()`, so "Today" is testable and so that a long-open
 * tab cannot be reasoned about incorrectly. Callers pass the real clock.
 */
import {
  formatClock,
  formatMessageInstant as formatSharedMessageInstant,
  messageDayLabel,
} from "@praimana/shared";

/**
 * ⚠ RETURNS `""`, NOT `null`, AND THAT IS THE PORTAL'S CONVENTION RATHER THAN THE RULE'S.
 *
 * The shared function returns `null` for an unusable value because the desktop's call sites guard on
 * it (`{formatMessageInstant(x) && <span>…</span>}`). The portal's interpolate directly, and its
 * tests assert `""`, same rendered result (React renders neither), different contract. Adapting
 * here keeps both honest instead of rewriting ~20 call sites to suit the other app.
 *
 * Same reasoning as formatInstantUtc's `""`: a data gap should look like nothing, not like a bug in
 * the conversation.
 */
export function formatMessageInstant(iso: string, now: Date = new Date()): string {
  return formatSharedMessageInstant(iso, now) ?? "";
}

/**
 * A DAY SEPARATOR's label, `Today` / `Yesterday` / `Fri 8 Aug`.
 *
 * Used by the team chat page, which groups messages by calendar day and stamps each one with the
 * clock alone. The weekday is included because a separator has room for it and "which Friday was
 * that?" is the question a reader scrolling back actually has.
 */
export function formatMessageDay(iso: string, now: Date = new Date()): string {
  return messageDayLabel(iso, now, { weekday: true }) ?? "";
}

/** The clock alone, for a row sitting under a day separator that already established the day. */
export function formatMessageClock(iso: string): string {
  return formatClock(iso) ?? "";
}
