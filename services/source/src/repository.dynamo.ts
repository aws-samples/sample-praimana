import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DocClient } from "@praimana/service-shared";
import { CommitAlreadyExistsError } from "./domain.js";
import type {
  GitCommit,
  GitFile,
  CommitRepository,
  FileRepository,
} from "./domain.js";

/**
 * DynamoDB implementations of the Source repositories. This is the ONLY file in
 * the service that knows about DynamoDB commands or table names. Everything else
 * depends on the interfaces in domain.ts. To extract/re-home later, you write a
 * new implementation of the same interfaces — routes stay untouched.
 */

// Tables THIS service owns. It references no other context's tables.
const TABLES = {
  gitCommits: process.env.TABLE_GIT_COMMITS || "praimana-git-commits",
  gitFiles: process.env.TABLE_GIT_FILES || "praimana-git-files",
} as const;

export class DynamoCommitRepository implements CommitRepository {
  constructor(private readonly db: DocClient) {}

  async listByTeam(teamId: string, limit: number): Promise<GitCommit[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.gitCommits,
        KeyConditionExpression: "teamId = :teamId",
        ExpressionAttributeValues: { ":teamId": teamId },
        ScanIndexForward: false,
        Limit: limit,
      })
    );
    return (res.Items as GitCommit[]) ?? [];
  }

  async getBySha(teamId: string, sha: string): Promise<GitCommit | null> {
    // Commits are keyed by (teamId, date); the sha is a plain attribute, so we
    // query the partition and filter to the requested sha.
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.gitCommits,
        KeyConditionExpression: "teamId = :teamId",
        FilterExpression: "sha = :sha",
        ExpressionAttributeValues: { ":teamId": teamId, ":sha": sha },
      })
    );
    return (res.Items?.[0] as GitCommit) ?? null;
  }

  /**
   * ⚠ CONDITIONAL. `attribute_not_exists(teamId)` on a Put means "no item on this KEY" — for a
   * composite key, naming either key attribute is the idiomatic existence test, since a stored
   * item always has both. This replaced a bare Put on a caller-supplied sort key.
   *
   * The ConditionalCheckFailedException is translated at THIS boundary rather than left to the
   * route, so the route never has to know which SDK error name means "already there".
   */
  async create(commit: GitCommit): Promise<GitCommit> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: TABLES.gitCommits,
          Item: commit,
          ConditionExpression: "attribute_not_exists(teamId)",
        })
      );
    } catch (err) {
      if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
        throw new CommitAlreadyExistsError(commit.teamId, commit.date);
      }
      throw err;
    }
    return commit;
  }
}

export class DynamoFileRepository implements FileRepository {
  constructor(private readonly db: DocClient) {}

  async listByTeam(teamId: string): Promise<GitFile[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.gitFiles,
        KeyConditionExpression: "teamId = :teamId",
        ExpressionAttributeValues: { ":teamId": teamId },
      })
    );
    return (res.Items as GitFile[]) ?? [];
  }

  async getByPath(teamId: string, path: string): Promise<GitFile | null> {
    // `path` is a DynamoDB reserved word — alias it.
    const res = await this.db.send(
      new GetCommand({ TableName: TABLES.gitFiles, Key: { teamId, path } })
    );
    return (res.Item as GitFile) ?? null;
  }

  /**
   * ADD the deltas, SET the latest-fact fields. An UpdateCommand upserts, so the first commit to
   * touch a path creates its row — `ADD` treats a missing numeric attribute as 0.
   *
   * ⚠ EVERY ATTRIBUTE IN THE EXPRESSION IS ALIASED. `commits` is a DynamoDB RESERVED WORD and an
   * unaliased reference to it would fail at runtime on the one write that matters; the rest are
   * aliased alongside it so the expression is uniform and a future rename cannot half-break it.
   * `path` needs no alias here because it appears only in `Key`, which is not an expression.
   */
  async accumulate(delta: GitFile): Promise<GitFile> {
    const res = await this.db.send(
      new UpdateCommand({
        TableName: TABLES.gitFiles,
        Key: { teamId: delta.teamId, path: delta.path },
        UpdateExpression:
          "ADD #additions :additions, #deletions :deletions, #commits :commits " +
          "SET #lastAuthor = :lastAuthor, #updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#additions": "additions",
          "#deletions": "deletions",
          "#commits": "commits",
          "#lastAuthor": "lastAuthor",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":additions": delta.additions,
          ":deletions": delta.deletions,
          ":commits": delta.commits,
          ":lastAuthor": delta.lastAuthor,
          ":updatedAt": delta.updatedAt,
        },
        ReturnValues: "ALL_NEW",
      })
    );
    return res.Attributes as GitFile;
  }
}
