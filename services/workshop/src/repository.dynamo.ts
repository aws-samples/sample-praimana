import {
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DocClient } from "@praimana/service-shared";
import type {
  Workshop,
  WorkshopCatalogueEntry,
  Phase,
  TeamPhase,
  Format,
  WorkshopRepository,
  PhaseRepository,
  TeamPhaseRepository,
  FormatRepository,
} from "./domain.js";

/**
 * DynamoDB implementations of the Workshop repositories. This is the ONLY file in
 * the service that knows about DynamoDB commands or table names. Everything else
 * depends on the interfaces in domain.ts. To extract/re-home later, you write a
 * new implementation of the same interfaces — routes stay untouched.
 */

// Tables THIS service owns. It references no other context's tables (no users,
// teams, teamMembers, or messages).
const TABLES = {
  workshops: process.env.TABLE_WORKSHOPS || "praimana-workshops",
  phases: process.env.TABLE_PHASES || "praimana-phases",
  teamPhases: process.env.TABLE_TEAM_PHASES || "praimana-team-phases",
  formats: process.env.TABLE_FORMATS || "praimana-formats",
} as const;

export class DynamoWorkshopRepository implements WorkshopRepository {
  constructor(private readonly db: DocClient) {}

  async listByOwner(ownerId: string): Promise<Workshop[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.workshops,
        KeyConditionExpression: "ownerId = :ownerId",
        ExpressionAttributeValues: { ":ownerId": ownerId },
        ScanIndexForward: false,
      })
    );
    return (res.Items as Workshop[]) ?? [];
  }

  /**
   * Every workshop, id and name only — the ADMIN catalogue.
   *
   * ⚠ THE ONLY SCAN IN THIS SERVICE, and it is a Scan because the access pattern genuinely has
   * no key: `workshops` is keyed (ownerId HASH, id RANGE) and this asks across ALL owners. The
   * id-index GSI does not help — it is keyed on `id`, so reading every row through it is the
   * same full pass with an extra projection.
   *
   * ⚠ `Limit` IS NOT A ROW COUNT ON A SCAN — it caps rows EXAMINED before DynamoDB returns, and
   * with no FilterExpression here the two coincide. Asked for `limit + 1` so "there is more"
   * is decided from a row rather than from `LastEvaluatedKey`, which a Scan also sets when it
   * stops exactly on the last row — the polarity bug recorded for the teams
   * directory, where `!exhausted` became "always more" and offered a Next onto an empty page.
   *
   * ⚠ ProjectionExpression IS THE AUTHORIZATION BOUNDARY, not bandwidth. `#n` aliases `name`,
   * which is a DynamoDB reserved word; without the projection this would pull setupConfig,
   * phases and dates for every experience on the platform into a process whose caller is
   * entitled to see two fields (see WorkshopCatalogueEntry).
   */
  async listAllForCatalogue(
    limit: number
  ): Promise<{ workshops: WorkshopCatalogueEntry[]; truncated: boolean }> {
    const res = await this.db.send(
      new ScanCommand({
        TableName: TABLES.workshops,
        ProjectionExpression: "id, #n",
        ExpressionAttributeNames: { "#n": "name" },
        Limit: limit + 1,
      })
    );
    const rows = (res.Items ?? []) as Array<{ id?: unknown; name?: unknown }>;
    const truncated = rows.length > limit;
    const workshops = rows
      .slice(0, limit)
      // Rows missing either field are DROPPED rather than rendered as a blank option: an
      // unnamed entry in a picker is a control an operator cannot reason about, and an
      // entry with no id posts an invitation that would 400.
      .filter(
        (r): r is { id: string; name: string } =>
          typeof r.id === "string" && r.id !== "" && typeof r.name === "string" && r.name !== ""
      )
      .map((r) => ({ id: r.id, name: r.name }))
      // Alphabetical, because a Scan's order is arbitrary and an arbitrarily-ordered picker
      // is one an operator has to read end to end every time.
      .sort((a, b) => a.name.localeCompare(b.name));
    return { workshops, truncated };
  }

  async getById(id: string): Promise<Workshop | null> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.workshops,
        IndexName: "id-index",
        KeyConditionExpression: "id = :id",
        ExpressionAttributeValues: { ":id": id },
        Limit: 1,
      })
    );
    return (res.Items?.[0] as Workshop) ?? null;
  }

  async listByIds(ids: string[]): Promise<Workshop[]> {
    const unique = [...new Set(ids.filter(Boolean))].slice(0, 50);
    if (unique.length === 0) return [];

    const results = await Promise.all(unique.map((id) => this.getById(id)));

    // Dangling ids drop out rather than becoming nulls the caller has to filter.
    const found = results.filter((w): w is Workshop => w !== null);

    // Newest first, matching listByOwner. Sorted here rather than relying on the
    // fan-out's completion order, which is arbitrary.
    return found.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * Move the workshop to a new owner, atomically. See `WorkshopRepository.transferOwner`.
   *
   * ⚠ BOTH CONDITIONS ARE LOAD-BEARING, and they answer different questions:
   *
   *   · `attribute_not_exists(ownerId)` on the PUT refuses to overwrite an existing row at the
   *     destination key. `id` is a ULID so a collision should be impossible — which is exactly
   *     why a silent overwrite would be the worst way to find out it was not.
   *   · `attribute_exists(ownerId)` on the DELETE refuses if the source is already gone. That is
   *     what makes a concurrent double-transfer resolve to one winner and one `"conflict"`
   *     instead of both reporting success while one of them destroyed the other's write.
   *
   * A cancelled transaction is reported as `"conflict"`, never as an error: it is an ordinary
   * outcome of two operators acting at once, and the caller's remedy is to re-read.
   */
  async transferOwner(
    workshop: Workshop,
    toOwnerId: string
  ): Promise<"transferred" | "conflict"> {
    try {
      await this.db.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TABLES.workshops,
                Item: { ...workshop, ownerId: toOwnerId },
                ConditionExpression: "attribute_not_exists(ownerId)",
              },
            },
            {
              Delete: {
                TableName: TABLES.workshops,
                Key: { ownerId: workshop.ownerId, id: workshop.id },
                ConditionExpression: "attribute_exists(ownerId)",
              },
            },
          ],
        })
      );
      return "transferred";
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === "TransactionCanceledException" || name === "ConditionalCheckFailedException") {
        return "conflict";
      }
      throw err;
    }
  }

  async put(workshop: Workshop): Promise<Workshop> {
    await this.db.send(
      new PutCommand({ TableName: TABLES.workshops, Item: workshop })
    );
    return workshop;
  }

  async update(
    ownerId: string,
    id: string,
    patch: Partial<Workshop>
  ): Promise<void> {
    // Build a dynamic SET expression, aliasing every attribute name so reserved
    // words (name, status, format, …) are always safe.
    const updates: string[] = [];
    const values: Record<string, unknown> = {};
    const names: Record<string, string> = {};

    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || key === "ownerId" || key === "id") continue;
      updates.push(`#${key} = :${key}`);
      values[`:${key}`] = value;
      names[`#${key}`] = key;
    }
    if (updates.length === 0) return;

    await this.db.send(
      new UpdateCommand({
        TableName: TABLES.workshops,
        Key: { ownerId, id },
        UpdateExpression: `SET ${updates.join(", ")}`,
        ExpressionAttributeValues: values,
        ExpressionAttributeNames: names,
      })
    );
  }
}

