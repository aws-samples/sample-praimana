import type { ReadModel } from "@praimana/service-shared";
/**
 * Docs bounded context — domain types + interfaces.
 *
 * The Docs service owns the versioned `.md` document store: the actual content and
 * its full version history live in S3 (object versioning), and a tiny DynamoDB
 * table (`praimana-docs`) holds the "latest version" pointer per (teamId,
 * path) for fast listing. It owns NO other context's data (Single Responsibility):
 * it only reads the Team context's tables to (a) resolve teamId → workshopId for
 * the S3 key layout and (b) authorize membership — see TeamLookup / TeamMembers.
 *
 * S3 key layout: workshop/<workshopId>/team/<teamId>/<path>
 */

/** A file the desktop app synced (mirrors the git:sync payload shape). */
export interface IncomingDoc {
  path: string;
  content: string;
  lastCommitHash?: string;
  lastAuthor?: string;
}

/** The "latest version" pointer row stored in DynamoDB (PK teamId, SK path). */
export interface DocPointer {
  teamId: string;
  /** RANGE key — the file path within the team's repository. */
  path: string;
  workshopId: string;
  s3Key: string;
  versionId: string | null;
  lastCommitHash: string | null;
  lastAuthor: string | null;
  updatedAt: string;
}

/** One historical version of a stored object (from S3 ListObjectVersions). */
export interface DocVersion {
  versionId: string;
  lastModified: string;
  size: number;
  isLatest: boolean;
}

/**
 * S3-backed content store. Interface-first (DIP) so routes never touch the AWS
 * SDK directly; an in-memory fake substitutes in tests.
 */
export interface DocStore {
  /** Write content, returning the new S3 versionId (or null if versioning off). */
  put(key: string, content: string): Promise<string | null>;
  /** Fetch content at the latest version, or a specific versionId when given. */
  get(key: string, versionId?: string): Promise<string | null>;
  /** List every version of a key, newest-first. */
  listVersions(key: string): Promise<DocVersion[]>;

  /**
   * Hide the object at `key`, leaving every stored version intact.
   *
   * ── ⚠ A DELETE MARKER, NOT AN ERASURE, AND THE DISTINCTION IS THE WHOLE DESIGN ──
   *
   * The bucket has versioning ENABLED and NO lifecycle rule (verified live), so a `DeleteObject`
   * WITHOUT a versionId writes a delete marker and the content stays recoverable indefinitely. That is
   * exactly the semantic a workshop needs: a participant removes a file they uploaded by mistake, and
   * a teammate's work is never actually destroyed by a misplaced click during a live event.
   *
   * ⚠ THE ROLE IS GRANTED `s3:DeleteObject` AND DELIBERATELY NOT `s3:DeleteObjectVersion`. The second
   * one permanently destroys a named version, and no code path here needs it — so the service is
   * structurally incapable of erasing a team's file, not merely careful about it. Recovery is an
   * operator action against S3, which is the right place for something irreversible.
   */
  remove(key: string): Promise<void>;

  /**
   * A short-lived presigned PUT for a file the client uploads DIRECTLY to S3.
   *
   * ── WHY A PRESIGNED PUT AND NOT A PROXIED UPLOAD ──
   *
   * A 20MB file cannot travel through the request path at all: API Gateway caps a
   * payload at 10MB and Lambda's synchronous invoke caps at 6MB, and neither is
   * adjustable. Base64/JSON encoding inflates a binary body by ~33% on top of that.
   * So "upload through the API" is not a size limit we could raise — it is a
   * ceiling below the requirement.
   *
   * What the presign preserves is the part that matters: API Gateway remains the
   * ONLY endpoint the client talks to, it authorizes the caller against team
   * membership, and it decides the key, the content type and the size bound BEFORE
   * any bytes move. The client never receives an AWS credential — only a URL that
   * works for one key, one content-type and one size range, for a few minutes.
   *
   * `maxBytes` is signed into the policy, so S3 itself rejects an oversized body:
   * the limit is enforced by the storage layer rather than trusted from a header the
   * client could lie about.
   */
  presignPut(args: {
    key: string;
    contentType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload>;

  /** Read an object's size and content type without downloading it. */
  head(key: string): Promise<{ size: number; contentType: string | null; versionId: string | null } | null>;
}

/**
 * A presigned upload instruction. `fields` is present for a POST-policy form and
 * empty for a plain PUT; the client sends the body to `url` with `headers` applied.
 */
export interface PresignedUpload {
  url: string;
  headers: Record<string, string>;
  /** When the URL stops working, so a client can show something honest. */
  expiresAt: string;
}

/** Pointer read/write — the fast "what docs does this team have" index. */
export interface DocPointerRepository {
  listByTeam(teamId: string): Promise<DocPointer[]>;
  get(teamId: string, path: string): Promise<DocPointer | null>;
  put(pointer: DocPointer): Promise<DocPointer>;

  /**
   * Forget the pointer row, so the file leaves the team's list.
   *
   * ⚠ A HARD DELETE, NOT A TOMBSTONE, and that is a considered choice. A `deletedAt` column would keep
   * a record of what once existed — but S3 already keeps it, forever, with every version (see
   * `DocStore.remove`). A tombstone would duplicate that history in a second place AND oblige every
   * reader to remember a filter, including the evaluation service's release check, which reads this
   * list over HTTP to decide NO_ARTIFACTS. One forgotten filter there would let a released submission
   * claim a file the team had removed.
   */
  remove(teamId: string, path: string): Promise<void>;
}

/** Resolve a teamId to its workshopId (for the S3 key layout). */
export interface TeamLookup {
  workshopIdForTeam(teamId: string): Promise<string | null>;
}

/**
 * Minimal projection of a user this service needs — a display NAME for a document's author.
 *
 * ── WHY THIS EXISTS NOW AND DID NOT BEFORE ──
 *
 * `DocPointer.lastAuthor` stores whatever the writer supplied, and the upload route supplies the
 * caller's identity id: a Cognito `sub`. So an uploaded file listed its author as
 * `94c89498-90e1-7070-dd34-b71a17076f4c`, which is both useless to a reader and an internal
 * identifier that should not be on screen. This service was the only one of six with that need and
 * no read-model to answer it.
 *
 * `{id, name}` and nothing more: a document list needs a name, and every additional field copied
 * across a service boundary is another thing to keep in step for no reader's benefit.
 */
export interface UserView {
  id: string;
  name: string;
}
export type UsersReadModel = ReadModel<UserView, string>;
