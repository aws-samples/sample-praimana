import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { DocStore, DocVersion, PresignedUpload } from "./domain.js";

/**
 * S3-backed document store. This is the ONLY file in the service that knows about
 * the S3 SDK; everything else depends on the DocStore interface (DIP). Content and
 * its full history live here (bucket versioning enabled) — DynamoDB only holds the
 * latest-version pointer.
 *
 * Reachable from the VPC-only Docs Lambda through the S3 *gateway* VPC endpoint (no
 * NAT), so all traffic stays on the AWS network.
 *
 * Both the bucket name and its owning account come ONLY from the environment
 * (platform-api.yaml sets them). There is no fallback name: S3 bucket names are global,
 * so a default could name a bucket another account owns. Every request also carries
 * ExpectedBucketOwner, so S3 refuses it (403) if any other account owns the bucket.
 */
export const DOCS_BUCKET_ENV = "DOCS_BUCKET";
export const DOCS_BUCKET_OWNER_ENV = "DOCS_BUCKET_OWNER";
const ACCOUNT_ID = /^\d{12}$/;

/** Reads and validates the store's bucket settings; throws so a misconfigured function never starts. */
export function readDocsBucketConfig(
  env: Record<string, string | undefined>
): { bucket: string; expectedOwner: string } {
  const bucket = env[DOCS_BUCKET_ENV]?.trim();
  if (!bucket) {
    throw new Error(`[docs] ${DOCS_BUCKET_ENV} is not set; it must name the docs bucket.`);
  }
  const expectedOwner = env[DOCS_BUCKET_OWNER_ENV]?.trim() ?? "";
  if (!ACCOUNT_ID.test(expectedOwner)) {
    throw new Error(
      `[docs] ${DOCS_BUCKET_OWNER_ENV} must be the 12-digit AWS account ID that owns the docs bucket.`
    );
  }
  return { bucket, expectedOwner };
}

export class S3DocStore implements DocStore {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly expectedOwner: string;
  constructor(env: Record<string, string | undefined> = process.env, s3?: S3Client) {
    ({ bucket: this.bucket, expectedOwner: this.expectedOwner } = readDocsBucketConfig(env));
    this.s3 = s3 ?? new S3Client({ region: env.AWS_REGION || "us-east-1" });
  }

  /** Bucket + owner condition, spread into every S3 command this store sends or presigns. */
  private target(): { Bucket: string; ExpectedBucketOwner: string } {
    return { Bucket: this.bucket, ExpectedBucketOwner: this.expectedOwner };
  }

  /**
   * ⚠ NO `VersionId` ON THIS CALL, AND THAT IS THE POINT. Omitting it writes a DELETE MARKER on a
   * versioned bucket: the object disappears from a plain GET/LIST and every stored version survives.
   * Passing a versionId would permanently destroy that version — which is why the role is not granted
   * `s3:DeleteObjectVersion` and this signature takes no version to pass.
   */
  async remove(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ ...this.target(), Key: key }));
  }

  async put(key: string, content: string): Promise<string | null> {
    const res = await this.s3.send(
      new PutObjectCommand({
        ...this.target(),
        Key: key,
        Body: content,
        ContentType: "text/markdown; charset=utf-8",
      })
    );
    return res.VersionId ?? null;
  }

  async get(key: string, versionId?: string): Promise<string | null> {
    try {
      const res = await this.s3.send(
        new GetObjectCommand({
          ...this.target(),
          Key: key,
          VersionId: versionId,
        })
      );
      // Body is a stream in the Node runtime; transformToString is provided by the
      // SDK's stream mixin.
      return (await res.Body?.transformToString()) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Presign a single-object PUT.
   *
   * `ContentLength` is part of the signed request, so S3 rejects a body of any other
   * size — the 20MB ceiling is enforced by the storage layer, not merely checked
   * here. Same for `ContentType`: the client cannot store a `.pdf` key as
   * `text/html` by sending a different header, because the signature covers it.
   *
   * The presigner needs no network call, so this works from the VPC-only Lambda
   * without touching the S3 gateway endpoint — it is a local signing operation over
   * the function's own credentials.
   */
  async presignPut(args: {
    key: string;
    contentType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload> {
    const url = await getSignedUrl(
      this.s3,
      new PutObjectCommand({
        ...this.target(),
        Key: args.key,
        ContentType: args.contentType,
        ContentLength: args.maxBytes,
      }),
      { expiresIn: args.expiresInSeconds }
    );

    return {
      url,
      // The client MUST send exactly these, or the signature will not match.
      headers: {
        "Content-Type": args.contentType,
        "Content-Length": String(args.maxBytes),
      },
      expiresAt: new Date(Date.now() + args.expiresInSeconds * 1000).toISOString(),
    };
  }

  async head(
    key: string
  ): Promise<{ size: number; contentType: string | null; versionId: string | null } | null> {
    try {
      const res = await this.s3.send(
        new HeadObjectCommand({ ...this.target(), Key: key })
      );
      return {
        size: res.ContentLength ?? 0,
        contentType: res.ContentType ?? null,
        versionId: res.VersionId ?? null,
      };
    } catch {
      // Absent (or unreadable) — the caller treats both as "not uploaded yet".
      return null;
    }
  }

  async listVersions(key: string): Promise<DocVersion[]> {
    const res = await this.s3.send(
      new ListObjectVersionsCommand({ ...this.target(), Prefix: key })
    );
    // Prefix match can return sibling keys; keep only exact-key versions, newest
    // first (S3 already returns them newest-first within a key).
    return (res.Versions ?? [])
      .filter((v) => v.Key === key)
      .map((v) => ({
        versionId: v.VersionId ?? "null",
        lastModified: v.LastModified?.toISOString() ?? "",
        size: v.Size ?? 0,
        isLatest: !!v.IsLatest,
      }));
  }
}
