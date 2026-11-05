/**
 * ── WHAT MAY BE UPLOADED AS A WORKSHOP RESOURCE, IN ONE PLACE ─────────────────────────────────
 *
 * Workshop resources are facilitator-supplied material for ONE experience — briefs, slide decks,
 * datasets, a recorded walkthrough. The owning facilitator writes them; every role that can read the
 * experience can read them. That is the opposite direction from `services/docs`, which holds a TEAM's
 * private documents and which a facilitator deliberately cannot reach at all (ROLES.md: ADMIN and
 * FACILITATOR can hold no team-membership row, so "they cannot read" team content). Two opposite
 * access models must not share one admission policy, which is why this file exists next to the
 * workshop's own authorization rather than reusing the docs service's.
 *
 * It lives apart from the routes so the presign path, the completion path and the tests all decide the
 * same way. The docs service states the reason and it holds here: "a second copy of 'which files are
 * allowed' is how one of them ends up permitting something the other refuses."
 *
 * ⚠ THE CEILING IS ENFORCED TWICE, ON PURPOSE, AND THE SECOND TIME IS THE ONE THAT COUNTS.
 * `admitResource` checks the size the CLIENT DECLARES, which is advice, not a fact — a presigned
 * multipart part URL does not constrain how many bytes the caller pushes through it, and S3 will not
 * total them up for us. So the declared size bounds how many part URLs we hand out, and the real
 * enforcement is a HeadObject AFTER completion: over the ceiling, the object is deleted and the upload
 * refused. Without that second check the limit would be decoration, which this codebase has already
 * shipped four times and should not ship again.
 */

/**
 * 100MB — the ceiling, chosen over 1GB and 5GB.
 *
 * Bytes, not MB, so nothing has to convert at a call site. Big enough for a slide deck, a PDF brief or
 * a short screen recording; small enough that one mistaken upload cannot run away with the bucket.
 */
export const MAX_RESOURCE_BYTES = 100 * 1024 * 1024;

/**
 * Multipart part size: 10MB.
 *
 * ⚠ ABOVE S3'S 5MB MINIMUM, which applies to every part except the last. A smaller part size would be
 * legal but would multiply the presigned URLs we mint and the round trips the browser makes; a larger
 * one costs more to retry when a venue's wifi drops a part. 10MB puts a 100MB file at ten parts.
 */
export const PART_SIZE_BYTES = 10 * 1024 * 1024;

/** The most parts any permitted upload can need. Derived, so the two constants cannot drift. */
export const MAX_PARTS = Math.ceil(MAX_RESOURCE_BYTES / PART_SIZE_BYTES);

/**
 * The permitted types, keyed by lower-cased extension.
 *
 * ⚠ AN ALLOWLIST, NOT A DENYLIST, and the choice was made explicitly. A denylist on an
 * upload path into storage that every role in the experience can read is a standing invitation: every
 * new dangerous type is a hole until someone remembers to add it. The docs service reached the same
 * conclusion for the same reason.
 *
 * ⚠ THE CONTENT TYPE IS SERVER-CHOSEN FROM THE EXTENSION, never taken from the client, and it is what
 * gets stored on the object. A client-supplied `Content-Type` is a request to have our storage serve
 * whatever it says — that is how an upload becomes stored XSS.
 *
 * ⚠ NO `svg`, AND NO `html`. Both were on the table; both are script-bearing documents that a browser
 * will execute in the origin that serves them. The docs service permits `html` because every read there
 * goes through a service that returns JSON and never a rendered page — a property of THAT read path,
 * not of the file. Resources are downloaded by participants, so the safe move is to not hold the type
 * at all rather than to rely on a download header staying correct forever.
 */
export const ALLOWED_RESOURCE_TYPES: Record<string, string> = {
  // Documents
  pdf: "application/pdf",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  // Media — the reason the ceiling is 100MB rather than 20MB
  mp4: "video/mp4",
  mov: "video/quicktime",
  // Archives. A zip is opaque to us; it is permitted because a facilitator handing out a starter
  // project has no other shape, and it is inert until a human extracts it.
  zip: "application/zip",
};

