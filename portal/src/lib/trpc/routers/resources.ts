import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { backendFetch } from "@/lib/backend";
import { auditLog } from "@/lib/audit-logger";

/**
 * ── WORKSHOP RESOURCES ────────────────────────────────────────────────────────────────────────
 *
 * Facilitator-supplied material for ONE experience. The facilitator who OWNS the experience adds and
 * removes; every role that can read the experience can list and download.
 *
 * ⚠ NO AUTHORIZATION DECISION IS MADE IN THIS FILE, AND THAT IS DELIBERATE. Every procedure forwards
 * the caller's own bearer to the Workshop service, which owns both gates (`requireWorkshopRead` for
 * reads, experience ownership for writes). A role check here would be a SECOND copy of a rule that
 * lives there, and the portal is the wrong place for it, because a desktop client or a direct API
 * caller would bypass it entirely. `protectedProcedure` establishes only that somebody is signed in.
 *
 * The one piece of real logic here is the upload CHOREOGRAPHY, and the browser does the middle of it:
 *
 *   1. `beginUpload`  → the service admits the file and returns one presigned URL per part
 *   2. the BROWSER PUTs each part straight to S3 and collects its ETag   (lib/resource-upload.ts)
 *   3. `completeUpload` → the service assembles the parts and enforces the real size ceiling
 *
 * ⚠ STEP 2 CANNOT GO THROUGH THE PORTAL OR THE SERVICE. A 100MB body fits through neither a Next.js
 * route handler on Lambda nor API Gateway (10MB) nor Lambda itself (6MB). Direct-to-S3 is the only
 * shape that works, which is why the ETags come back through the client rather than being discovered
 * server-side.
 */

/** One resource, as the Workshop service lists it. */
export type WorkshopResource = {
  resourceId: string;
  filename: string;
  bytes: number;
  uploadedAt: string | null;
  /**
   * Who added it, as the email from the claims the gateway verified at upload time.
   *
   * ⚠ EMPTY IS NORMAL AND MUST RENDER AS NOTHING. It is empty for anything uploaded before the service
   * stored it, and for an object whose HEAD could not be read, the service degrades the row rather
   * than failing the list, because a missing uploader is cosmetic and a missing list is not.
   */
  uploadedBy?: string;
};

/** What `list` returns alongside the rows, so the UI states the same limits the service enforces. */
export type ResourceLimits = {
  maxBytes: number;
  extensions: string[];
};

const workshopId = z.object({ workshopId: z.string().min(1) });

