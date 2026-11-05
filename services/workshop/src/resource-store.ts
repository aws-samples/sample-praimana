/**
 * ── WORKSHOP RESOURCE STORAGE ─────────────────────────────────────────────────────────────────
 *
 * The S3 half of workshop resources, behind an interface so the routes depend on the OPERATIONS and
 * not on the SDK — the same dependency inversion `services/docs` uses, and the reason its routes are
 * testable without a bucket.
 *
 * ⚠ S3 IS THE SOURCE OF TRUTH HERE. THERE IS NO METADATA TABLE, AND THAT IS A DECISION.
 *
 * The docs service keeps DynamoDB pointers because it needs per-team listing, version history and a
 * `lastAuthor` it can join to a user. Resources need none of that: a flat list per experience, no
 * history, a handful of files. Adding a table would buy nothing and would introduce the one failure a
 * single store cannot have — DRIFT. With a table, "upload" is two writes and "delete" is two deletes,
 * either of which can half-fail: a row with no object is a resource that 404s on download, and an
 * object with no row is a file nobody can see and nobody can remove. Listing the prefix means the list
 * is, by construction, exactly what exists.
 *
 * What is lost: the display name and uploader cannot be queried, only read. Both are stored as S3
 * object metadata and returned by LIST's companion HEAD, which is sufficient for a list of tens.
 *
 * ⚠ AN ABANDONED MULTIPART UPLOAD IS INVISIBLE AND BILLED. Parts that were uploaded but never completed
 * do not appear in LIST and do not appear in the console's object view, yet they occupy storage for
 * ever. A browser tab closed mid-upload leaves exactly that. The bucket therefore carries an
 * `AbortIncompleteMultipartUpload` lifecycle rule, and `abort` below is called on the error path — the
 * lifecycle rule is the backstop for the case where the client never gets to tell us.
 */
