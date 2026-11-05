import { formatInstantUtc } from "@/lib/format-datetime";

/**
 * "Sent 01 Aug 2026 20:47 UTC" for an invitation row, the ONE rendering of when an
 * invitation went out.
 *
 * A component rather than a call to formatInstantUtc at each site because two screens
 * list invitations (Administration → Invitations, and the team workspace) and the owner
 * reported the defect on one of them. Two independent formats for the same field is how
 * the fix lands on one screen and not the other; an administrator who learns to read
 * this line on one list should read the identical line on the other.
 *
 * Renders NOTHING, not a dash, not "unknown", when there is no usable instant.
 * `sentAt` is `""` on rows the tRPC mapper defaulted and absent on rows written before
 * the field existed, and the neighbouring role and status text is still complete without
 * it. A placeholder here would draw the eye to a gap that carries no meaning.
 *
 * The RAW ISO value stays recoverable two ways: `dateTime` for machines and assistive
 * technology, `title` for a pointer. Neither is required to act on the row, the
 * rendered text already carries the date, the time and the zone, so this satisfies
 * "never rely on hover for information needed to act" while still keeping full
 * precision (seconds, milliseconds, original offset) one hover away.
 */
export function SentAt({
  sentAt,
  /** Leading text, so a caller can say "sent" mid-sentence or "Sent" after a separator. */
  label = "Sent",
}: {
  sentAt?: string | null;
  label?: string;
}) {
  const formatted = formatInstantUtc(sentAt);
  if (!formatted) return null;

  return (
    <>
      {` · ${label} `}
      {/* `title` duplicates `dateTime` deliberately: <time> is not a tooltip, and
          browsers show nothing on hover without an explicit title. */}
      <time dateTime={sentAt ?? undefined} title={sentAt ?? undefined}>
        {formatted}
      </time>
    </>
  );
}
