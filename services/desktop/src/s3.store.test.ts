import { describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import {
  DESKTOP_BUCKET_ENV,
  DESKTOP_BUCKET_OWNER_ENV,
  S3InstallerStore,
  readDesktopBucketConfig,
} from "./s3.store.js";

const BUCKET = "installer-bucket-under-test";
const OWNER = "123456789012";
const ENV = { [DESKTOP_BUCKET_ENV]: BUCKET, [DESKTOP_BUCKET_OWNER_ENV]: OWNER };

/** A real client (presigning is local signing) whose send() never reaches the network. */
function fakeClient(response: unknown = {}): { client: S3Client; send: ReturnType<typeof vi.fn> } {
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" },
  });
  const send = vi.fn().mockResolvedValue(response);
  (client as unknown as { send: typeof send }).send = send;
  return { client, send };
}

describe("readDesktopBucketConfig: no fallback bucket name", () => {
  it("returns the configured bucket and owner, with the default prefix", () => {
    expect(readDesktopBucketConfig(ENV)).toEqual({
      bucket: BUCKET,
      expectedOwner: OWNER,
      prefix: "desktop/",
    });
  });

  it("honours DESKTOP_PREFIX", () => {
    expect(readDesktopBucketConfig({ ...ENV, DESKTOP_PREFIX: "builds/" }).prefix).toBe("builds/");
  });

  it.each([undefined, "", "   "])("throws when DESKTOP_BUCKET is %j", (value) => {
    expect(() => readDesktopBucketConfig({ ...ENV, [DESKTOP_BUCKET_ENV]: value })).toThrow(
      /DESKTOP_BUCKET is not set/
    );
  });

  it.each([undefined, "", "12345", "1234567890123", "12345678901a"])(
    "throws when DESKTOP_BUCKET_OWNER is %j",
    (value) => {
      expect(() =>
        readDesktopBucketConfig({ ...ENV, [DESKTOP_BUCKET_OWNER_ENV]: value })
      ).toThrow(/DESKTOP_BUCKET_OWNER must be the 12-digit/);
    }
  );

  it("the store refuses to construct without a bucket, so the function cannot start", () => {
    expect(
      () => new S3InstallerStore({ [DESKTOP_BUCKET_OWNER_ENV]: OWNER }, fakeClient().client)
    ).toThrow(/DESKTOP_BUCKET is not set/);
  });
});

describe("S3InstallerStore: every request carries ExpectedBucketOwner", () => {
  it("lists installers with Bucket and ExpectedBucketOwner", async () => {
    const lastModified = new Date("2026-01-01T00:00:00Z");
    const { client, send } = fakeClient({
      Contents: [{ Key: "desktop/macos/app.dmg", Size: 5, LastModified: lastModified }],
    });
    const store = new S3InstallerStore(ENV, client);

    const latest = await store.latest("macos");

    expect(latest?.key).toBe("desktop/macos/app.dmg");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: BUCKET,
      ExpectedBucketOwner: OWNER,
      Prefix: "desktop/macos/",
    });
  });

  it("puts the owner condition in the presigned download URL's query, so a browser GET carries it", async () => {
    const { client } = fakeClient();
    const store = new S3InstallerStore(ENV, client);

    const url = new URL(await store.presign("desktop/macos/app.dmg", 60));

    expect(url.hostname.startsWith(BUCKET)).toBe(true);
    expect(url.searchParams.get("x-amz-expected-bucket-owner")).toBe(OWNER);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });
});
