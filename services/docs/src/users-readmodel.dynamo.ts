import { GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { DocClient } from "@praimana/service-shared";
import type { UserView, UsersReadModel } from "./domain.js";

/**
 * Local users read-model for the Docs service — the SIXTH, added because this service had none.
 *
 * ── THE REPORTED BUG ──
 *
 * A file uploaded from the desktop app showed its author as
 * `94c89498-90e1-7070-dd34-b71a17076f4c` instead of a name. That id is a Cognito `sub`, and it is
 * exactly what `lastAuthor` stores: the docs routes write the caller's identity id and had no way to
 * turn it into a name, because this service was the only one of six with a reader-shaped need and no
 * read-model at all.
 *
 * Confirmed rather than assumed: that id resolves to "Participant Five" in the collaboration
 * read-model, so the name existed on the platform the whole time — this service simply could not see
 * it.
 *
 * ── WHY A LOCAL COPY RATHER THAN A LOOKUP ──
 *
 * Reading Identity's users table across a service boundary is forbidden, and an HTTP hop
 * to Identity is not available to this Lambda in the same shape the others use. Each service keeps a
 * tiny event-synced projection of just the fields it needs; this one holds `{id, name}` and nothing
 * more, because a document list needs a display name and no other user attribute.
 *
 * ⚠ A TABLE WITH A READER AND NO WRITER FAILS SILENTLY. That is not hypothetical here: the ai and
 * evaluation read-models sat at 0 rows for the life of the deployment because `TARGET_TABLES` in
 * user-projection held three entries while five services had a read-model class — and the reader's
 * `?? null` is indistinguishable from "no name yet". So this class ships together with its entry in
 * that array and the table in the template; adding one without the others reproduces the same
 * invisible failure.
 */
export class DynamoUsersReadModel implements UsersReadModel {
  /**
   * Defaulted to the same literal `TARGET_TABLES` defaults to. Duplicated deliberately rather than
   * shared: if the two ever drift, the projection writes to a table nothing reads — which is the
   * failure above, and the duplication is what makes the drift visible in a diff.
   */
  private readonly table =
    process.env.TABLE_DOCS_USERS_READMODEL || "praimana-docs-users-readmodel";

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
