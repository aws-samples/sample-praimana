/**
 * A person's role WITHIN a team, as distinct from their platform role.
 *
 * EXECUTIVE and COACH were added after an executive
 * invited to a team was tagged "Builder" — the invite form defaulted the dropdown to
 * BUILDER, so anyone invited without an explicit choice became one. They are team roles
 * here, not platform roles: an EXECUTIVE platform role grants read-only observation
 * across a workshop, whereas this says what someone does inside one team. The two
 * happen to share a name because the same person usually holds both.
 */
export type TeamRole =
  | "LEAD"
  | "BUILDER"
  | "PRODUCT"
  | "DESIGNER"
  | "EXECUTIVE"
  | "COACH";

export interface Team {
  id: string;
  workshopId: string;
  name: string;
  description?: string;
  avatarUrl?: string;
  inviteCode: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  role: TeamRole;
  joinedAt: string;
}
