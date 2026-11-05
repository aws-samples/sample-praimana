// The platforms we publish an installer for. The desktop `git:sync` /
// electron-builder produces a macOS build (.dmg/.zip) and a Windows build
// (.exe/.zip); each lands under its own prefix in the shared artifact bucket.
export const PLATFORMS = ["macos", "windows"] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(v: string | undefined | null): v is Platform {
  return !!v && (PLATFORMS as readonly string[]).includes(v);
}

/** One published installer object, as the client needs to know about it. */
export interface InstallerObject {
  platform: Platform;
  /** Full S3 key, e.g. desktop/macos/Praimana-0.1.0.dmg */
  key: string;
  /** Bare filename the browser should save it as. */
  filename: string;
  size: number;
  lastModified: string;
}

/**
 * Read side of the installer store (DIP port). The routes depend on THIS, never
 * on the S3 SDK — the concrete S3InstallerStore is wired in app.ts and tests pass
 * an in-memory fake.
 *
 * The store is the artifacts bucket (praimana-artifacts<BucketNameSuffix>, passed in as
 * DESKTOP_BUCKET). Access is granted by that bucket's policy plus this Lambda's role.
 */
export interface InstallerStore {
  /**
   * The installer to serve for a platform: the newest object under that
   * platform's prefix, or null if none is published yet. "Newest" = most recent
   * LastModified, so re-publishing a build supersedes the old one without the
   * client needing to know the version string.
   */
  latest(platform: Platform): Promise<InstallerObject | null>;

  /**
   * A short-lived presigned GET URL for a specific key. The bucket is private
   * (all public access blocked), so the browser can't fetch the object directly
   * — it follows this URL, which embeds a time-boxed signature. We redirect (302)
   * the download request to it rather than streaming the bytes back through the
   * API, because Electron installers (100 MB+) far exceed the API Gateway/Lambda
   * response size limits.
   */
  presign(key: string, expiresInSeconds: number): Promise<string>;
}
