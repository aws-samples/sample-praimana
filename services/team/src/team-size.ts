/**
 * THE TEAM SERVICE'S LOCAL COPY OF THE TEAM-SIZE CEILING.
 *
 * ── WHY A COPY AT ALL, AND WHY EXACTLY ONE ──
 *
 * A deliberate COPY of `MAX_TEAM_MEMBERS` in `shared/constants/teams.ts`. This
 * service is a bundled Lambda that takes no dependency on that workspace package — the same
 * idiom, and the same reason, as `ROLE_GRANTS` and `PLATFORM_ROLE_PRECEDENCE` in routes.ts.
 *
 * It lives in its OWN MODULE rather than being declared in each file that needs it, because
 * three files here need it (`routes.ts` for the invitation gate and the seatCap patch,
 * `repository.dynamo.ts` for a legacy row's default cap, `workshop-access.http.ts` for
 * validating the template it reads) and a per-file constant would mean FIVE copies of the
 * ceiling repo-wide instead of three. The drift test asserts THREE — shared, workshop, team —
 * so keeping this service to one copy is what makes that count meaningful rather than a number
 * that rises every time a file needs the value.
 *
 * ⚠ THE THREE COPIES MUST AGREE. team-size-cap-drift.test.ts fails if they do not. The
 * dangerous direction is TOWARD MORE MEMBERS: raise Workshop's copy alone and a facilitator
 * configures a 15-seat workshop whose teams this service then refuses at 10 — a workshop that
 * cannot be filled, discovered by the participant who is turned away.
 *
 * ⚠ NOT `MAX_RATED_MEMBERS`. The AI service caps ratings at 10 as well and the rule treats
 * the equality a COINCIDENCE, forbidding unification: that number is MEASURED against the
 * model (25 members returns 25 rows with every rationale empty at `stopReason=max_tokens`, a
 * silent wrong answer), so importing this constant there would raise the model cap invisibly
 * the next time the team cap rises.
 */

/** The platform-wide hard limit on ACTIVE members in one team. */
export const MAX_TEAM_MEMBERS = 10;

/**
 * The smallest configurable per-workshop cap. 2 rather than 1 because a "team" of one is an
 * individual, and every team-shaped surface (the roster, the LEAD/BUILDER split, the board)
 * reads as broken for it.
 */
export const MIN_TEAM_SIZE = 2;

/**
 * Whether a value is an acceptable `maxTeamSize` / `seatCap` — an INTEGER in
 * [MIN_TEAM_SIZE, MAX_TEAM_MEMBERS].
 *
 * ⚠ REFUSES RATHER THAN COERCES. A clamp here would be the same defect
 * `num(body.maxTeamSize, 6)` already has in the workshop service: it silently substituted the
 * DEFAULT for a non-numeric value, so `"eight"` became 6 and `999` was stored verbatim — and a
 * stored 999 becomes the seatCap of every new team in that workshop, a cap above the platform
 * ceiling, which §G says must be unreachable rather than grandfathered.
 *
 * Non-integers are refused rather than floored: a `seatCap` of 6.5 makes `memberCount < seatCap`
 * admit a seventh member, so a fractional cap is an off-by-one waiting to be stored.
 * `Number.isInteger` also rejects NaN and both Infinities.
 *
 * MIRRORS `isValidMaxTeamSize` in shared/constants/teams.ts. The drift test
 * compares the CONSTANTS; this predicate is small enough that its duplication is visible, and
 * both copies are exercised by their own tests.
 */
export function isValidMaxTeamSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_TEAM_SIZE &&
    value <= MAX_TEAM_MEMBERS
  );
}