/** The permitted extensions, for error messages and for the portal's file picker. */
export const ALLOWED_RESOURCE_EXTENSIONS = Object.keys(ALLOWED_RESOURCE_TYPES);

/**
 * The longest display name we will store.
 *
 * S3 allows a 1,024-byte key and the prefix below consumes part of it, but the real reason for a cap
 * is the portal's list: a 900-character filename is not a name, it is a denial-of-service against the
 * reader's eyes. Long enough for any real document title.
 */
export const MAX_FILENAME_LENGTH = 180;

export type ResourceRejection = { ok: false; reason: string };
export type ResourceAdmission = {
  ok: true;
  /** The sanitised display name. Stored as object metadata and shown in the portal. */
  filename: string;
  extension: string;
  /** Server-chosen, from the extension. Never the client's. */
  contentType: string;
  /** How many multipart parts this size needs. */
  partCount: number;
};

/**
 * ── ⚠ FILENAME SAFETY: THIS BECOMES PART OF AN S3 KEY ─────────────────────────────────────────
 *
 * The caller supplies a name and it is concatenated into a key. The docs service documents precisely
 * what goes wrong without this check and it applies verbatim here: a name of `../../workshops/<other>/…`
 * would write into ANOTHER EXPERIENCE's prefix — "an authorization bypass through string
 * concatenation, past a membership guard that checked the right thing about the wrong team."
 *
 * ⚠ THE NAME IS REDUCED TO A BARE FILENAME RATHER THAN VALIDATED AS A PATH. Resources are a flat list
 * per experience, not a tree, so there is no legitimate reason for a separator to survive. Taking the
 * last segment is both simpler and stricter than trying to decide which traversal sequences are safe —
 * there is no clever `..` that outlives "keep only the part after the final slash".
 *
 * Rejected rather than silently repaired when the result is empty or still unsafe: a facilitator who
 * sees their upload refused with a reason can rename the file, whereas one whose name was quietly
 * rewritten cannot tell why the resource is called something else.
 */
export function safeFilename(raw: unknown): ResourceRejection | { ok: true; filename: string } {
  if (typeof raw !== "string") return { ok: false, reason: "filename must be a string" };

  // Strip any directory component, including Windows separators — a deck dragged from a Windows
  // machine arrives as `C:\Users\…\brief.pdf` and the backslash is not a separator to S3.
  const base = raw.split(/[/\\]/).pop() ?? "";

  const trimmed = base.trim();
  if (!trimmed) return { ok: false, reason: "filename is empty" };

  /**
   * ⚠ `.` AND `..` ARE REJECTED EXPLICITLY. They survive the split above (they are legitimate final
   * segments) and neither is a filename. Without this, `..` would produce a key ending in a traversal
   * token that some S3 clients and every local extractor then interpret.
   */
  if (trimmed === "." || trimmed === "..") {
    return { ok: false, reason: "filename is not a usable name" };
  }

  /**
   * ⚠ CONTROL CHARACTERS AND NEWLINES OUT. A newline in a name breaks the metadata header it is
   * stored in (HTTP header injection into the S3 request), and the rest are invisible in a UI — a
   * resource whose name contains a zero-width or control character cannot be told apart from another.
   */
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, reason: "filename contains control characters" };
  }

  if (trimmed.length > MAX_FILENAME_LENGTH) {
    return { ok: false, reason: `filename is longer than ${MAX_FILENAME_LENGTH} characters` };
  }

  return { ok: true, filename: trimmed };
}

/** The extension, lower-cased, without the dot. Empty string when there is none. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  // `<= 0` also covers a dotfile like `.env`, which has no extension — it IS the name.
  if (dot <= 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * The whole admission decision for starting an upload: name safety, extension allowlist, declared size.
 *
 * `declaredBytes` is what the browser says the file is. See the header: it bounds how many part URLs
 * we mint, and `exceedsCeiling` is what actually enforces the limit once the bytes have landed.
 */
