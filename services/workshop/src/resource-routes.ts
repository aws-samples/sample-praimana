/**
 * ── WORKSHOP RESOURCES: THE HTTP SURFACE ──────────────────────────────────────────────────────
 *
 * Facilitator-supplied material for ONE experience. The owning facilitator adds and removes; every role
 * that can read the experience can list and download. These are workshop-wide files, not team docs:
 * only the facilitator can add or delete, and every other role can read them.
 *
 * ⚠ THE TWO GATES ARE THE ONES THIS SERVICE ALREADY OWNS, NOT NEW ONES.
 *
 *   · READ  — `requireWorkshopRead`, unchanged. It already encodes the whole "who can see this
 *             experience" table: owner, entitled judge, team member, and an ADMIN only for an
 *             experience they created. Resources inherit that answer rather than restating it, so a
 *             resource can never be visible to someone who cannot see the experience holding it.
 *   · WRITE — `isWorkshopOwner`, the same check that guards renaming an experience or editing its
 *             phases. Its note is the reason it is right here too: ownership ALONE, because "a role
 *             that cannot READ another owner's experience must not be able to WRITE it". An ADMIN who
 *             created the experience is its owner and passes; an ADMIN who did not, does not.
 *
 * Writing a third rule for resources is how the three drift apart. There is no new authorization
 * concept in this file — only two existing ones applied.
 *
 * ⚠ THE BROWSER UPLOADS STRAIGHT TO S3. The service mints presigned part URLs and never sees the bytes.
 * That is not an optimisation: API Gateway caps a request at 10MB and Lambda at 6MB, so a 100MB
 * resource cannot travel through this service at all.
 *
 * ⚠ `501`, NOT A SILENT PASS, WHEN THE STORE IS NOT WIRED. `deps.resources` is optional for exactly the
 * reason `deps.userRoles` is — a deployment that has not been given a bucket should say so loudly. The
 * polarity matters: absent means REFUSE, so no environment can appear to accept uploads it is quietly
 * dropping.
 */
import type { Context, Hono } from "hono";
import { requireIdentity } from "@praimana/service-shared";
import { ulid } from "ulid";
import {
  requireWorkshopRead,
  type WorkshopMembership,
  type WorkshopEntitlements,
} from "./authz.js";
import type { Workshop } from "./domain.js";
import {
  admitResource,
  exceedsCeiling,
  parseResourceKey,
  resourceKey,
  resourcePrefix,
  PART_SIZE_BYTES,
  MAX_RESOURCE_BYTES,
  ALLOWED_RESOURCE_EXTENSIONS,
} from "./resource-policy.js";
import type { ResourceStore } from "./resource-store.js";

/** Only what these routes need from the workshop service's dependency bag. */
export interface ResourceRouteDeps {
  workshops: { getById(id: string): Promise<Workshop | null> };
  membership: WorkshopMembership;
  entitlements: WorkshopEntitlements;
  resources?: ResourceStore;
}

/**
 * The write gate. A deliberate reference to the SAME rule `routes.ts` applies, re-stated in one line
 * rather than imported because that module keeps it private — see the module header for why it is
 * ownership alone. If that rule changes, both must change, and `resource-routes.test.ts` asserts the
 * table so a divergence fails rather than merely existing.
 */
function isWorkshopOwner(workshop: Workshop, identity: { id: string }): boolean {
  return !!workshop.ownerId && workshop.ownerId === identity.id;
}