export class DynamoPhaseRepository implements PhaseRepository {
  constructor(private readonly db: DocClient) {}

  async listByWorkshop(workshopId: string): Promise<Phase[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.phases,
        KeyConditionExpression: "workshopId = :workshopId",
        ExpressionAttributeValues: { ":workshopId": workshopId },
        ScanIndexForward: true,
      })
    );
    return (res.Items as Phase[]) ?? [];
  }

  async put(phase: Phase): Promise<Phase> {
    await this.db.send(new PutCommand({ TableName: TABLES.phases, Item: phase }));
    return phase;
  }

}

export class DynamoTeamPhaseRepository implements TeamPhaseRepository {
  constructor(private readonly db: DocClient) {}

  async listByTeam(teamId: string): Promise<TeamPhase[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.teamPhases,
        KeyConditionExpression: "teamId = :teamId",
        ExpressionAttributeValues: { ":teamId": teamId },
      })
    );
    return (res.Items as TeamPhase[]) ?? [];
  }

  async put(teamPhase: TeamPhase): Promise<TeamPhase> {
    await this.db.send(
      new PutCommand({ TableName: TABLES.teamPhases, Item: teamPhase })
    );
    return teamPhase;
  }
}

export class DynamoFormatRepository implements FormatRepository {
  constructor(private readonly db: DocClient) {}

  async listByCategory(category: string): Promise<Format[]> {
    const res = await this.db.send(
      new QueryCommand({
        TableName: TABLES.formats,
        KeyConditionExpression: "category = :category",
        ExpressionAttributeValues: { ":category": category },
        ScanIndexForward: true,
      })
    );
    return (res.Items ?? []).map((item) => ({
      name: item.name,
      value: item.value,
    }));
  }
}
