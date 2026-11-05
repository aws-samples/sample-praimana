import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DocClient } from "@praimana/service-shared";
import { TaskAlreadyExistsError } from "./domain.js";
import type {
  Task,
  Message,
  TaskRepository,
  MessageRepository,
} from "./domain.js";

/**
 * DynamoDB implementations of the Collaboration repositories. This is the ONLY
 * file in the service that knows about DynamoDB commands or table names. Everything
 * else depends on the interfaces in domain.ts. To extract/re-home later, you write
 * a new implementation of the same interfaces — routes stay untouched.
 */

// Tables THIS service owns. It references no other context's tables (in
// particular NOT users/teams/teamMembers — see users-readmodel + team-access).
const TABLES = {
  tasks: process.env.TABLE_TASKS || "praimana-tasks",
  messages: process.env.TABLE_MESSAGES || "praimana-messages",
} as const;

export class DynamoTaskRepository implements TaskRepository {
  constructor(private readonly db: DocClient) {}

  async get(teamId: string, id: string): Promise<Task | null> {
    const res = await this.db.send(
      new GetCommand({ TableName: TABLES.tasks, Key: { teamId, id } })
    );
    return (res.Item as Task) ?? null;
  }

  async listByTeam(teamId: string): Promise<Task[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.tasks,
        KeyConditionExpression: "teamId = :teamId",
        ExpressionAttributeValues: { ":teamId": teamId },
      })
    );
    return (res.Items as Task[]) ?? [];
  }

  /**
   * ⚠ CONDITIONAL. `attribute_not_exists(teamId)` on a Put means "no item on this KEY" — for a
   * composite key, naming either key attribute is the idiomatic existence test, since a stored item
   * always has both. This replaced a bare Put on a caller-supplied id.
   *
   * The SDK's ConditionalCheckFailedException is translated at THIS boundary, so the route never
   * has to know which error name means "already there".
   */
  async create(task: Task): Promise<Task> {
    try {
      await this.db.send(
        new PutCommand({
          TableName: TABLES.tasks,
          Item: task,
          ConditionExpression: "attribute_not_exists(teamId)",
        })
      );
    } catch (err) {
      if ((err as { name?: string })?.name === "ConditionalCheckFailedException") {
        throw new TaskAlreadyExistsError(task.teamId, task.id);
      }
      throw err;
    }
    return task;
  }

  async update(
    teamId: string,
    id: string,
    patch: Partial<Task>
  ): Promise<Task | null> {
    const updates: string[] = [];
    const removes: string[] = [];
    const values: Record<string, unknown> = {};
    const names: Record<string, string> = {};

    for (const key of [
      "title",
      "description",
      "status",
      "priority",
      "order",
      "assigneeId",
    ] as const) {
      if (patch[key] === undefined) continue;
      // Unassigning (assigneeId null/empty) must REMOVE the attribute — DynamoDB
      // rejects NULL values on the assigneeId-index GSI key attribute.
      if (key === "assigneeId" && !patch.assigneeId) {
        removes.push(`#${key}`);
        names[`#${key}`] = key;
        continue;
      }
      updates.push(`#${key} = :${key}`);
      values[`:${key}`] = patch[key];
      names[`#${key}`] = key;
    }

    updates.push("#updatedAt = :updatedAt");
    values[":updatedAt"] = patch.updatedAt ?? new Date().toISOString();
    names["#updatedAt"] = "updatedAt";

    const updateExpression =
      `SET ${updates.join(", ")}` +
      (removes.length ? ` REMOVE ${removes.join(", ")}` : "");

    try {
      const res = await this.db.send(
        new UpdateCommand({
          TableName: TABLES.tasks,
          Key: { teamId, id },
          UpdateExpression: updateExpression,
          /**
           * ── ⚠ CONDITIONAL, BECAUSE UpdateItem IS AN UPSERT ─────────────────────────────────
           *
           * SECURITY FINDING (Low — "Task PATCH has no existence precondition: the
           * unconditional DynamoDB Update upserts unattributed phantom tasks and mints
           * tasksCompleted activity credit").
           *
           * Without this, a PATCH on an id that was never created CREATED it: a row holding only
           * teamId, id, the patched attributes and updatedAt — no creatorId, no createdAt, no
           * aiGenerated. Unattributable by construction, and indistinguishable afterwards from a
           * task somebody really made.
           *
           * ⚠ AND `create` ABOVE ALREADY GUARDS THE MIRROR CASE, which is what makes the omission
           * an oversight rather than a decision: it carries attribute_not_exists precisely because
           * the route accepts a caller-supplied id, and re-posting an existing id would have
           * replaced the row and reset creatorId to the caller. The same reasoning applies in the
           * other direction and this side was simply missed. The AI service reaches the same
           * conclusion for the same reason (see `touch` in ai/src/repository.dynamo.ts).
           *
           * Naming either key attribute is the idiomatic existence test for a composite key: a
           * stored item always has both.
           */
          ConditionExpression: "attribute_exists(teamId)",
          ExpressionAttributeValues: values,
          ExpressionAttributeNames: names,
          ReturnValues: "ALL_NEW",
        })
      );
      return (res.Attributes as Task) ?? null;
    } catch (err) {
      /**
       * Translated HERE rather than at the route, exactly as `create` translates its own
       * conditional failure: "no such task" is a repository fact, and a caller that had to know
       * which SDK error name means that would be a caller that can get it wrong.
       *
       * ⚠ null, NOT a throw — and null is already this method's "nothing came back" answer, so
       * the route's existing handling of it needs no new shape.
       */
      if ((err as { name?: string })?.name === "ConditionalCheckFailedException") return null;
      throw err;
    }
  }
}

export class DynamoMessageRepository implements MessageRepository {
  constructor(private readonly db: DocClient) {}

  async listByTeam(
    teamId: string,
    limit: number,
    before?: string
  ): Promise<Message[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.messages,
        KeyConditionExpression: before
          ? "teamId = :teamId AND createdAt < :before"
          : "teamId = :teamId",
        ExpressionAttributeValues: {
          ":teamId": teamId,
          ...(before ? { ":before": before } : {}),
        },
        // Newest first (RANGE key is createdAt), then Limit the recent window.
        ScanIndexForward: false,
        Limit: limit,
      })
    );
    return (res.Items as Message[]) ?? [];
  }

  async put(message: Message): Promise<Message> {
    await this.db.send(
      new PutCommand({ TableName: TABLES.messages, Item: message })
    );
    return message;
  }
}
