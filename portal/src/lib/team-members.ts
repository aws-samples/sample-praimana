import type { TeamMemberRecord } from "@/lib/backend-types";

/**
 * ── WHO IS ACTUALLY ON A TEAM ─────────────────────────────────────────────────────────────────
 *
 * A roster row EXCLUDING removed people, applied identically wherever this BFF answers "who is
 * on this team".
 *
 * ⚠ THE POLARITY IS FORCED, NOT PREFERRED. Rows written before `status` existed carry NO
 * attribute, and absent means ACTIVE, so `=== "ACTIVE"` would empty every legacy team's roster
 * and, on the workspace layout, take the tabs with it. Compared case-insensitively for the same
 * reason the service does. The full reasoning lives at `team.getById`, which is where the rule
 * was first needed.
 *
 * ⚠ IN ITS OWN MODULE BECAUSE THERE ARE FOUR CONSUMERS, AND THE FOURTH IS NOT A ROUTER. This
 * was a `const` inside `trpc/routers/team.ts`, so the non-tRPC desktop route
 * (`api/desktop/team-data/route.ts`) could not import it and re-implemented the comparison
 * inline, and `workshop.getById`, the fourth consumer of the same `?withMembers=1` fold -
 * simply did not apply it at all. That is a reported finding, not a tidiness point: the
 * experience detail page counted and rendered removed people as current members, over-reporting
 * team occupancy against `maxTeamSize` and keeping a removed participant's email on a staff
 * surface after their access was withdrawn.
 *
 * A route importing from a router would be the wrong direction of dependency, so the rule lives
 * here, below both, and all four consumers import it. A fifth consumer now has one obvious
 * thing to import rather than two lines to copy.
 */
export const isActiveMember = (m: TeamMemberRecord) =>
  String(m?.status ?? "").trim().toUpperCase() !== "INACTIVE";

/**
 * The `?withMembers=1` fold, with removed rows excluded and the count derived from what
 * survived.
 *
 * ⚠ THE COUNT IS RECOMPUTED, NOT PREFERRED FROM THE SERVICE. `_count.members` as the service
 * sends it counts INACTIVE rows too, so `t._count?.members ?? filtered.length` would keep
 * reporting the unfiltered total whenever the service supplied one, i.e. the fallback would be
 * the only correct branch. The filtered array is the roster this tier is about to return, so it
 * is also the only defensible denominator for the "n / maxTeamSize members" seat line.
 */
export function withActiveMembers<
  T extends { members?: TeamMemberRecord[]; _count?: { members?: number } },
>(team: T): Omit<T, "members" | "_count"> & {
  members: TeamMemberRecord[];
  _count: { members: number };
} {
  const members = (team.members || []).filter(isActiveMember);
  // `Omit` and not `T &`: the input's `_count.members` is OPTIONAL and this one is not, and an
  // intersection of the two would leave callers reading a `number | undefined` they now cannot get.
  return { ...team, members, _count: { members: members.length } };
}
