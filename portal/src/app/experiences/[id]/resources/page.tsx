"use client";

import { useCallback, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { trpc } from "@/lib/trpc/client";
import {
  formatBytes,
  uploadParts,
  ResourceUploadError,
  type UploadProgress,
} from "@/lib/resource-upload";

/**
 * ── RESOURCES, WORKSHOP-WIDE MATERIAL FOR ONE EXPERIENCE ──────────────────────────────────────
 *
 * THE RULE: only the facilitator can add or delete workshop-wide files, and every other role can
 * read them.
 *
 * ⚠ THIS PAGE DOES NOT ENFORCE THAT RULE AND MUST NOT BE READ AS IF IT DID. The Workshop service owns
 * both gates, `requireWorkshopRead` for listing and downloading, experience ownership for uploading
 * and deleting, and refuses regardless of what this renders. What the ownership check below decides
 * is only whether to SHOW controls that would fail: offering a facilitator who does not own this
 * experience an upload button that 403s is a worse experience than not offering it.
 *
 * ⚠ THE UPLOAD IS THREE STEPS AND THE BROWSER DOES THE MIDDLE ONE. `beginUpload` returns one presigned
 * URL per 10MB part; `lib/resource-upload.ts` PUTs them straight to S3 and collects each ETag;
 * `completeUpload` assembles them. The bytes never pass through the portal or the service, because
 * 100MB fits through neither API Gateway (10MB) nor Lambda (6MB). That direct-to-S3 hop is also why
 * `csp.ts` has to name the bucket host, without it the browser refuses the fetch and the only symptom
 * is a bare "Failed to fetch".
 *
 * ── ⚠ THE LAYOUT IS THE TEAMS TAB'S, DELIBERATELY ─────────────────────────────────────────────
 *
 * First version used shadcn-ish utilities (`text-muted-foreground`, `bg-primary`, `bg-muted`) and a
 * bare `<input type="file">`. Both tokens sets exist in this app, so nothing looked broken, it just
 * looked like a different product. This now borrows the experience page's own
 * `TeamsTab` idiom exactly:
 *
 *   · a `flex items-center justify-between` header with the count, actions on the right
 *   · ONE bordered panel (`rounded-xl border border-hairline divide-y divide-hairline`) rather than a
 *     box per row, TeamsTab's note records why: a row keeping its own border inside a bordered panel
 *     "doubled every edge"
 *   · the dashed centred empty state
 *   · `ink-*` for text, `surface-*` for fills, `brand-*` for the primary action, `danger-*` for errors
 *
 * ⚠ AND THE UPLOAD IS A BUTTON ABOVE THE LIST, not an inline file input. That is
 * also how `BulkTeamUpload` presents itself two tabs away, a native file input renders "No file
 * chosen" next to a button nobody styled, which is what was on screen.
 */

type Phase = "idle" | "preparing" | "uploading" | "finishing";

/** Extension badge text. Short, upper-case, and never the whole filename. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return "FILE";
  return filename.slice(dot + 1).toUpperCase().slice(0, 4);
}

export default function ResourcesPage() {
  const params = useParams();
  const workshopId = params.id as string;
  const { data: session } = useSession();

  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<AbortController | null>(null);

  const list = trpc.resources.list.useQuery({ workshopId }, { enabled: Boolean(workshopId) });
  const { data: workshop } = trpc.workshop.getById.useQuery(
    { id: workshopId },
    { enabled: Boolean(workshopId) }
  );

  const beginUpload = trpc.resources.beginUpload.useMutation();
  const completeUpload = trpc.resources.completeUpload.useMutation();
  const abortUpload = trpc.resources.abortUpload.useMutation();
  const downloadUrl = trpc.resources.downloadUrl.useMutation();
  const remove = trpc.resources.remove.useMutation();

  /**
   * ⚠ OWNERSHIP, NOT ROLE, the same rule the service applies. A facilitator who does not own this
   * experience is not an editor of it, which is the mistake the role name invites.
   */
  const myId = (session?.user as { id?: string } | undefined)?.id;
  const canWrite = Boolean(myId && workshop?.ownerId && workshop.ownerId === myId);

  const limits = list.data?.limits;
  const accept = limits?.extensions?.length
    ? limits.extensions.map((e) => `.${e}`).join(",")
    : undefined;

  const busy = phase !== "idle";
  const resources = list.data?.resources ?? [];

  const onPick = useCallback(
    async (file: File) => {
      setError(null);
      setNotice(null);
      setProgress(null);

      /**
       * Checked here only to fail FAST and in words the facilitator can act on. The service checks the
       * same things, and then checks the real size after the bytes land, which is the check that
       * actually enforces the ceiling, since a presigned URL does not constrain what is pushed through it.
       */
      if (limits && file.size > limits.maxBytes) {
        setError(
          `${file.name} is ${formatBytes(file.size)}. The limit is ${formatBytes(limits.maxBytes)}.`
        );
        return;
      }

      const controller = new AbortController();
      cancelRef.current = controller;
      let opened: { key: string; uploadId: string } | null = null;

      try {
        setPhase("preparing");
        const begun = await beginUpload.mutateAsync({
          workshopId,
          filename: file.name,
          bytes: file.size,
        });
        opened = { key: begun.key, uploadId: begun.uploadId };

        setPhase("uploading");
        const parts = await uploadParts({
          file,
          partUrls: begun.partUrls,
          partSize: begun.partSize,
          onProgress: setProgress,
          signal: controller.signal,
        });

        setPhase("finishing");
        await completeUpload.mutateAsync({
          workshopId,
          key: begun.key,
          uploadId: begun.uploadId,
          parts,
        });

        opened = null; // Completed, so there is nothing left to abort.
        setNotice(`${file.name} added.`);
        await list.refetch();
      } catch (err) {
        setError(
          err instanceof ResourceUploadError || err instanceof Error
            ? err.message
            : "The upload failed."
        );
      } finally {
        /**
         * ⚠ ALWAYS, ON EVERY FAILURE PATH. If an upload was opened and not completed, its parts are
         * sitting in S3 costing money where nothing will list them. Best-effort: an abort that itself
         * fails leaves the bucket's lifecycle rule to collect them.
         */
        if (opened) {
          abortUpload.mutate({ workshopId, key: opened.key, uploadId: opened.uploadId });
        }
        cancelRef.current = null;
        setPhase("idle");
        setProgress(null);
        if (fileInput.current) fileInput.current.value = "";
      }
    },
    [workshopId, limits, beginUpload, completeUpload, abortUpload, list]
  );

  const onDownload = useCallback(
    async (resourceId: string) => {
      setError(null);
      setBusyId(resourceId);
      try {
        const { url } = await downloadUrl.mutateAsync({ workshopId, resourceId });
        /**
         * The URL is short-lived and carries `Content-Disposition: attachment`, so the browser saves
         * the file rather than rendering it in our origin. `noopener` because this is a third-party
         * origin (S3) and the opened context has no business reaching back into this one.
         */
        window.open(url, "_blank", "noopener,noreferrer");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not start the download.");
      } finally {
        setBusyId(null);
      }
    },
    [workshopId, downloadUrl]
  );

  const onConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setError(null);
    try {
      await remove.mutateAsync({ workshopId, resourceId: pendingDelete.id });
      setNotice(`${pendingDelete.name} deleted.`);
      await list.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the resource.");
    } finally {
      setPendingDelete(null);
    }
  }, [pendingDelete, workshopId, remove, list]);

  return (
    /**
     * ⚠ `max-w-4xl mx-auto`, THE SAME MEASURE AS EVERY SIBLING. This was `p-6` alone, so the rows ran
     * the full width of the window while Teams, Activity, Submissions and Results all sit in a centred
     * 4xl column, which is what made it look like a different screen. The experience LAYOUT sets no
     * width (it only provides the header and a flex column), so each page owns its own measure:
     * `experiences/[id]/page.tsx` uses `max-w-4xl mx-auto`, activity and submissions use
     * `w-full mx-auto max-w-4xl p-6`. This matches them rather than inventing a third value.
     */
    <section className="w-full mx-auto max-w-4xl p-6">
      {/* ── HEADER: count on the left, the action on the right. TeamsTab's shape exactly. ── */}
      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-semibold">
            Resources{resources.length > 0 ? ` (${resources.length})` : ""}
          </h2>
          <p className="mt-0.5 text-xs text-ink-subtle">
            {canWrite
              ? "Shared with everyone on this experience, participants, executives and judges can download these."
              : "Material the facilitator has shared with everyone on this experience."}
          </p>
        </div>

        {canWrite && (
          <div className="flex shrink-0 items-center gap-2">
            {busy && (
              <button
                type="button"
                onClick={() => cancelRef.current?.abort()}
                className="rounded-md border border-field-border px-3 py-1.5 text-sm transition-colors hover:bg-surface-1 focus:outline-none focus:ring-2 focus:ring-brand"
              >
                Cancel
              </button>
            )}
            {/*
              ⚠ A BUTTON THAT OPENS A HIDDEN INPUT, not a bare `<input type="file">`. The native control
              renders "No file chosen" beside an unstyleable button, which is what used to show. The
              input keeps its own `accept` list so the picker filters to permitted types.
            */}
            <button
              type="button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              className="rounded-md bg-brand px-3 py-1.5 text-sm text-brand-ink transition-colors hover:bg-brand-hover focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-60"
            >
              {busy ? "Uploading…" : "Add Resource"}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept={accept}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onPick(file);
              }}
            />
          </div>
        )}
      </div>

      {/*
        ⚠ `aria-live` SO PROGRESS IS ANNOUNCED. An upload can run for minutes; a sighted user watches
        the bar, and without this a screen-reader user gets nothing between choosing the file and the
        result.
      */}
      <div aria-live="polite">
        {busy && (
          <div className="mb-3 rounded-lg border border-hairline bg-surface-1 px-4 py-3">
            <div className="flex items-center justify-between gap-4 text-sm">
              <span className="truncate">
                {phase === "preparing" && "Preparing the upload…"}
                {phase === "uploading" && "Uploading"}
                {phase === "finishing" && "Finishing…"}
              </span>
              {progress && (
                <span className="shrink-0 tabular-nums text-xs text-ink-subtle">
                  {formatBytes(progress.uploadedBytes)} of {formatBytes(progress.totalBytes)}
                </span>
              )}
            </div>
            {progress && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full bg-brand transition-[width] duration-300"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            )}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-3 rounded-lg border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-text"
          >
            {error}
          </div>
        )}

        {notice && !error && <p className="mb-3 text-sm text-ink-subtle">{notice}</p>}
      </div>

      {list.isLoading && <p className="py-4 text-sm text-ink-subtle">Loading resources…</p>}

      {list.error && (
        <div
          role="alert"
          className="rounded-lg border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-text"
        >
          These resources could not be loaded. {list.error.message}
        </div>
      )}

      {!list.isLoading && !list.error && resources.length === 0 ? (
        <p className="rounded-lg border border-dashed py-4 text-center text-sm text-ink-subtle">
          {canWrite
            ? "Nothing shared yet. Add a brief, a deck or a dataset and everyone on this experience will see it."
            : "The facilitator has not shared anything yet."}
        </p>
      ) : (
        resources.length > 0 && (
          /* ONE bordered panel, rows divided, not a box per row. See the module note. */
          <ul className="overflow-hidden rounded-xl border border-hairline divide-y divide-hairline">
            {resources.map((r) => (
              <li
                key={r.resourceId}
                className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-1"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {/* A type badge rather than an icon set: no new dependency, and it reads at a glance. */}
                  <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-ink-tertiary">
                    {extensionOf(r.filename)}
                  </span>
                  <div className="min-w-0">
                    <h3 className="truncate font-medium" title={r.filename}>
                      {r.filename}
                    </h3>
                    {/*
                      ⚠ ONE METADATA LINE, PARTS JOINED ONLY WHEN PRESENT. `uploadedBy` is empty for
                      anything uploaded before the service recorded it and for an object whose HEAD
                      could not be read, so a naive template would render a dangling " · " on exactly
                      the rows that already look incomplete.

                      ⚠ `truncate` AND `min-w-0` ON THE PARENT: an email is long and a filename can be
                      longer, and without both the row stretches instead of eliding, which is what
                      pushed the action buttons out of alignment between rows.
                    */}
                    <p className="mt-0.5 truncate text-xs text-ink-subtle">
                      {[
                        formatBytes(r.bytes),
                        r.uploadedAt
                          ? new Date(r.uploadedAt).toLocaleDateString("en-GB", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })
                          : null,
                        r.uploadedBy || null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void onDownload(r.resourceId)}
                    disabled={busyId === r.resourceId}
                    className="rounded-md border border-field-border px-3 py-1.5 text-sm transition-colors hover:bg-surface-1 focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-60"
                  >
                    {busyId === r.resourceId ? "Opening…" : "Download"}
                  </button>
                  {canWrite && (
                    <button
                      type="button"
                      onClick={() => setPendingDelete({ id: r.resourceId, name: r.filename })}
                      aria-label={`Delete ${r.filename}`}
                      className="rounded-md border border-field-border px-3 py-1.5 text-sm text-danger-text transition-colors hover:bg-danger-bg focus:outline-none focus:ring-2 focus:ring-brand"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )
      )}

      {limits && canWrite && (
        <p className="mt-3 text-xs text-ink-tertiary">
          Up to {formatBytes(limits.maxBytes)} per file. Allowed: {limits.extensions.join(", ")}.
        </p>
      )}

      {/*
        ⚠ DELETE ASKS FIRST. It is irreversible from this screen, the bucket keeps a noncurrent version
        for 30 days, but nothing in the portal surfaces it, so for the facilitator it is final. A
        one-click destructive action beside a Download button on a list of similar-looking filenames is
        exactly the human-error shape this platform's standing constraints say to design against.
      */}
      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-delete-resource"
            className="w-full max-w-md rounded-lg bg-surface-3 p-6"
          >
            <h3 id="confirm-delete-resource" className="font-semibold">
              Delete this resource?
            </h3>
            <p className="mt-2 text-sm text-ink-subtle">
              <span className="font-medium text-ink">{pendingDelete.name}</span> will no longer be
              available to anyone on this experience.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded-md border border-field-border px-3 py-1.5 text-sm transition-colors hover:bg-surface-1"
              >
                Keep it
              </button>
              <button
                type="button"
                onClick={() => void onConfirmDelete()}
                disabled={remove.isPending}
                className="rounded-md border border-danger-border bg-danger-bg px-3 py-1.5 text-sm font-medium text-danger-text-strong transition-colors hover:bg-danger-field-bg disabled:opacity-60"
              >
                {remove.isPending ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