export function admitResource(args: {
  filename: unknown;
  declaredBytes: unknown;
}): ResourceRejection | ResourceAdmission {
  const name = safeFilename(args.filename);
  if (!name.ok) return name;

  const extension = extensionOf(name.filename);
  if (!extension) {
    return { ok: false, reason: "file has no extension, so its type cannot be determined" };
  }
  const contentType = ALLOWED_RESOURCE_TYPES[extension];
  if (!contentType) {
    return {
      ok: false,
      reason: `files of type .${extension} are not permitted; allowed: ${ALLOWED_RESOURCE_EXTENSIONS.join(", ")}`,
    };
  }

  const bytes = args.declaredBytes;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || !Number.isInteger(bytes) || bytes < 0) {
    return { ok: false, reason: "size must be a whole number of bytes" };
  }
  /**
   * ⚠ ZERO IS REFUSED. An empty file is almost always a failed export or a drag that picked up a
   * folder, and a zero-byte multipart upload has no parts at all — S3 rejects the completion, so the
   * facilitator would get an opaque failure at the end instead of a clear one at the start.
   */
  if (bytes === 0) return { ok: false, reason: "file is empty" };
  if (bytes > MAX_RESOURCE_BYTES) {
    return {
      ok: false,
      reason: `file is larger than the ${Math.floor(MAX_RESOURCE_BYTES / (1024 * 1024))}MB limit`,
    };
  }

  return {
    ok: true,
    filename: name.filename,
    extension,
    contentType,
    partCount: Math.max(1, Math.ceil(bytes / PART_SIZE_BYTES)),
  };
}

/**
 * The real ceiling check, applied to the size S3 reports after the object exists.
 *
 * Separate from `admitResource` because it answers a different question with a trustworthy input: not
 * "how big does the client claim this is" but "how big is it". See the file header for why the
 * declared size cannot be the enforcement point.
 */
export function exceedsCeiling(actualBytes: number): boolean {
  return actualBytes > MAX_RESOURCE_BYTES;
}

/**
 * ── THE KEY LAYOUT ────────────────────────────────────────────────────────────────────────────
 *
 *     workshops/<workshopId>/resources/<resourceId>/<filename>
 *
 * ⚠ THE `resourceId` SEGMENT IS WHAT MAKES DELETE SAFE AND UPLOADS NON-COLLIDING. Two uploads of
 * `brief.pdf` are two resources, not one overwriting the other — a facilitator replacing a file
 * expects the old one to still be there until they remove it. More importantly, DELETE names a
 * resourceId rather than a filename, so it cannot be steered by a crafted name into removing a
 * different object.
 *
 * ⚠ THE WORKSHOP ID IS PLACED BY US, NEVER BY THE CALLER, and the filename is the sanitised one from
 * `safeFilename`. Those two facts together are what keep one experience's prefix out of another's.
 */
export function resourceKey(args: {
  workshopId: string;
  resourceId: string;
  filename: string;
}): string {
  return `workshops/${args.workshopId}/resources/${args.resourceId}/${args.filename}`;
}

/** The prefix every resource of one experience sits under. Used by the list and by nothing else. */
export function resourcePrefix(workshopId: string): string {
  return `workshops/${workshopId}/resources/`;
}

/**
 * Pull the resourceId and filename back out of a key produced by `resourceKey`.
 *
 * Returns null for anything that does not match the layout, so a stray object under the prefix — a
 * leftover from an older scheme, or something written by hand — is omitted from the list rather than
 * rendered with a nonsense name or crashing the page.
 */
export function parseResourceKey(
  key: string,
  workshopId: string
): { resourceId: string; filename: string } | null {
  const prefix = resourcePrefix(workshopId);
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const resourceId = rest.slice(0, slash);
  const filename = rest.slice(slash + 1);
  // A filename containing a further slash means the key was not built by `resourceKey`.
  if (!filename || filename.includes("/")) return null;
  return { resourceId, filename };
}
