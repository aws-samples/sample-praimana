"use client";

import { useCallback, useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { Disclosure } from "./Disclosure";
import { formatBytes } from "@/lib/resource-upload";

/**
 * ── WORKSHOP RESOURCES, ON THE PARTICIPANT'S LANDING PAGE ─────────────────────────────────────
 *
 * ⚠ THIS EXISTS BECAUSE THE RESOURCES TAB IS UNREACHABLE FOR A PARTICIPANT. The tab lives in the
 * experience console under `/experiences/<id>`, and `route-gates.ts` gate 1, "a PARTICIPANT is
 * confined to their own surface", allows them only `/welcome`, `/profile`, `/how-it-works`,
 * `/desktop` and the API routes. `canAccessStaffScreens` is ADMIN, FACILITATOR, EXECUTIVE and JUDGE;
 * PARTICIPANT is the one role excluded. So a participant was REDIRECTED before that page could render,
 * and the feature reached everyone except the audience most likely to want the brief.
 *
 * ⚠ NOTHING WAS WIDENED TO FIX IT. Adding `/experiences/<id>/resources` to the participant allowlist
 * would have dropped them into the console layout, whose other header tabs lead to pages the gate still
 * bounces, visible links that break. This brings the resources to the surface they already have.
 *
 * ── READ-ONLY, AND NOT BY OMISSION ──
 *
 * No upload, no delete, deliberately: the Workshop service grants writes to the experience OWNER alone
 * and would refuse a participant regardless, so offering either control would be offering a 403. The
 * service's read gate (`requireWorkshopRead`) admits a participant through team membership, which is
 * exactly how this list loads for them.
 *
 * ⚠ IT HIDES ITSELF RATHER THAN SHOWING AN ERROR OR AN EMPTY STATE. The landing page's job is the join
 * code and the desktop download; resources are secondary to it. A facilitator who has shared nothing -
 * the common case early on, should leave no trace here, and a failed load should not put a red box on
 * the first screen a participant ever sees. The experience console keeps the loud version for staff.
 */
export function WelcomeResources({
  workshopId,
  experienceName,
  open,
  onToggle,
}: {
  workshopId: string;
  /** Shown only when a participant is on more than one experience. */
  experienceName?: string;
  /** Controlled by the page, so every section on /welcome shares one collapse state. */
  open: boolean;
  onToggle: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = trpc.resources.list.useQuery(
    { workshopId },
    {
      enabled: Boolean(workshopId),
      /* Secondary content: one attempt, no retry storm behind the join code. */
      retry: false,
    }
  );
  const downloadUrl = trpc.resources.downloadUrl.useMutation();

  const onDownload = useCallback(
    async (resourceId: string) => {
      setError(null);
      setBusyId(resourceId);
      try {
        const { url } = await downloadUrl.mutateAsync({ workshopId, resourceId });
        /* Short-lived, and carries `Content-Disposition: attachment` so the browser saves it. */
        window.open(url, "_blank", "noopener,noreferrer");
      } catch (err) {
        setError(err instanceof Error ? err.message : "That download could not be started.");
      } finally {
        setBusyId(null);
      }
    },
    [workshopId, downloadUrl]
  );

  const resources = list.data?.resources ?? [];

  /* See the header: silent when there is nothing to show, or when the read failed. */
  if (list.isLoading || list.error || resources.length === 0) return null;

  return (
    /**
     * ⚠ THE COUNT IS IN THE HEADING, which is the whole reason this is worth collapsing. `Disclosure`
     * puts it there on purpose, "Resources (3)" still answers "is there anything here for me?" while
     * the panel is shut, where "Resources ▸" only asks one. Closed by default, like every other section
     * on this page.
     *
     * ⚠ THE DOWNLOAD ERROR IS PASSED AS `notice`, NOT PUT INSIDE THE PANEL. A failure from a button the
     * participant just pressed must not vanish because they then collapsed the section, which is
     * exactly the case that prop exists for.
     */
    <Disclosure
      id={`welcome-resources-${workshopId}`}
      title={experienceName ? `Resources, ${experienceName}` : "Resources from your facilitator"}
      count={resources.length}
      open={open}
      onToggle={onToggle}
      className="mt-10"
      notice={
        error ? (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-text"
          >
            {error}
          </div>
        ) : undefined
      }
    >
      <p className="mb-4 text-sm text-ink-subtle">
        Briefs, slides and data shared with everyone on this experience.
      </p>

      {/* The same bordered-panel idiom as the experience console's list and TeamsTab. */}
      <ul className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline">
        {resources.map((r) => (
          <li
            key={r.resourceId}
            className="flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-surface-1"
          >
            <div className="min-w-0">
              <p className="truncate font-medium" title={r.filename}>
                {r.filename}
              </p>
              {/* Joined only on the parts that exist, an absent uploader must not leave a stray " · ". */}
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
            <button
              type="button"
              onClick={() => void onDownload(r.resourceId)}
              disabled={busyId === r.resourceId}
              className="shrink-0 rounded-md border border-field-border px-3 py-1.5 text-sm transition-colors hover:bg-surface-1 focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-60"
            >
              {busyId === r.resourceId ? "Opening…" : "Download"}
            </button>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
