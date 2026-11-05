/**
 * Dependency Inversion (the "D" in SOLID) — the single most important seam in
 * this decomposition.
 *
 * Routes and domain logic depend on these narrow interfaces, NOT on `db.send(...)`
 * with a concrete table name. Two payoffs:
 *
 *   1. Testability — an in-memory implementation substitutes cleanly (Liskov).
 *   2. Extraction — when a bounded context that today reads another context's
 *      table becomes its own service, you swap the implementation from a
 *      DynamoDB call to an HTTP/event call. Callers don't change. This is what
 *      turns a painful rewrite into a one-file swap.
 *
 * Interfaces are deliberately narrow (Interface Segregation): a `UserRepository`
 * exposes only user operations, not a god-DAO over every table.
 */

/** Base read/write shape shared by aggregate repositories. */
export interface Repository<T, K> {
  get(key: K): Promise<T | null>;
  put(item: T): Promise<T>;
}

/** A repository that can list children of a parent key (e.g. messages of a thread). */
export interface CollectionRepository<T, ParentKey> {
  listBy(parent: ParentKey): Promise<T[]>;
}

/**
 * Read-model repository. Populated by consuming another service's events rather
 * than by reading its tables. This is how a service gets the data it needs about
 * another context WITHOUT a cross-service table read (the distributed-monolith
 * anti-pattern). E.g. the AI service keeps a tiny users read-model so it can show
 * author names without calling the Identity service on the hot path.
 */
export interface ReadModel<T, K> {
  get(key: K): Promise<T | null>;
  upsert(item: T): Promise<void>;
  delete(key: K): Promise<void>;
}
