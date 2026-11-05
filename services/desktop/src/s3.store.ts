import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  type InstallerStore,
  type InstallerObject,
  type Platform,
} from "./domain.js";

/**
 * S3-backed installer store. The ONLY file in the service that knows about the
 * S3 SDK; everything else depends on the InstallerStore interface (DIP).
 *
 * The bucket lives in the SHARED/build account; this Lambda runs in the app account
 * and reads it cross-account. Layout:
 *
 *   <bucket>/desktop/macos/*      ← macOS installers (.dmg / .zip)
 *   <bucket>/desktop/windows/*    ← Windows installers (.exe / .zip)
 *
 * Presigning a cross-account object works with plain SigV4 creds as long as the
 * bucket policy grants this account s3:GetObject on the prefix (it does) — the
 * presigned URL carries THIS role's signature, so the reader needs no creds.
 *
 * Both the bucket name and its owning (shared) account come ONLY from the environment
 * (platform-api.yaml sets them). There is no fallback name: S3 bucket names are global,
 * so a default could name a bucket another account owns. Every request, including the
 * presigned download, carries ExpectedBucketOwner, so S3 refuses it (403) if any other
 * account owns the bucket.
 */
export const DESKTOP_BUCKET_ENV = "DESKTOP_BUCKET";
export const DESKTOP_BUCKET_OWNER_ENV = "DESKTOP_BUCKET_OWNER";
const DEFAULT_PREFIX = "desktop/";
const ACCOUNT_ID = /^\d{12}$/;

/** Reads and validates the store's bucket settings; throws so a misconfigured function never starts. */
export function readDesktopBucketConfig(
  env: Record<string, string | undefined>
): { bucket: string; expectedOwner: string; prefix: string } {
  const bucket = env[DESKTOP_BUCKET_ENV]?.trim();
  if (!bucket) {
    throw new Error(`[desktop] ${DESKTOP_BUCKET_ENV} is not set; it must name the installer bucket.`);
  }
  const expectedOwner = env[DESKTOP_BUCKET_OWNER_ENV]?.trim() ?? "";
  if (!ACCOUNT_ID.test(expectedOwner)) {
    throw new Error(
      `[desktop] ${DESKTOP_BUCKET_OWNER_ENV} must be the 12-digit AWS account ID that owns the installer bucket.`
    );
  }
  return { bucket, expectedOwner, prefix: env.DESKTOP_PREFIX || DEFAULT_PREFIX };
}

export class S3InstallerStore implements InstallerStore {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly expectedOwner: string;
  private readonly prefix: string;
  constructor(env: Record<string, string | undefined> = process.env, s3?: S3Client) {
    ({
      bucket: this.bucket,
      expectedOwner: this.expectedOwner,
      prefix: this.prefix,
    } = readDesktopBucketConfig(env));
    this.s3 = s3 ?? new S3Client({ region: env.AWS_REGION || "us-east-1" });
  }

  private platformPrefix(platform: Platform): string {
    // e.g. "desktop/" + "macos" + "/" → "desktop/macos/"
    return `${this.prefix}${platform}/`;
  }

  async latest(platform: Platform): Promise<InstallerObject | null> {
    const platformPrefix = this.platformPrefix(platform);
    // Small object count per platform (a handful of builds); a single page is
    // plenty. If publishing ever produces >1000 we'd paginate, but installers
    // don't accumulate like that.
    const res = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        ExpectedBucketOwner: this.expectedOwner,
        Prefix: platformPrefix,
      })
    );

    const candidates = (res.Contents ?? []).filter(
      // Exclude the prefix "folder" placeholder and anything with no real key.
      (o) => o.Key && o.Key !== platformPrefix && !o.Key.endsWith("/")
    );
    if (candidates.length === 0) return null;

    // Newest by LastModified — re-publishing supersedes the previous build.
    candidates.sort(
      (a, b) =>
        (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0)
    );
    const top = candidates[0];
    const key = top.Key!;

    return {
      platform,
      key,
      filename: key.slice(key.lastIndexOf("/") + 1),
      size: top.Size ?? 0,
      lastModified: top.LastModified?.toISOString() ?? "",
    };
  }

  async presign(key: string, expiresInSeconds: number): Promise<string> {
    // ResponseContentDisposition=attachment so the browser downloads the file
    // (with its real name) instead of trying to render it inline.
    const filename = key.slice(key.lastIndexOf("/") + 1);
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        ExpectedBucketOwner: this.expectedOwner,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${filename}"`,
      }),
      { expiresIn: expiresInSeconds }
    );
  }
}
