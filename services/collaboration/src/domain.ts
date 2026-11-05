/**
 * Collaboration bounded context — domain types + repository interfaces.
 *
 * The Collaboration service owns exactly two tables: tasks and messages. It owns
 * NO other context's data (Single Responsibility). Where it needs a user's display
 * name (task creators, message authors) it reads a local users READ-MODEL populated
 * from `user.*` events — never the Identity service's users table, nor the Team
 * service's teams/teamMembers tables (see UsersReadModel + TeamAccess).
 */
import type { ReadModel } from "@praimana/service-shared";

export interface Task {
  teamId: string;
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  order: number;
  creatorId: string;
  assigneeId?: string;
  aiGenerated: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  teamId: string;
  createdAt: string;
  id: string;
  type: string;
  content: string;
  metadata: unknown | null;
  senderId: string;
  parentId: string | null;
}

/**
 * Repository interfaces — domain code depends on THESE, not on DynamoDB (DIP).
 * Narrow by aggregate (Interface Segregation). Swapping the DynamoDB impl for an
 * HTTP/event-backed one later does not touch the routes.
 */
/**
 * A create was refused because a task with that (teamId, id) already exists.
 *
 * ⚠ THE ID IS CALLER-SUPPLIED (`body.id || ulid()`), and the create was a bare full-item Put — so
 * re-posting an existing id silently REPLACED the row, resetting `creatorId` to the caller and
 * `createdAt` to now. The same defect and the same shape as the AI service's thread create, which
 * was hardened after it destroyed a real share.
 */
export class TaskAlreadyExistsError extends Error {
  constructor(
    readonly teamId: string,
    readonly id: string
  ) {
    super(`[collaboration] a task with id ${id} already exists for this team`);
    this.name = "TaskAlreadyExistsError";
  }
}

export interface TaskRepository {
  get(teamId: string, id: string): Promise<Task | null>;
  listByTeam(teamId: string): Promise<Task[]>;
  /**
   * Create a task, REFUSING to overwrite an existing one.
   *
   * Throws `TaskAlreadyExistsError` when (teamId, id) is taken; the route then reports the existing
   * row unchanged. Replaces the old `put`, whose name invited the unconditional write that was
   * reported — no caller legitimately wants "write this task, replacing whatever was there", and
   * `update` below is the path for every field a caller might have meant to change.
   */
  create(task: Task): Promise<Task>;
  /** Partial update of an existing task; returns the merged task. */
  update(teamId: string, id: string, patch: Partial<Task>): Promise<Task | null>;
}

export interface MessageRepository {
  listByTeam(teamId: string, limit: number, before?: string): Promise<Message[]>;
  put(message: Message): Promise<Message>;
}

/** Minimal projection of a user this service needs (name for display). Populated
 *  from Identity's `user.created` / `user.updated` events — this is how we avoid
 *  reading the users table across a service boundary. */
export interface UserView {
  id: string;
  name: string;
}
export type UsersReadModel = ReadModel<UserView, string>;
