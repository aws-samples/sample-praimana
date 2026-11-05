/**
 * ── UPLOADING A RESOURCE'S PARTS STRAIGHT TO S3, FROM THE BROWSER ──────────────────────────────
 *
 * The middle step of the three-step upload. The Workshop service admits the file and mints one
 * presigned PUT per part; this pushes the bytes; the service then assembles them.
 *
 * ⚠ THE BYTES CANNOT TRAVEL THROUGH OUR OWN STACK. A 100MB body fits through neither API Gateway
 * (10MB) nor Lambda (6MB) nor a Next.js route handler running on either. Direct-to-S3 is not an
 * optimisation here, it is the only shape that works at this size.
 *
 * ⚠ THE ETag OF EACH PART IS THE WHOLE REASON THIS CODE EXISTS IN THE BROWSER. S3 will only complete a
 * multipart upload if told each part's ETag, and only the uploader sees them. Reading that header
 * cross-origin requires the bucket to name it in `ExposedHeaders`, see the CORS rule on
 * ResourcesBucket. When that line is missing every part uploads with a 200 and the ETag reads back
 * `null`, so completion fails with two green requests and nothing to point at.
 */

/** A part's position and the ETag S3 returned for it. */
export type UploadedPart = { partNumber: number; etag: string };

export type UploadProgress = {
  /** Bytes confirmed uploaded, counting only parts that finished. */
  uploadedBytes: number;
  totalBytes: number;
  /** 0–100, for a progress bar. */
  percent: number;
};

/**
 * How many parts are in flight at once.
 *
 * ⚠ BOUNDED, NOT "ALL OF THEM". Firing ten 10MB PUTs simultaneously on venue wifi makes every one of
 * them slow and makes the first failure likely, and an unbounded fan-out is exactly what this
 * platform's standing constraints forbid. Three keeps the link busy while leaving a retry cheap.
 */
const MAX_CONCURRENT_PARTS = 3;

/** How many times one part is retried before the whole upload is abandoned. */
const PART_ATTEMPTS = 3;

export class ResourceUploadError extends Error {
  constructor(
    message: string,
    readonly partNumber?: number
  ) {
    super(message);
    this.name = "ResourceUploadError";
  }
}

/**
 * PUT every part of `file` to its presigned URL and return the ETags, in part order.
 *
 * @param signal Cancellation. An aborted upload leaves parts in S3, so the CALLER must still tell the
 *               service to abort the upload, see `abortUpload` in the resources router. The bucket's
 *               lifecycle rule is the backstop for when the tab simply closes.
 */
export async function uploadParts(args: {
  file: File;
  partUrls: string[];
  partSize: number;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<UploadedPart[]> {
  const { file, partUrls, partSize, onProgress, signal } = args;

  /**
   * ⚠ CHECKED RATHER THAN ASSUMED. If the service's part arithmetic and this slicing ever disagree, the
   * upload would complete with a truncated final part, a file that is silently short rather than
   * visibly broken. Better to refuse before uploading 100MB.
   */
  const expected = Math.max(1, Math.ceil(file.size / partSize));
  if (partUrls.length !== expected) {
    throw new ResourceUploadError(
      `Server offered ${partUrls.length} part slots for a file needing ${expected}. Upload refused rather than risk a truncated file.`
    );
  }

  const parts: (UploadedPart | undefined)[] = new Array(partUrls.length).fill(undefined);
  let uploadedBytes = 0;
  let next = 0;

  const report = () =>
    onProgress?.({
      uploadedBytes,
      totalBytes: file.size,
      percent: file.size === 0 ? 100 : Math.min(100, Math.round((uploadedBytes / file.size) * 100)),
    });

  async function worker(): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new ResourceUploadError("Upload cancelled");
      const index = next++;
      if (index >= partUrls.length) return;

      const start = index * partSize;
      const blob = file.slice(start, Math.min(start + partSize, file.size));
      const etag = await putPart(partUrls[index], blob, index + 1, signal);

      parts[index] = { partNumber: index + 1, etag };
      uploadedBytes += blob.size;
      report();
    }
  }

  report();
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_PARTS, partUrls.length) }, () => worker())
  );

  /** Every slot filled, or the completion would be given a hole it cannot assemble. */
  const complete = parts.filter((p): p is UploadedPart => !!p);
  if (complete.length !== partUrls.length) {
    throw new ResourceUploadError("Some parts did not upload");
  }
  return complete;
}

/** One part, with retries. Returns its ETag. */
async function putPart(
  url: string,
  blob: Blob,
  partNumber: number,
  signal?: AbortSignal
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new ResourceUploadError("Upload cancelled", partNumber);
    try {
      /**
       * ⚠ NO `Content-Type` HEADER. The presigned URL was signed by the service with a server-chosen
       * type; sending one here that differs from the signature makes S3 reject the PUT with an opaque
       * `SignatureDoesNotMatch`. The type is already correct on the object.
       */
      const res = await fetch(url, { method: "PUT", body: blob, signal });
      if (!res.ok) {
        throw new ResourceUploadError(
          `Part ${partNumber} was rejected by storage (${res.status})`,
          partNumber
        );
      }

      const etag = res.headers.get("ETag") ?? res.headers.get("etag");
      if (!etag) {
        /**
         * ⚠ THIS IS ALMOST ALWAYS THE BUCKET'S CORS RULE, NOT THE UPLOAD. The PUT succeeded, S3 has
         * the bytes, but the browser will not expose a cross-origin response header that the bucket
         * did not list in `ExposedHeaders`. Said plainly here because the symptom ("upload works then
         * fails at the end") points nowhere near the cause, and it is NOT retryable: every attempt
         * will succeed and every ETag will be null.
         */
        throw new ResourceUploadError(
          `Storage did not return an ETag for part ${partNumber}. The bucket's CORS rule must expose the ETag header.`,
          partNumber
        );
      }
      return etag;
    } catch (err) {
      lastError = err;
      // A cancellation and a missing ETag are both final; retrying either just wastes the link.
      if (signal?.aborted) throw err;
      if (err instanceof ResourceUploadError && err.message.includes("ETag")) throw err;
      if (attempt === PART_ATTEMPTS) break;
      // Linear backoff. A venue's wifi drops for seconds, not milliseconds.
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ResourceUploadError(`Part ${partNumber} failed`, partNumber);
}

/** Bytes as something a human reads. Used by the resources list and the upload progress line. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
