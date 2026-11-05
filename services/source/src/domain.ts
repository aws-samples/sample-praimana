/**
 * Source-control bounded context — domain types + repository interfaces.
 *
 * The Source service owns exactly two tables: gitCommits and gitFiles. It owns NO
 * other context's data (Single Responsibility). Where it needs a user's display
 * name for author enrichment, it reads a local users READ-MODEL populated from
 * `user.*` events — never the Identity service's table, nor the Team service's
 * teamMembers table (see UsersReadModel / TeamAccess below).
 */
import type { ReadModel } from "@praimana/service-shared";

/**
 * A git commit recorded for a team. Mirrors the monolith's gitCommits item shape:
 * PK = teamId, SK = date (ISO timestamp of the commit). The `sha` is carried as a
 * plain attribute — commits are addressed within a team by their sha in the API,
 * resolved to the date-keyed item via a filtered query.
 */
export interface GitCommit {
  teamId: string;
  /** RANGE key — commit timestamp (ISO). Ordering commits newest-first. */
  date: string;
  sha: string;
  message: string;
  author: string;
  additions: number;
  deletions: number;
  createdAt: string;
}

/**
 * An aggregated file/contribution row for a team. Mirrors the monolith's gitFiles
 * item shape: PK = teamId, SK = path. One row per tracked path, holding rolled-up
 * contribution stats rather than a per-commit snapshot.
 */
export interface GitFile {
  teamId: string;
  /** RANGE key — the file path within the team's repository. */
  path: string;
  additions: number;
  deletions: number;
  commits: number;
  lastAuthor: string | null;
  updatedAt: string;
}

/**
 * Repository interfaces — domain code depends on THESE, not on DynamoDB (DIP).
 * Narrow by aggregate (Interface Segregation). Swapping the DynamoDB impl for an
 * HTTP/event-backed one later does not touch the routes.
 */
/**
 * A create was refused because the (teamId, date) item already exists.
 *
 * ⚠ THE POINT IS THAT IT IS AN ERROR AT ALL. `put` was a bare PutCommand on a CALLER-SUPPLIED
 * sort key, so replaying an existing commit's `date` replaced that row — message, stats and
 * author — with no update route in the service that could have done it legitimately. Commit
 * history has no other mutation path, which is what made a silent replace a history rewrite.
 */
export class CommitAlreadyExistsError extends Error {
  constructor(
    readonly teamId: string,
    readonly date: string
  ) {
    super(`[source] a commit already exists for this team at ${date}`);
    this.name = "CommitAlreadyExistsError";
  }
}

export interface CommitRepository {
  listByTeam(teamId: string, limit: number): Promise<GitCommit[]>;
  getBySha(teamId: string, sha: string): Promise<GitCommit | null>;
  /**
   * Record a commit, REFUSING to overwrite an existing one.
   *
   * Throws `CommitAlreadyExistsError` when (teamId, date) is taken. Replaces the old `put`, whose
   * name invited exactly the unconditional write that was reported — there is no legitimate
   * caller that wants "write this commit, replacing whatever was there".
   */
  create(commit: GitCommit): Promise<GitCommit>;
}

export interface FileRepository {
  listByTeam(teamId: string): Promise<GitFile[]>;
  getByPath(teamId: string, path: string): Promise<GitFile | null>;
  /**
   * ADD the commit's deltas onto this path's rolled-up row, creating it on first touch.
   *
   * ⚠ REPLACES A BARE `put`, WHICH WAS LOSING DATA ON EVERY COMMIT. These rows hold "rolled-up
   * contribution stats rather than a per-commit snapshot" (see GitFile), and the values a commit
   * carries are DELTAS — `commits` defaults to 1, which is only meaningful as "this commit touched
   * this path once". A full-item Put therefore discarded the accumulated totals and left the most
   * recent commit's numbers standing in for the file's entire history, so the team's contribution
   * record was wrong for every path touched more than once.
   *
   * `lastAuthor` and `updatedAt` are SET (they are the latest fact, not a sum); the three counters
   * are ADDed.
   */
  accumulate(delta: GitFile): Promise<GitFile>;
}

/** Minimal projection of a user this service needs (name for author enrichment).
 *  Populated from Identity's `user.*` events — this is how we avoid reading the
 *  users table across a service boundary. */
export interface UserView {
  id: string;
  name: string;
}
export type UsersReadModel = ReadModel<UserView, string>;