export const resourcesRouter = router({
  /** Every resource on the experience. Readable by any role that can read the experience. */
  list: protectedProcedure.input(workshopId).query(async ({ ctx, input }) => {
    const data = await backendFetch(
      `/v1/workshops/${encodeURIComponent(input.workshopId)}/resources`,
      { token: ctx.token }
    );
    return {
      resources: (data.resources || []) as WorkshopResource[],
      limits: (data.limits || { maxBytes: 0, extensions: [] }) as ResourceLimits,
    };
  }),

  /**
   * Open a multipart upload. Owner only, enforced by the service.
   *
   * `bytes` is the size the browser reports. The service uses it to decide how many part URLs to mint
   * and re-checks the REAL size after completion, so a wrong value here cannot defeat the ceiling.
   */
  beginUpload: protectedProcedure
    .input(workshopId.extend({ filename: z.string().min(1), bytes: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/workshops/${encodeURIComponent(input.workshopId)}/resources/uploads`,
        {
          method: "POST",
          token: ctx.token,
          body: JSON.stringify({ filename: input.filename, bytes: input.bytes }),
        }
      );
      return data as {
        resourceId: string;
        key: string;
        uploadId: string;
        partUrls: string[];
        partSize: number;
        filename: string;
      };
    }),

  /**
   * Assemble the uploaded parts.
   *
   * ⚠ THE `key` IS ECHOED BACK FROM `beginUpload` RATHER THAN REBUILT HERE, and the service re-verifies
   * that it falls inside the experience's own prefix. Rebuilding it in the client would put key
   * construction, the thing that decides which experience the bytes land in, in the least trustworthy
   * place in the system.
   */
  completeUpload: protectedProcedure
    .input(
      workshopId.extend({
        key: z.string().min(1),
        uploadId: z.string().min(1),
        parts: z
          .array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1) }))
          .min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/workshops/${encodeURIComponent(input.workshopId)}/resources/uploads/complete`,
        {
          method: "POST",
          token: ctx.token,
          body: JSON.stringify({ key: input.key, uploadId: input.uploadId, parts: input.parts }),
        }
      );
      /**
       * ⚠ AUDITED HERE RATHER THAN AT `beginUpload`, because this is the moment the file EXISTS and
       * becomes visible to every role on the experience. An audited begin would record intentions,
       * including the many that are cancelled halfway up a venue's wifi.
       */
      auditLog({
        event: "workshop.resource.added",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { workshopId: input.workshopId },
        outcome: "success",
        metadata: {
          filename: data.resource?.filename,
          bytes: data.resource?.bytes,
          parts: input.parts.length,
        },
      });

      return (data.resource || null) as WorkshopResource | null;
    }),

  /**
   * Tell S3 to discard a cancelled upload.
   *
   * ⚠ WORTH A ROUTE OF ITS OWN RATHER THAN LEAVING IT TO THE LIFECYCLE RULE. Parts uploaded but never
   * completed are billed and INVISIBLE, absent from a LIST and from the console's object view, so a
   * facilitator who cancels three 90MB uploads has left 270MB nobody can see. The bucket's 7-day
   * `AbortIncompleteMultipartUpload` rule is the backstop for a closed tab; this is the tidy path.
   */
  abortUpload: protectedProcedure
    .input(workshopId.extend({ key: z.string().min(1), uploadId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await backendFetch(
        `/v1/workshops/${encodeURIComponent(input.workshopId)}/resources/uploads/abort`,
        {
          method: "POST",
          token: ctx.token,
          body: JSON.stringify({ key: input.key, uploadId: input.uploadId }),
        }
      );
      return { aborted: true };
    }),

  /**
   * A short-lived download URL. Any role that can read the experience.
   *
   * A mutation rather than a query because it MINTS something with a lifetime, caching it in a query
   * cache would hand out a URL that has already expired.
   */
  downloadUrl: protectedProcedure
    .input(workshopId.extend({ resourceId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/workshops/${encodeURIComponent(input.workshopId)}/resources/${encodeURIComponent(input.resourceId)}/download`,
        { method: "GET", token: ctx.token }
      );
      /**
       * ⚠ THE ONLY PLACE AN IDENTITY IS TIED TO A RESOURCE READ. The URL this mints is a bearer-free
       * capability: the bucket's own access log records the FETCH, but by then the request carries a
       * signature rather than a user, so "who downloaded the brief" is reconstructable here and
       * nowhere else. DocsBucket's own logging note in platform-plumbing.yaml makes the same point.
       */
      auditLog({
        event: "workshop.resource.downloaded",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { workshopId: input.workshopId },
        outcome: "success",
        metadata: { resourceId: input.resourceId, filename: data.filename },
      });

      return data as { url: string; filename: string; expiresInSeconds: number };
    }),

  /** Remove a resource. Owner only, enforced by the service. */
  remove: protectedProcedure
    .input(workshopId.extend({ resourceId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const data = await backendFetch(
        `/v1/workshops/${encodeURIComponent(input.workshopId)}/resources/${encodeURIComponent(input.resourceId)}`,
        { method: "DELETE", token: ctx.token }
      );
      /** Destructive and irreversible from the portal, the kind of act an audit trail exists for. */
      auditLog({
        event: "workshop.resource.deleted",
        actor: { id: ctx.user.id, role: ctx.user.role },
        target: { workshopId: input.workshopId },
        outcome: "success",
        metadata: { resourceId: input.resourceId, filename: data.filename },
      });

      return data as { deleted: boolean; resourceId: string; filename: string };
    }),
});
