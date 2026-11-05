/**
 * WHICH PHASE SHOWS THE TEAM'S FILES.
 *
 * Files are produced during building, so the files-and-contributors panel hangs off the build
 * phase rather than sitting in a tab of its own (see PhaseArtifacts for why the Code tab went).
 *
 * ── WHY THIS IS A NAME MATCH, AND WHY THAT IS UNCOMFORTABLE ──
 *
 * Phases are DATA, not an enum: a facilitator names them per workshop, and the store keeps only
 * `order`, `name` and `description`, there is no "kind" field to key on. The seeded pipeline is
 * Ideation / Build / Demo, so "Build" is what exists today, but nothing stops a workshop from
 * calling it "Development" or "Hack".
 *
 * So this recognises a SET of ordinary names for the same phase rather than one literal. That
 * is a heuristic and it is written down as one, because the failure mode matters:
 *
 *   - a phase we FAIL to recognise loses the panel, and the files become unreachable
 *   - a phase we WRONGLY recognise shows the panel twice, which is untidy but harmless
 *
 * Hence the fallback in `buildPhaseIdFor`: if nothing matches by name, the panel attaches to the
 * LAST phase before the final one, the build slot in a three-phase pipeline, so a renamed phase
 * degrades to the right position instead of hiding the files entirely. Never zero, never all.
 *
 * The proper fix is a phase `kind` on the workshop model, which is a schema change and a
 * facilitator-facing decision. Until then this is deliberately
 * conservative and deliberately visible.
 */

/** Ordinary names for "the phase where the team builds". Compared case-insensitively. */
const BUILD_PHASE_NAMES = [
  "build",
  "building",
  "develop",
  "development",
  "hack",
  "hacking",
  "implement",
  "implementation",
  "prototype",
] as const;

export function isBuildPhase(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  // Whole-word-ish rather than `includes`: "Rebuild the pitch" is not the build phase, but
  // "Build & Test" is. Splitting on non-letters catches the common compound names.
  return n
    .split(/[^a-z]+/)
    .filter(Boolean)
    .some((word) => (BUILD_PHASE_NAMES as readonly string[]).includes(word));
}

/** The minimum a phase must carry for this decision. */
export interface PhaseLike {
  id: string;
  order: number;
  name: string;
}

/**
 * The id of the ONE phase that should carry the files panel, or null when there are no phases.
 *
 * Returns a single id rather than a predicate applied per row, because "show the panel on every
 * phase whose name looks like Build" would duplicate it in a pipeline with two such phases, and
 * a reader seeing the same file list twice cannot tell which is authoritative.
 */
export function buildPhaseIdFor(phases: readonly PhaseLike[]): string | null {
  if (phases.length === 0) return null;

  const ordered = [...phases].sort((a, b) => a.order - b.order);

  // First by name, in pipeline order, an earlier match wins, so a "Build" phase followed by a
  // "Rebuild" one attaches to the real one.
  const named = ordered.find((p) => isBuildPhase(p.name));
  if (named) return named.id;

  /**
   * NOTHING MATCHED, fall back on POSITION rather than dropping the panel.
   *
   * The phase before the last is the build slot in the canonical Ideation / Build / Demo shape.
   * With one or two phases there is no "before the last" worth calling build, so it attaches to
   * the last: a two-phase workshop's second phase is where the work lands.
   */
  if (ordered.length <= 2) return ordered[ordered.length - 1].id;
  return ordered[ordered.length - 2].id;
}
