import {
  decodeLinks,
  isSafeHttpUrl,
  linkFieldsFor,
} from "@praimana/shared";
import { isReleasableDemoUrl } from "@/lib/release-readiness";

/**
 * ── SEEDING THE SUBMISSION'S TWO LINK FIELDS FROM THE DEMO PHASE ─────────────────────────────
 *
 * A team types its demo and video URLs once, in the Demo phase (`shared/constants/phase-links.ts`
 * stores `app` and `video` as two labelled URLs inside that phase's single `content` string). The
 * submit form then asks for the same two URLs again. `demoUrl` is the ONE required field on that
 * form and the only link release checks, so it is the most expensive thing on the page to make
 * somebody re-enter, and the most consequential to get wrong.
 *
 * ── ⚠ THE TWO VALIDATORS DISAGREE, AND THAT ASYMMETRY IS THE ENTIRE POINT OF THIS MODULE ──
 *
 * `isSafeHttpUrl`, the phase-link control, accepts `http:` OR `https:`.
 * `isReleasableDemoUrl`, release precondition P4, accepts `https:` ONLY, deliberately, so a
 * judging panel is never downgraded to plaintext on the team's behalf.
 *
 * So `http://our-app.example.com` is a perfectly valid PHASE link that CANNOT satisfy release.
 * Seeding it would be worse than leaving the field blank: the team sees its required field
 * populated, reads that as done, and the checklist says "a demo link starting with https:// is
 * needed" without saying which value it means. A blank field at least still reads as "not done".
 *
 * Hence: each field is gated on the predicate of the GATE IT FEEDS, not on the one that produced
 * the value. The stricter of the two wins, and no field is ever seeded with a value that cannot
 * pass. `videoUrl` has no release rule, so any parseable http(s) URL is fine there.
 *
 * ── WHY THIS IS A MODULE AND NOT A BRANCH IN THE COMPONENT ──
 *
 * It was the latter first. The asymmetry above is a RULE, it is the one thing here that can be
 * silently wrong, and vitest runs `environment: "node"` with no DOM, so inside the component it
 * was unreachable by any test. A pure function is the only shape this can be checked in, which is
 * the same argument `phase-links.ts` makes about its own encoding.
 */

/** The submission fields this module can seed. Deliberately not the whole form. */
export type SeedableField = "demoUrl" | "videoUrl";

/**
 * Which phase-link key feeds which submission field, and what makes a value good enough for it.
 *
 * ⚠ `accepts` IS PER FIELD, NOT SHARED. Pointing both at `isSafeHttpUrl` would let an `http://`
 * value reach `demoUrl`; pointing both at `isReleasableDemoUrl` would silently drop a usable
 * `http://` video link for a rule that does not apply to it.
 */
const SEEDS: ReadonlyArray<{
  phaseKey: string;
  field: SeedableField;
  accepts: (value: string) => boolean;
}> = [
  { phaseKey: "app", field: "demoUrl", accepts: isReleasableDemoUrl },
  { phaseKey: "video", field: "videoUrl", accepts: isSafeHttpUrl },
];

/** The shape this needs from a phase, narrower than the API's, as `phase-links.ts` does. */
export interface SeedablePhase {
  name: string;
  content?: string | null;
}

/**
 * The values worth seeding, keyed by submission field. Absent key ⇒ nothing usable was found.
 *
 * ⚠ THE PHASE IS FOUND VIA `linkFieldsFor`, NEVER BY MATCHING THE NAME "demo" HERE. That predicate
 * lives in `shared/` and is what the desktop uses too; a second copy of the lookup is how the two
 * front-ends come to disagree about which phase carries links. A workshop whose format renames the
 * phase simply yields nothing, the fields stay empty, which is the pre-existing behaviour and not
 * a regression.
 *
 * Tolerates the messy real input `decodeLinks` already handles: a legacy bare URL with no prefix,
 * CRLF from a pasted value, and prose in a field that used to be free text.
 */
export function submissionPhaseSeed(
  phases: ReadonlyArray<SeedablePhase> | null | undefined
): Partial<Record<SeedableField, string>> {
  const out: Partial<Record<SeedableField, string>> = {};

  for (const phase of phases ?? []) {
    const fields = linkFieldsFor(phase);
    if (!fields) continue;

    const values = decodeLinks(fields, phase.content);
    for (const seed of SEEDS) {
      const value = values[seed.phaseKey]?.trim();
      if (value && seed.accepts(value)) out[seed.field] = value;
    }
  }

  return out;
}

/**
 * The subset of `seed` that should actually be written into `draft`, the empty fields only.
 *
 * ⚠ A CONVENIENCE MUST NEVER OVERWRITE TYPING. A non-blank existing value means the team, or a
 * previous save, put it there; the submission is the pinned snapshot judges read, so
 * a phase note is a starting value and never an authority over it.
 *
 * Whitespace counts as empty: a field holding `"  "` is not something anybody meant to keep.
 */
export function seedForEmptyFields(
  seed: Partial<Record<SeedableField, string>>,
  draft: Record<string, string>
): Partial<Record<SeedableField, string>> {
  const out: Partial<Record<SeedableField, string>> = {};
  for (const [field, value] of Object.entries(seed) as [SeedableField, string][]) {
    if (!(draft[field] ?? "").trim()) out[field] = value;
  }
  return out;
}