export function registerResourceRoutes(app: Hono, deps: ResourceRouteDeps): void {
  /**
   * Load the experience and settle read access in one place.
   *
   * Returns either a refusal Response or the row. Every route below starts here, which is what stops a
   * later addition from forgetting the gate — the only way to get the workshop is to pass through it.
   */
  async function readable(c: Context) {
    /** Absent means the path did not match, which is indistinguishable from a missing experience. */
    const id = c.req.param("id");
    const workshop = id ? await deps.workshops.getById(id) : null;
    if (!workshop) return { denied: c.json({ error: "Workshop not found" }, 404) as Response };
    const denied = await requireWorkshopRead(c, deps.membership, workshop, deps.entitlements);
    if (denied) return { denied };
    return { workshop };
  }

  /** As above, then the owner check. Used by the three write routes. */
  async function writable(c: Context) {
    const got = await readable(c);
    if (got.denied) return got;
    const identity = requireIdentity(c);
    if (!isWorkshopOwner(got.workshop!, identity)) {
      /**
       * ⚠ 403 AND NOT 404. The caller got this far, so they can READ the experience; hiding its
       * existence now would be a different answer to a question they have already had answered. The
       * sibling routes in `routes.ts` answer 403 for the owner-miss case and two answers for one
       * situation is how a client comes to depend on the distinction.
       */
      return { denied: c.json({ error: "Only the facilitator who owns this experience may change its resources" }, 403) as Response };
    }
    return got;
  }

  /** The store, or the 501 that says this deployment has no bucket. */
  function store(c: Context) {
    if (!deps.resources) {
      return { denied: c.json({ error: "Resource storage is not configured", code: "RESOURCES_UNAVAILABLE" }, 501) as Response };
    }
    return { resources: deps.resources };
  }

  /**
   * LIST — every role that can read the experience.
   *
   * ⚠ BUILT FROM S3 ALONE, so it is by construction exactly what exists. See resource-store.ts for why
   * there is no metadata table: with one, a half-failed write leaves a row whose object 404s, and the
   * list is the place that lie would surface.
   */
  app.get("/workshops/:id/resources", async (c) => {
    const got = await readable(c);
    if (got.denied) return got.denied;
    const s = store(c);
    if (s.denied) return s.denied;

    const workshopId = got.workshop!.id;
    const objects = await s.resources!.list(resourcePrefix(workshopId));

    const rows: {
      key: string;
      resourceId: string;
      filename: string;
      bytes: number;
      uploadedAt: string | null;
    }[] = [];
    for (const o of objects) {
      const parsed = parseResourceKey(o.key, workshopId);
      // A stray object under the prefix is omitted rather than rendered with a nonsense name.
      if (!parsed) continue;
      rows.push({
        key: o.key,
        resourceId: parsed.resourceId,
        filename: parsed.filename,
        bytes: o.bytes,
        uploadedAt: o.lastModified ? o.lastModified.toISOString() : null,
      });
    }

    /**
     * ── ⚠ WHO UPLOADED IT COSTS ONE HEAD PER OBJECT, AND THAT IS WHY IT IS BOUNDED ──────────────
     *
     * `ListObjectsV2` returns size and timestamp but NOT user metadata, so the uploader can only come
     * from a HeadObject. That is an N+1 against S3 and it is accepted here for one reason: this list is
     * a handful of files per experience (see resource-store.ts on why there is no metadata table), and
     * the alternative — a DynamoDB row per resource — reintroduces the drift that design avoids.
     *
     * ⚠ CONCURRENCY IS CAPPED. Firing a HEAD per object unbounded is the fan-out this platform's
     * standing constraints forbid, and on an experience with 200 resources it would be 200 parallel
     * calls from one Lambda. Eight at a time keeps a 30-file list to four rounds.
     *
     * ⚠ A FAILED HEAD DEGRADES THE ROW, NEVER THE LIST. An object whose metadata cannot be read still
     * appears with its name, size and date — it simply has no uploader. Letting one HEAD fail the whole
     * response would turn a cosmetic gap into "resources could not be loaded".
     */
    const HEAD_CONCURRENCY = 8;
    const uploaders = new Array<string>(rows.length).fill("");
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(HEAD_CONCURRENCY, rows.length) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= rows.length) return;
          const meta = await s.resources!.describe(rows[i].key).catch(() => null);
          uploaders[i] = meta?.uploadedByEmail || "";
        }
      })
    );

    const resources = rows.map((r, i) => ({
      resourceId: r.resourceId,
      filename: r.filename,
      bytes: r.bytes,
      uploadedAt: r.uploadedAt,
      /** Empty when unknown — objects written before this was stored, or an unreadable HEAD. */
      uploadedBy: uploaders[i],
    }));

    /** Newest first: a facilitator who just uploaded something looks for it at the top. */
    resources.sort((a, b) => (a.uploadedAt && b.uploadedAt ? b.uploadedAt.localeCompare(a.uploadedAt) : 0));

    return c.json({ resources, limits: { maxBytes: MAX_RESOURCE_BYTES, extensions: ALLOWED_RESOURCE_EXTENSIONS } });
  });

  /**
   * BEGIN AN UPLOAD — owner only.
   *
   * Admits the name and declared size, opens a multipart upload and returns one presigned PUT per part.
   * The declared size decides only HOW MANY part URLs are minted; see resource-policy.ts for why the
   * real ceiling is enforced at completion instead.
   */
  app.post("/workshops/:id/resources/uploads", async (c) => {
    const got = await writable(c);
    if (got.denied) return got.denied;
    const s = store(c);
    if (s.denied) return s.denied;

    let body: { filename?: unknown; bytes?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be JSON" }, 400);
    }

    const admitted = admitResource({ filename: body.filename, declaredBytes: body.bytes });
    if (!admitted.ok) return c.json({ error: admitted.reason }, 400);

    const workshopId = got.workshop!.id;
    /** A ULID, so two uploads of one filename are two resources and DELETE names an object, not a name. */
    const resourceId = ulid();
    const key = resourceKey({ workshopId, resourceId, filename: admitted.filename });

    const who = requireIdentity(c);
    const uploadId = await s.resources!.beginUpload({
      key,
      contentType: admitted.contentType,
      filename: admitted.filename,
      uploadedBy: who.id,
      /**
       * ⚠ FROM THE VERIFIED CLAIMS, NOT FROM THE REQUEST BODY. The gateway's authorizer put it there;
       * a client-supplied name would let a facilitator attribute an upload to someone else.
       */
      uploadedByEmail: who.email || undefined,
    });
    const partUrls = await s.resources!.presignParts({ key, uploadId, partCount: admitted.partCount });

    return c.json({
      resourceId,
      key,
      uploadId,
      partUrls,
      partSize: PART_SIZE_BYTES,
      filename: admitted.filename,
    });
  });

  /**
   * COMPLETE — owner only. Assembles the parts, then enforces the ceiling for real.
   *
   * ⚠ THE KEY COMES FROM THE CLIENT AND IS THEREFORE RE-VERIFIED. `parseResourceKey` returns null for
   * anything outside THIS experience's prefix, so a caller who owns experience A cannot complete an
   * upload into experience B by naming its key. The guard is the prefix check, not trust.
   *
   * ⚠ OVER THE CEILING, THE OBJECT IS DELETED AND THE UPLOAD REFUSED. A presigned part URL does not
   * limit the bytes pushed through it and S3 will not total them for us, so this — a HeadObject against
   * the assembled object — is the only place the 100MB limit is a fact rather than a claim. Deleting
   * rather than keeping it is the point: a refused upload that is still stored is not refused.
   */
  app.post("/workshops/:id/resources/uploads/complete", async (c) => {
    const got = await writable(c);
    if (got.denied) return got.denied;
    const s = store(c);
    if (s.denied) return s.denied;

    let body: { key?: unknown; uploadId?: unknown; parts?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be JSON" }, 400);
    }

    const workshopId = got.workshop!.id;
    if (typeof body.key !== "string" || typeof body.uploadId !== "string") {
      return c.json({ error: "key and uploadId are required" }, 400);
    }
    const parsed = parseResourceKey(body.key, workshopId);
    if (!parsed) return c.json({ error: "key does not belong to this experience" }, 400);

    if (!Array.isArray(body.parts) || body.parts.length === 0) {
      return c.json({ error: "parts are required" }, 400);
    }
    const parts: { partNumber: number; etag: string }[] = [];
    for (const raw of body.parts) {
      const p = raw as { partNumber?: unknown; etag?: unknown };
      if (typeof p.partNumber !== "number" || !Number.isInteger(p.partNumber) || p.partNumber < 1) {
        return c.json({ error: "every part needs a whole partNumber of 1 or more" }, 400);
      }
      if (typeof p.etag !== "string" || !p.etag) {
        return c.json({ error: "every part needs an etag" }, 400);
      }
      parts.push({ partNumber: p.partNumber, etag: p.etag });
    }

    try {
      await s.resources!.completeUpload({ key: body.key, uploadId: body.uploadId, parts });
    } catch (err) {
      /**
       * A failed completion leaves the parts in place and billed. Abort explicitly rather than leaving
       * it to the lifecycle rule, which is the backstop for the case where nobody is left to ask.
       */
      await s.resources!.abortUpload({ key: body.key, uploadId: body.uploadId }).catch(() => {});
      return c.json({ error: `Upload could not be completed: ${(err as Error).message}` }, 400);
    }

    const actual = await s.resources!.sizeOf(body.key);
    if (actual !== null && exceedsCeiling(actual)) {
      await s.resources!.remove(body.key).catch(() => {});
      return c.json(
        {
          error: `The uploaded file is larger than the ${Math.floor(MAX_RESOURCE_BYTES / (1024 * 1024))}MB limit and was discarded`,
          code: "RESOURCE_TOO_LARGE",
        },
        413
      );
    }

    return c.json({
      resource: {
        resourceId: parsed.resourceId,
        filename: parsed.filename,
        bytes: actual ?? 0,
        uploadedAt: new Date().toISOString(),
      },
    });
  });

  /**
   * ABORT — owner only. The client's way to say "I cancelled", so the parts stop being billed now
   * rather than whenever the lifecycle rule next runs.
   */
  app.post("/workshops/:id/resources/uploads/abort", async (c) => {
    const got = await writable(c);
    if (got.denied) return got.denied;
    const s = store(c);
    if (s.denied) return s.denied;

    let body: { key?: unknown; uploadId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be JSON" }, 400);
    }
    if (typeof body.key !== "string" || typeof body.uploadId !== "string") {
      return c.json({ error: "key and uploadId are required" }, 400);
    }
    if (!parseResourceKey(body.key, got.workshop!.id)) {
      return c.json({ error: "key does not belong to this experience" }, 400);
    }

    await s.resources!.abortUpload({ key: body.key, uploadId: body.uploadId }).catch(() => {});
    return c.json({ aborted: true });
  });

  /**
   * DOWNLOAD — every role that can read the experience.
   *
   * ⚠ THE KEY IS RESOLVED FROM THE `resourceId`, NEVER TAKEN FROM THE CALLER. Listing the resource's own
   * prefix is one S3 call and it means the filename cannot be used to steer this at another object. The
   * URL is short-lived and carries `Content-Disposition: attachment` — see resource-store.ts.
   */
  app.get("/workshops/:id/resources/:resourceId/download", async (c) => {
    const got = await readable(c);
    if (got.denied) return got.denied;
    const s = store(c);
    if (s.denied) return s.denied;

    const found = await resolveOne(s.resources!, got.workshop!.id, c.req.param("resourceId"));
    if (!found) return c.json({ error: "Resource not found" }, 404);

    const url = await s.resources!.presignDownload({ key: found.key, filename: found.filename });
    return c.json({ url, filename: found.filename, expiresInSeconds: 300 });
  });

  /**
   * DELETE — owner only.
   *
   * ⚠ RESOLVED FROM THE `resourceId` FOR THE SAME REASON DOWNLOAD IS, and it matters more here: a
   * caller-supplied key on a delete is a way to remove an object the caller named rather than the one
   * they are entitled to. The prefix the list runs against is built from the workshop id this request
   * was already authorized for.
   */
  app.delete("/workshops/:id/resources/:resourceId", async (c) => {
    const got = await writable(c);
    if (got.denied) return got.denied;
    const s = store(c);
    if (s.denied) return s.denied;

    const found = await resolveOne(s.resources!, got.workshop!.id, c.req.param("resourceId"));
    if (!found) return c.json({ error: "Resource not found" }, 404);

    await s.resources!.remove(found.key);
    return c.json({ deleted: true, resourceId: found.resourceId, filename: found.filename });
  });
}

/**
 * Find the single object behind one resourceId.
 *
 * ⚠ THE `resourceId` IS CONFINED TO ONE PATH SEGMENT BEFORE IT IS USED AS A PREFIX. Without this a
 * resourceId of `../` would widen the listing beyond the experience — the same concatenation bug the
 * filename policy exists to prevent, arriving through the other parameter. A ULID contains neither a
 * slash nor a dot, so nothing legitimate is refused.
 */
async function resolveOne(
  resources: ResourceStore,
  workshopId: string,
  resourceId: string
): Promise<{ key: string; resourceId: string; filename: string } | null> {
  if (!/^[A-Za-z0-9]{1,64}$/.test(resourceId)) return null;

  const objects = await resources.list(`${resourcePrefix(workshopId)}${resourceId}/`);
  for (const o of objects) {
    const parsed = parseResourceKey(o.key, workshopId);
    if (parsed && parsed.resourceId === resourceId) {
      return { key: o.key, resourceId: parsed.resourceId, filename: parsed.filename };
    }
  }
  return null;
}
