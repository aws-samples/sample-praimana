export type PhaseType =
  | "PROBLEM_DEFINITION"
  | "IDEATION"
  | "ARCHITECTURE"
  | "BUILD"
  | "DEMO";

export type PhaseStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";

export interface Phase {
  id: string;
  workshopId: string;
  type: PhaseType;
  order: number;
  name: string;
  description?: string;
  templateJson?: Record<string, unknown>;
  durationMinutes?: number;
  startsAt?: string;
  endsAt?: string;
}

export interface TeamPhase {
  id: string;
  teamId: string;
  phaseId: string;
  status: PhaseStatus;
  startedAt?: string;
  completedAt?: string;
  artifactJson?: Record<string, unknown>;
}
