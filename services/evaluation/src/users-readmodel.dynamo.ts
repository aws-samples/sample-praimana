import { GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { DocClient } from "@praimana/service-shared";
import type { UserView, UsersReadModel } from "./domain.js";

/**
 * Local users read-model for the Evaluation service. Holds ONLY {id, name, email}
 * — the minimal projection this service needs to enrich ratings/scores with a
 * display name. It is populated by consuming the Identity service's
 * `user.created` / `user.updated` events (wire the consumer to call upsert()),
 * NOT by reading Identity's users table.
 *
 * This is the concrete answer to "the rating aggregator read the users table":
 * each service keeps its own tiny, event-synced copy of just the fields it needs.
 */
export class DynamoUsersReadModel implements UsersReadModel {
  private readonly table =
    process.env.TABLE_EVALUATION_USERS_READMODEL ||
    "praimana-evaluation-users-readmodel";

  constructor(private readonly db: DocClient) {}

  async get(id: string): Promise<UserView | null> {
    const res = await this.db.send(
      new GetCommand({ TableName: this.table, Key: { id } })
    );
    return (res.Item as UserView) ?? null;
  }

  async upsert(item: UserView): Promise<void> {
    await this.db.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  async delete(id: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: { id } }));
  }
}
