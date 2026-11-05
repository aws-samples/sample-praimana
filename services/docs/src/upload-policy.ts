/**
 * What may be uploaded to a team's document store, in ONE place.
 *
 * This is the whole of the upload admission policy: path safety, extension, content
 * type, and size. It lives apart from the routes so the ingest path, the presign path
 * and the tests all decide the same way — a second copy of "which files are allowed"
 * is how one of them ends up permitting something the other refuses.
 *
 * ⚠ TWO ENTRY POINTS, AND WHICH ONE A ROUTE CALLS IS A DECISION:
 *
 *   · `admitPath`   — path safety alone. EVERY writer must call it. The git-sync ingest
 *                     route called nothing at all, which is the gap this split closes.
 *   · `admitUpload` — path safety PLUS the extension allowlist and size ceiling. For the
 *                     presign routes, where a server-chosen content type is signed into
 *                     the URL.
 *
 * See `admitPath` for why ingest deliberately takes the narrower one.
 */

/** A 20MB ceiling. Bytes, not MB, so nothing has to convert. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * The permitted types, keyed by lower-cased extension.
 *
 * Deliberately an ALLOWLIST of four, not a denylist. A denylist on an upload path
 * into a bucket other team members can read is a standing invitation: every new
 * dangerous type is a hole until someone remembers to add it.
 *
 * The content type is SERVER-CHOSEN from the extension rather than taken from the
 * client, and it is signed into the presigned URL. That matters most for `html`: a
 * file stored as `text/html` and later served from a browsable origin is a stored-XSS
 * vector, so it is pinned to a charset and the bucket keeps public access blocked —
 * every read goes through this service, which returns JSON, never a rendered page.
 */
export const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
};

/** The four extensions, for error messages and tests. */
export const ALLOWED_EXTENSIONS = Object.keys(ALLOWED_UPLOAD_TYPES);

export type UploadRejection =
  | { ok: false; reason: string }
  | { ok: true; extension: string; contentType: string; path: string };

/** The path-safety half of the policy: either a normalised, safe path or a reason. */
export type PathAdmission = { ok: false; reason: string } | { ok: true; path: string };

/**
 * ── ⚠ PATH SAFETY, ON ITS OWN, SO *EVERY* WRITER CAN SHARE IT ───────────────────────────────────
 *
 * The caller supplies the path and it becomes an S3 key under the team's prefix. Without the
 * traversal check a path of `../../team/<other>/x.md` would write into ANOTHER TEAM's prefix — an
 * authorization bypass through string concatenation, past a membership guard that checked the right
 * thing about the wrong team.
 *
 * ⚠ WHY THIS IS SPLIT OUT OF `admitUpload` RATHER THAN SIMPLY BEING IT. The git-sync ingest route
 * called NEITHER, and the obvious fix — point it at `admitUpload`, like the two presign routes — would
 * have broken a working feature. `admitUpload` also enforces the four-extension allowlist, and
 * git-sync legitimately carries a team's REPOSITORY files: these pointer rows become the release
 * snapshot's artifact manifest that judges read (`evaluation` builds it from `GET /teams/:teamId/docs`),
 * and that manifest routinely contains `src/*.ts` and the like. Applying the allowlist there would
 * have silently stopped syncing every non-`.md` artifact a team produced.
 *
 * So the policy is split by what each writer actually needs:
 *
 *   · PATH SAFETY (this function) — traversal, separators, control bytes, length. Refuses nothing a
 *     legitimate client sends, so EVERY writer applies it, ingest included.
 *   · TYPE + SIZE (`admitUpload`) — the extension allowlist and the 20MB ceiling, which decide what
 *     may be PRESIGNED for direct upload, where a server-chosen content type is signed into the URL.
 *
 * The exploitable half of the ingest gap is entirely in the first bucket, which is why splitting
 * closes it without touching the artifact feature.
 */
export function admitPath(rawPath: unknown): PathAdmission {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { ok: false, reason: "path is required" };
  }

  // Strip leading slashes the way s3Key() does, so both agree on the same key.
  const path = rawPath.trim().replace(/^\/+/, "");

  if (!path) return { ok: false, reason: "path is required" };
  if (path.length > 1024) return { ok: false, reason: "path is too long" };

  // Reject traversal, absolute paths, backslashes (Windows-style separators that S3
  // treats as literal characters), and NUL/control bytes.
  if (path.includes("..")) return { ok: false, reason: "path must not contain '..'" };
  if (path.includes("\\")) return { ok: false, reason: "path must use forward slashes" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    return { ok: false, reason: "path contains control characters" };
  }
  if (path.split("/").some((seg) => seg === "." || seg === "")) {
    return { ok: false, reason: "path contains an empty or '.' segment" };
  }

  return { ok: true, path };
}

/**
 * Decide whether a path may be uploaded, and with what content type.
 *
 * PATH SAFETY IS PART OF THIS, not a separate concern — it is delegated to `admitPath` so the presign
 * path and the ingest path cannot drift on what a safe key looks like. This function adds the TYPE and
 * SIZE arms on top, which is the part only the presign path needs.
 */
export function admitUpload(rawPath: unknown, sizeBytes: unknown): UploadRejection {
  const safe = admitPath(rawPath);
  if (!safe.ok) return safe;
  const path = safe.path;

  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  const contentType = ALLOWED_UPLOAD_TYPES[extension];
  if (!contentType) {
    return {
      ok: false,
      reason: `unsupported file type${extension ? ` '.${extension}'` : ""} — allowed: ${ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(", ")}`,
    };
  }

  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, reason: "sizeBytes must be a positive number" };
  }
  if (!Number.isInteger(sizeBytes)) {
    return { ok: false, reason: "sizeBytes must be an integer" };
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: `file is too large: ${sizeBytes} bytes exceeds the ${MAX_UPLOAD_BYTES}-byte limit`,
    };
  }

  return { ok: true, extension, contentType, path };
}
