import { describe, expect, it, vi } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import {
  DOCS_BUCKET_ENV,
  DOCS_BUCKET_OWNER_ENV,
  S3DocStore,
  readDocsBucketConfig,
} from "./s3.store.js";

const BUCKET = "docs-bucket-under-test";
const OWNER = "123456789012";
const ENV = { [DOCS_BUCKET_ENV]: BUCKET, [DOCS_BUCKET_OWNER_ENV]: OWNER };

/** A real client (presigning is local signing) whose send() never reaches the network. */
function fakeClient(): { client: S3Client; send: ReturnType<typeof vi.fn> } {
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" },
  });
  const send = vi.fn().mockResolvedValue({});
  (client as unknown as { send: typeof send }).send = send;
  return { client, send };
}

describe("readDocsBucketConfig: no fallback bucket name", () => {
  it("returns the configured bucket and owner", () => {
    expect(readDocsBucketConfig(ENV)).toEqual({ bucket: BUCKET, expectedOwner: OWNER });
  });

  it.each([undefined, "", "   "])("throws when DOCS_BUCKET is %j", (value) => {
    expect(() => readDocsBucketConfig({ ...ENV, [DOCS_BUCKET_ENV]: value })).toThrow(
      /DOCS_BUCKET is not set/
    );
  });

  it.each([undefined, "", "12345", "1234567890123", "12345678901a"])(
    "throws when DOCS_BUCKET_OWNER is %j",
    (value) => {
      expect(() => readDocsBucketConfig({ ...ENV, [DOCS_BUCKET_OWNER_ENV]: value })).toThrow(
        /DOCS_BUCKET_OWNER must be the 12-digit/
      );
    }
  );

  it("the store refuses to construct without a bucket, so the function cannot start", () => {
    expect(() => new S3DocStore({ [DOCS_BUCKET_OWNER_ENV]: OWNER }, fakeClient().client)).toThrow(
      /DOCS_BUCKET is not set/
    );
  });
});

describe("S3DocStore: every request carries ExpectedBucketOwner", () => {
  it("sends Bucket and ExpectedBucketOwner on every SDK call", async () => {
    const { client, send } = fakeClient();
    const store = new S3DocStore(ENV, client);

    await store.put("k", "body");
    await store.get("k", "v1");
    await store.head("k");
    await store.remove("k");
    await store.listVersions("k");

    expect(send).toHaveBeenCalledTimes(5);
    for (const [command] of send.mock.calls) {
      expect(command.input).toMatchObject({ Bucket: BUCKET, ExpectedBucketOwner: OWNER });
    }
  });

  it("puts the owner condition in the presigned upload URL's query, not a header the client must send", async () => {
    const { client } = fakeClient();
    const store = new S3DocStore(ENV, client);

    const upload = await store.presignPut({
      key: "k",
      contentType: "application/pdf",
      maxBytes: 10,
      expiresInSeconds: 60,
    });

    const url = new URL(upload.url);
    expect(url.searchParams.get("x-amz-expected-bucket-owner")).toBe(OWNER);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).not.toMatch(/x-amz-expected-bucket-owner/);
    expect(Object.keys(upload.headers)).toEqual(["Content-Type", "Content-Length"]);
  });
});
