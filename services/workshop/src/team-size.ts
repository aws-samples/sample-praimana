/**
 * THE WORKSHOP SERVICE'S LOCAL COPY OF THE TEAM-SIZE CEILING.
 *
 * ── WHY A COPY, AND WHY THIS SERVICE NEEDS ONE ──
 *
 * A deliberate COPY of `MAX_TEAM_MEMBERS` in `shared/constants/teams.ts`. This is
 * a bundled Lambda that takes no dependency on that workspace package — the same idiom, and the
 * same reason, as `ROLE_GRANTS` in the team service.
 *
 * This service needs it because it owns `Workshop.maxTeamSize`, which is defined as
 * *the template applied to new teams*: the Team service seeds a new team's `seatCap` from it and
 * never re-reads it. So a `maxTeamSize` above the platform ceiling is not a cosmetic problem —
 * it becomes the seatCap of every team created in that workshop, i.e. a team permitted to exceed
 * the platform limit, which §G says must be unreachable rather than grandfathered.
 *
 * ⚠ IT WAS ENFORCED NOWHERE UNTIL NOW. The field has existed since the services were split,
 * defaults to 6, and is patchable through an allowlist loop — and nothing ever consulted it or
 * bounded it. `num(body.maxTeamSize, 6)` silently substituted the DEFAULT for a non-numeric
 * value (so `"eight"` became 6) and stored an out-of-range one verbatim (so `999` was accepted).
 * The portal validated `z.number().min(2).max(10)`, but the portal is a BFF and not the
 * boundary: this route is independently reachable with the caller's own token.
 *
 * ⚠ THE THREE COPIES MUST AGREE — shared, workshop, team. team-size-cap-drift.test.ts fails if
 * they do not. The dangerous direction is TOWARD MORE MEMBERS: raise THIS copy alone and a
 * facilitator configures a 15-seat workshop whose teams the Team service refuses at 10 — a
 * workshop that cannot be filled, discovered by the participant who is turned away.
 */

/** The platform-wide hard limit on ACTIVE members in one team. */
export const MAX_TEAM_MEMBERS = 10;

/**
 * The smallest configurable per-workshop cap. 2 rather than 1 because a "team" of one is an
 * individual, and every team-shaped surface reads as broken for it.
 */
export const MIN_TEAM_SIZE = 2;

/**
 * Whether a value is an acceptable `maxTeamSize` — an INTEGER in [MIN_TEAM_SIZE,
 * MAX_TEAM_MEMBERS].
 *
 * ⚠ REFUSES RATHER THAN COERCES, which is the entire point of introducing it here: the existing
 * `num(v, fallback)` helper coerces, and that is how an unvalidated value became either a silent
 * default or a stored 999. A non-numeric `maxTeamSize` must be a 400 the caller can see, not a 6
 * they did not ask for.
 *
 * Non-integers are refused rather than floored: the Team service enforces `memberCount <
 * seatCap`, so a cap of 6.5 admits a seventh member. `Number.isInteger` also rejects NaN and
 * both Infinities.
 */
export function isValidMaxTeamSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_TEAM_SIZE &&
    value <= MAX_TEAM_MEMBERS
  );
}
