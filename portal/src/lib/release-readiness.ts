import { submissionWriteUpBlockers } from "@/lib/submission-bounds";

/**
 * ── IS THIS DRAFT READY TO RELEASE, AND IF NOT, WHICH PART ISN'T ─────────────────────────
 *
 * ── ⚠ THIS IS A SECOND COPY OF A SERVER RULE, AND IT IS DELIBERATE ──
 *
 * `the evaluation service's `routes.ts`` holds the authoritative version:
 * `isReleasableDemoUrl` plus the P1–P6 ladder, checked against the STORE at the moment of release.
 * That one decides. This one exists for a different job: telling a human WHICH precondition is
 * failing BEFORE they press a button, and disabling a control with a reason attached.
 *
 * The alternative was to disable the button with no explanation and let the server's 403 carry the
 * message, which reads as a broken button, and reaches the executive rather than the team who can
 * actually fix it.
 *
 * ⚠ SO THE DRIFT RISK IS REAL AND IS HANDLED THE ONLY WAY IT CAN BE: the rule is stated once here,
 * in a module with tests that mirror the service's own release preconditions, rather
 * than inlined in a component where nobody would notice it diverging. If the server's protocol rule
 * changes, `release-readiness.test.ts` is the thing that should fail.
 *
 * ⚠ AND IT IS NOT SHARED VIA `@praimana/shared`, unlike the scoring rule. The scoring
 * predicate had to be shared because the form and the route must REFUSE THE SAME INPUTS, a
 * disagreement there is a rejected submission. Here the client only ever answers "not yet", and the
 * server's answer is the one that acts, so a shared module would be more coupling than the problem
 * needs.
 */

/**
 * Precondition P4: a demo link good enough to hand to a judging panel.
 *
 * ⚠ PARSED, NOT PATTERN-MATCHED, matching the service exactly. `startsWith("https://")` gets
 * `HTTPS://` wrong, and `URL` settles the cases that matter in one step:
 *
 *   - `http://…` is refused, this link goes to a panel of judges, and the platform should not
 *     downgrade them to plaintext on the team's behalf.
 *   - `javascript:…` is refused. The protocol allowlist is the first line; an escape in a UI is
 *     the second, never the first.
 *   - `"coming soon"` is refused, because it is not a URL at all.
 */
export function isReleasableDemoUrl(demoUrl: string | null | undefined): boolean {
  if (!demoUrl) return false;
  try {
    return new URL(demoUrl).protocol === "https:";
  } catch {
    return false;
  }
}

export interface ReleaseReadiness {
  /** What the team still has to do, in the order the checklist shows it. Empty means ready. */
  blockers: string[];
  artifactsOk: boolean;
  demoOk: boolean;
  savedOk: boolean;
  /** Are the four narrative fields present and within bounds? See `submission-bounds.ts`. */
  writeUpOk: boolean;
}

/**
 * Everything standing between this draft and release.
 *
 * ⚠ `hasUnsavedEdits` IS A BLOCKER, AND IT IS THE ONE A SERVER CHECK CANNOT PRODUCE. Release reads
 * the STORE. An executive releasing while a teammate has an unsaved demo link on screen would
 * release the submission WITHOUT it and be told `NO_DEMO_URL`, a correct refusal that is completely
 * baffling to both of them, because the link is right there on the screen.
 *
 * ⚠ THE COPY SAYS "FILES", NEVER "BUILD-PHASE FILES". Documents carry no phase
 * attribution, so a build-phase check is not expressible today; claiming one would be a promise the
 * server does not keep.
 */
export function releaseReadiness(input: {
  artifactCount: number;
  demoUrl: string | null | undefined;
  hasUnsavedEdits: boolean;
  /**
   * The four narrative fields. OPTIONAL so a caller that does not have them yet degrades to the
   * previous three checks rather than reporting a write-up that is missing because nobody passed it -
   * the difference between "the team has not written this" and "we did not look", which this file
   * already draws for `artifactCount`.
   */
  writeUp?: Parameters<typeof submissionWriteUpBlockers>[0];
}): ReleaseReadiness {
  const artifactsOk = input.artifactCount > 0;
  const demoOk = isReleasableDemoUrl(input.demoUrl);
  const savedOk = !input.hasUnsavedEdits;
  const writeUpProblems = input.writeUp
    ? submissionWriteUpBlockers(input.writeUp)
    : [];
  const writeUpOk = writeUpProblems.length === 0;

  const blockers: string[] = [];
  if (!artifactsOk) blockers.push("The team hasn't uploaded or synced any files yet.");
  if (!demoOk) blockers.push("A demo link starting with https:// is needed.");
  /**
   * ⚠ THE WRITE-UP SITS HERE, ABOVE "save first", DELIBERATELY. Each of its entries names a field and
   * a number, so they read as a to-do list for the form immediately above them; "save the changes on
   * screen" is the LAST thing a team does, and putting it before four things still to write would read
   * as the first.
   *
   * They are spread rather than collapsed into one "the write-up is incomplete" line because a team
   * fixing this needs to know WHICH field and HOW MANY words, the whole reason the floors are visible
   * on the fields too.
   */
  blockers.push(...writeUpProblems);
  if (!savedOk) blockers.push("Save the changes on screen first, release reads what's saved.");

  return { blockers, artifactsOk, demoOk, savedOk, writeUpOk };
}
