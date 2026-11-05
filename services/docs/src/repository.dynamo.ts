import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DocClient } from "@praimana/service-shared";
import type { DocPointer, DocPointerRepository, TeamLookup } from "./domain.js";

/**
 * DynamoDB implementations for the Docs service. The ONLY file that knows about
 * DynamoDB commands/table names; routes depend on the interfaces in domain.ts.
 *
 * Two tables are touched:
 *   - praimana-docs  (OWNED by this service): the latest-version pointer.
 *   - praimana-teams (Team context): read-only, via the id-index GSI, ONLY
 *     to resolve teamId → workshopId for the S3 key layout. This mirrors the exact
 *     query in apps/services/team/src/repository.dynamo.ts `getById`.
 */

const TABLES = {
  docs: process.env.TABLE_DOCS || "praimana-docs",
  teams: process.env.TABLE_TEAMS || "praimana-teams",
} as const;

export class DynamoDocPointerRepository implements DocPointerRepository {
  constructor(private readonly db: DocClient) {}

  async listByTeam(teamId: string): Promise<DocPointer[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.docs,
        KeyConditionExpression: "teamId = :teamId",
        ExpressionAttributeValues: { ":teamId": teamId },
      })
    );
    return (res.Items as DocPointer[]) ?? [];
  }

  async get(teamId: string, path: string): Promise<DocPointer | null> {
    const res = await this.db.send(
      new GetCommand({ TableName: TABLES.docs, Key: { teamId, path } })
    );
    return (res.Item as DocPointer) ?? null;
  }

  async put(pointer: DocPointer): Promise<DocPointer> {
    await this.db.send(new PutCommand({ TableName: TABLES.docs, Item: pointer }));
    return pointer;
  }

  /**
   * ⚠ NO CONDITION EXPRESSION, SO THIS IS IDEMPOTENT. DynamoDB's delete succeeds on a key that is
   * already gone, and that is the behaviour wanted: the route reads the pointer first (it needs the
   * s3Key), so a second click after a slow first one should quietly land on "already removed" rather
   * than raise a conditional-check failure the participant has to interpret.
   */
  async remove(teamId: string, path: string): Promise<void> {
    await this.db.send(
      new DeleteCommand({ TableName: TABLES.docs, Key: { teamId, path } })
    );
  }
}

/**
 * Resolves teamId → workshopId by querying the teams table's id-index GSI (teams
 * is keyed by (workshopId, id); the GSI resolves by id alone). Read-only cross-
 * context access to a single attribute — the workshopId is only used to build the
 * S3 key, never to write Team data.
 */
export class DynamoTeamLookup implements TeamLookup {
  constructor(private readonly db: DocClient) {}

  async workshopIdForTeam(teamId: string): Promise<string | null> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.teams,
        IndexName: "id-index",
        KeyConditionExpression: "id = :id",
        ExpressionAttributeValues: { ":id": teamId },
        Limit: 1,
      })
    );
    const team = res.Items?.[0] as { workshopId?: string } | undefined;
    return team?.workshopId ?? null;
  }
}