import {
  S3Client,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  UploadPartCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * How long a presigned URL stays valid.
 *
 * ⚠ TWO DIFFERENT ANSWERS, BECAUSE THEY CARRY DIFFERENT RISK. An upload URL grants a write to ONE key
 * and expires long before a captured one is useful; a download URL grants a READ of material every role
 * in the experience may see anyway. The docs service's reasoning for its 300s upload window applies
 * verbatim — "long enough for 20MB on a workshop-venue connection, short enough that a URL captured
 * from a log or a shoulder-surfed screen is useless by the time anyone tries it" — scaled here for a
 * 100MB ceiling, since a part can be retried but an expired URL cannot.
 */
const UPLOAD_URL_TTL_SECONDS = 900;
const DOWNLOAD_URL_TTL_SECONDS = 300;

/** One stored resource, as the list and the portal see it. */
export interface StoredResource {
  resourceId: string;
  filename: string;
  bytes: number;
  contentType: string;
  uploadedAt: string;
  /** The user id that uploaded it. Resolved to a display name by the route, not here. */
  uploadedBy: string;
}

export interface ResourceStore {
  beginUpload(args: {
    key: string;
    contentType: string;
    filename: string;
    uploadedBy: string;
    uploadedByEmail?: string;
  }): Promise<string>;
  presignParts(args: { key: string; uploadId: string; partCount: number }): Promise<string[]>;
  completeUpload(args: {
    key: string;
    uploadId: string;
    parts: { partNumber: number; etag: string }[];
  }): Promise<void>;
  abortUpload(args: { key: string; uploadId: string }): Promise<void>;
  sizeOf(key: string): Promise<number | null>;
  list(prefix: string): Promise<{ key: string; bytes: number; lastModified?: Date }[]>;
  describe(
    key: string
  ): Promise<{
    contentType: string;
    filename: string;
    uploadedBy: string;
    uploadedByEmail: string;
  } | null>;
  remove(key: string): Promise<void>;
  presignDownload(args: { key: string; filename: string }): Promise<string>;
}

/**
 * ⚠ METADATA KEYS ARE LOWER-CASE AND PREFIX-FREE HERE. S3 returns user metadata with the
 * `x-amz-meta-` prefix stripped and the names lower-cased, so reading back `Filename` gives `filename`.
 * Writing one case and reading another is how a name comes back undefined.
 */
const META_FILENAME = "filename";
const META_UPLOADED_BY = "uploadedby";
/**
 * ⚠ THE EMAIL FROM THE VERIFIED CLAIMS, NOT A NAME THE CLIENT SENT. The gateway's JWT authorizer puts
 * `email` in the claims and `requireIdentity` surfaces it, so this is an identity the SERVICE vouched
 * for. There is no name claim to use and no cheap way to resolve a sub to a display name: the only
 * lookup is `GET /v1/admin/users`, which is admin-gated, and the uploader is a FACILITATOR who by
 * platform rule holds no team-membership row — so the experience's own people list can never contain
 * them either. Stored at upload rather than resolved at read, which also means it keeps working if the
 * account is later renamed or removed.
 */
const META_UPLOADED_BY_EMAIL = "uploadedbyemail";

export class S3ResourceStore implements ResourceStore {
  constructor(
    private readonly s3 = new S3Client({}),
    private readonly bucket = process.env.RESOURCES_BUCKET || ""
  ) {}

  async beginUpload(args: {
    key: string;
    contentType: string;
    filename: string;
    uploadedBy: string;
    uploadedByEmail?: string;
  }): Promise<string> {
    const out = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: args.key,
        /**
         * Server-chosen from the extension — see resource-policy.ts. Set at CREATE because a multipart
         * upload's content type is fixed when it begins; it cannot be supplied at completion.
         */
        ContentType: args.contentType,
        /**
         * ⚠ THE DISPLAY NAME IS STORED AS METADATA, NOT INFERRED FROM THE KEY, even though the key ends
         * with it. The key is the sanitised name; keeping the name explicitly is what lets the list show
         * it without parsing, and what keeps a later change to the key layout from renaming every
         * existing resource.
         *
         * ⚠ NON-ASCII IS ENCODED. S3 metadata travels in HTTP headers, which are ASCII; an unencoded
         * `résumé.pdf` either fails the request or comes back mangled.
         */
        Metadata: {
          [META_FILENAME]: encodeURIComponent(args.filename),
          [META_UPLOADED_BY]: args.uploadedBy,
          /* Omitted entirely when the claim was absent — an empty metadata value is still a value. */
          ...(args.uploadedByEmail
            ? { [META_UPLOADED_BY_EMAIL]: encodeURIComponent(args.uploadedByEmail) }
            : {}),
        },
      })
    );
    if (!out.UploadId) throw new Error("S3 did not return an upload id");
    return out.UploadId;
  }

  /**
   * One presigned PUT per part.
   *
   * ⚠ THE BROWSER UPLOADS DIRECTLY TO S3 AND THAT IS THE POINT. Routing 100MB through the service would
   * put it through API Gateway and Lambda, whose request payload ceilings are several orders of
   * magnitude smaller (10MB and 6MB) — the feature is impossible that way, not merely slower.
   */
  async presignParts(args: { key: string; uploadId: string; partCount: number }): Promise<string[]> {
    const urls: string[] = [];
    for (let partNumber = 1; partNumber <= args.partCount; partNumber++) {
      urls.push(
        await getSignedUrl(
          this.s3,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: args.key,
            UploadId: args.uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn: UPLOAD_URL_TTL_SECONDS }
        )
      );
    }
    return urls;
  }

  async completeUpload(args: {
    key: string;
    uploadId: string;
    parts: { partNumber: number; etag: string }[];
  }): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: args.key,
        UploadId: args.uploadId,
        MultipartUpload: {
          /**
           * ⚠ SORTED BY PART NUMBER. S3 requires ascending order and answers `InvalidPartOrder`
           * otherwise. The browser finishes parts in whatever order the network allows, so the order
           * they arrive in is not the order they must be declared in.
           */
          Parts: [...args.parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      })
    );
  }

  /** Best-effort: an abort that itself fails leaves the lifecycle rule to collect the parts. */
  async abortUpload(args: { key: string; uploadId: string }): Promise<void> {
    await this.s3.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: args.key,
        UploadId: args.uploadId,
      })
    );
  }

  /** The size S3 reports. `null` when the object is not there. */
  async sizeOf(key: string): Promise<number | null> {
    try {
      const out = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return out.ContentLength ?? null;
    } catch {
      return null;
    }
  }

  async describe(key: string): Promise<{
    contentType: string;
    filename: string;
    uploadedBy: string;
    uploadedByEmail: string;
  } | null> {
    try {
      const out = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        contentType: out.ContentType || "application/octet-stream",
        filename: decodeMeta(out.Metadata?.[META_FILENAME]),
        uploadedBy: out.Metadata?.[META_UPLOADED_BY] || "",
        uploadedByEmail: decodeMeta(out.Metadata?.[META_UPLOADED_BY_EMAIL]),
      };
    } catch {
      return null;
    }
  }

  /**
   * Every object under one experience's prefix.
   *
   * ⚠ PAGINATED. `ListObjectsV2` returns at most 1,000 keys and signals more with
   * `IsTruncated`; a single call looks correct right up to the experience that has 1,001 resources.
   */
  async list(prefix: string): Promise<{ key: string; bytes: number; lastModified?: Date }[]> {
    const found: { key: string; bytes: number; lastModified?: Date }[] = [];
    let token: string | undefined;
    do {
      const out = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        })
      );
      for (const o of out.Contents ?? []) {
        if (!o.Key) continue;
        found.push({ key: o.Key, bytes: o.Size ?? 0, lastModified: o.LastModified });
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return found;
  }

  async remove(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * A short-lived read URL.
   *
   * ⚠ `attachment`, ALWAYS. This is what makes the media and archive types safe to hold: the browser is
   * told to save the file rather than render it in our origin. It is also why the policy refuses `svg`
   * and `html` even so — a download header is one header away from being wrong, and a type that cannot
   * execute needs no header to be safe.
   *
   * ⚠ THE FILENAME IS RE-ENCODED, NOT INTERPOLATED RAW. The value lands in a `Content-Disposition`
   * header; a quote or newline in it would terminate the header early. `filename*=UTF-8''…` is the
   * RFC 5987 form, which is both the escaping and the only way to express a non-ASCII name.
   */
  async presignDownload(args: { key: string; filename: string }): Promise<string> {
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: args.key,
        ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(args.filename)}`,
      }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS }
    );
  }
}

/** Metadata is stored percent-encoded; a value written before that was true must still read back. */
function decodeMeta(raw: string | undefined): string {
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
