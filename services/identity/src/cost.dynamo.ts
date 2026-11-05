import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { DocClient } from "@praimana/service-shared";
import type { CostReader, CostSnapshot } from "./domain.js";

/**
 * ── ⚠ A CACHE THAT EXISTS TO BOUND A BILL, NOT TO SAVE LATENCY ──────────────────────────────
 *
 * The Cost Explorer API charges **$0.01 per request**, and "if your result set is paginated each page counts
 * as a separate request" (AWS Cost Explorer pricing). This platform spends about $1/day. So
 * an uncached panel refreshed twenty times in a day would cost ~$0.40 — roughly FORTY PERCENT of the spend it
 * is reporting. That is the entire reason this file exists, and it is why the cache is persistent rather than
 * in-process.
 *
 * ⚠ IN-MEMORY WOULD NOT HAVE WORKED, which is the non-obvious part. A Lambda execution environment is
 * recycled after a few minutes idle, so on a low-traffic admin screen almost every visit is a cold container
 * — a process-local cache would be a cache that essentially never hits, and the bill would look like no cache
 * at all. The snapshot has to outlive the container.
 *
 * ⚠ AND A STALE SNAPSHOT IS SERVED IN PREFERENCE TO AN ERROR, deliberately. There is no TTL on the row: if
 * Cost Explorer is unreachable or the refresh throws, the panel shows the last known figures WITH their age
 * ("as of 9 hours ago"). For a cost readout that is strictly better than an error page — the number moves
 * slowly, and Cost Explorer itself only updates a few times a day, so six-hour-old data is not meaningfully
 * worse than live data.
 *
 * ⚠ THE REFRESH IS NOT LOCKED, and that is an accepted trade rather than an oversight. Two admins loading the
 * page in the same second while the cache is stale will both refresh: two extra requests, two cents. A
 * conditional-write lease would cost a write, a failure mode, and more code than the two cents it protects.
 * Named here so it reads as a decision.
 */

/** How long a snapshot is considered fresh. Cost Explorer updates roughly three times a day. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** One row, one key. There is exactly one snapshot per account and it is overwritten in place. */
const ROW_ID = "SNAPSHOT";

export class CachedCostReader implements CostReader {
  private readonly table = process.env.TABLE_COST_CACHE || "praimana-cost-cache";

  constructor(
    private readonly db: DocClient,
    /** The thing that actually costs money. Injected so the cache can be tested without it. */
    private readonly source: CostReader
  ) {}

  async read(): Promise<CostSnapshot> {
    const cached = await this.load();
    if (cached && Date.now() - Date.parse(cached.asOf) < MAX_AGE_MS) return cached;

    try {
      const fresh = await this.source.read();
      await this.store(fresh);
      return fresh;
    } catch (err) {
      /**
       * ⚠ THE STALE SNAPSHOT WINS OVER THE ERROR. Losing the refresh should cost freshness, not the panel —
       * and `asOf` travels with the data, so the surface can say how old it is instead of implying it is
       * current.
       */
      if (cached) {
        console.warn("[identity] cost refresh failed — serving the last snapshot", {
          asOf: cached.asOf,
          error: err instanceof Error ? err.name : "unknown",
        });
        return cached;
      }
      throw err;
    }
  }

  private async load(): Promise<CostSnapshot | null> {
    try {
      const res = await this.db.send(
        new GetCommand({ TableName: this.table, Key: { id: ROW_ID } })
      );
      const snapshot = res.Item?.snapshot as CostSnapshot | undefined;
      // A row with no parseable `asOf` is treated as absent: it cannot be aged, so it cannot be trusted.
      return snapshot && typeof snapshot.asOf === "string" && !Number.isNaN(Date.parse(snapshot.asOf))
        ? snapshot
        : null;
    } catch (err) {
      // A cache read failure must not fail the request — it falls through to a live read.
      console.warn("[identity] cost cache unreadable", {
        error: err instanceof Error ? err.name : "unknown",
      });
      return null;
    }
  }

  private async store(snapshot: CostSnapshot): Promise<void> {
    try {
      await this.db.send(
        new PutCommand({ TableName: this.table, Item: { id: ROW_ID, snapshot } })
      );
    } catch (err) {
      /**
       * ⚠ A FAILED WRITE MUST NOT FAIL THE READ — the caller already has the figures. It does mean the next
       * visit pays another two cents, which is why it is logged rather than swallowed silently: a table that
       * is unwritable turns this into the uncached design the file exists to avoid.
       */
      console.warn("[identity] cost snapshot could not be cached — the next read will re-query", {
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
}
