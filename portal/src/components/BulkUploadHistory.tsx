"use client";

// ── BULK UPLOAD HISTORY ──────────────────────────────────────────────────────────────────
//
// What happened to every file uploaded for this experience: when, how much it asked for, what became of
// it, and, on click, exactly which teams and addresses failed and why.
//
// ⚠ THIS PANEL EXISTS BECAUSE "ACCEPTED" WAS THE LAST THING ANYONE EVER LEARNED ABOUT A BATCH. The work
// moved to a worker so nobody has to wait for it, and the outcome was to arrive by email. Then the
// first real upload failed every team, the requester's email came through empty so no report could be
// sent, and the panel still said "Accepted, being set up". Nothing in the product disagreed.
//
// ⚠ SO THE PROMISE THIS PANEL MAKES IS NARROW AND MUST STAY TRUE: it shows what is KNOWN. A batch nobody
// has reported on says so; it never says "processing" for something that stopped answering twenty
// minutes ago, and it never says "complete" without the counts to back it.

// `Fragment` explicitly rather than `<>`: each batch renders TWO sibling rows (the summary and its
// expanded detail), and a shorthand fragment cannot carry the key that pairs them.
import { Fragment, useCallback, useEffect, useState } from "react";
import {
  formatDuration,
  formatWhen,
  hasDetail,
  isTerminal,
  orderedFailures,
  reportMissing,
  statusView,
  type BulkBatchView,
  type Tone,
} from "@/lib/bulk-invite/batch";

/**
 * ⚠ POLLED, NOT PUSHED, AND ONLY WHILE SOMETHING IS ACTUALLY RUNNING. A batch takes seconds to a minute,
 * so a live-updating panel is worth having, but polling a finished list forever would be a request
 * every few seconds for the lifetime of an open tab. The interval stops the moment nothing is in flight.
 */
const POLL_MS = 5_000;

const TONE_STYLES: Record<Tone, string> = {
  pending: "bg-surface-2 text-ink-muted border-hairline",
  good: "bg-success-bg text-success-text border-success-border",
  warn: "bg-warn-bg text-warn-text border-warn-border",
  bad: "bg-danger-bg text-danger-text border-danger-border",
};

type Load =
  | { kind: "loading" }
  | { kind: "ready"; batches: BulkBatchView[] }
  /** ⚠ DISTINCT FROM AN EMPTY LIST. "No uploads" and "we cannot tell you" are different facts. */
  | { kind: "error"; message: string };

export function BulkUploadHistory({
  workshopId,
  /** Bumped by the parent after an upload is accepted, so the new row appears without a reload. */
  refreshKey = 0,
}: {
  workshopId: string;
  refreshKey?: number;
}) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchBatches = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/workshops/${encodeURIComponent(workshopId)}/bulk-provision/batches`,
        { cache: "no-store" }
      );
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        setLoad({
          kind: "error",
          message: body.error ?? "We could not load the upload history.",
        });
        return;
      }
      setLoad({ kind: "ready", batches: Array.isArray(body.batches) ? body.batches : [] });
    } catch {
      setLoad({
        kind: "error",
        message: "We could not load the upload history. Check your connection.",
      });
    }
  }, [workshopId]);

  useEffect(() => {
    void fetchBatches();
  }, [fetchBatches, refreshKey]);

  // Keep polling only while a batch is still in flight, see POLL_MS.
  const inFlight =
    load.kind === "ready" && load.batches.some((b) => !isTerminal(b.status));

  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => void fetchBatches(), POLL_MS);
    return () => clearInterval(timer);
  }, [inFlight, fetchBatches]);

  if (load.kind === "loading") {
    return <p className="text-xs text-ink-subtle">Loading upload history…</p>;
  }

  if (load.kind === "error") {
    return (
      <div className="rounded-md border border-warn-border bg-warn-bg p-3">
        <p className="text-xs text-warn-text">{load.message}</p>
      </div>
    );
  }

  if (load.batches.length === 0) {
    return <p className="text-xs text-ink-subtle">No files have been uploaded for this experience yet.</p>;
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full text-left text-xs">
        <thead className="bg-surface-1 text-ink-subtle">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Uploaded
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              In the file
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Status
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Finished
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {load.batches.map((batch) => {
            const view = statusView(batch);
            const failures = orderedFailures(batch);
            const expandable = hasDetail(batch);
            const isOpen = expanded === batch.batchId;
            const duration = formatDuration(batch);

            return (
              <Fragment key={batch.batchId}>
                <tr className="align-top">
                  <td className="px-3 py-2 tabular-nums text-ink-muted">
                    {formatWhen(batch.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-ink-muted">
                    {/* What was ASKED for, so "18 requested, 12 invited" is always answerable. */}
                    {batch.requested.teams} team{batch.requested.teams === 1 ? "" : "s"},{" "}
                    {batch.requested.members} invite
                    {batch.requested.members === 1 ? "" : "s"}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded border px-1.5 py-0.5 font-medium ${TONE_STYLES[view.tone]}`}
                    >
                      {view.label}
                    </span>
                    {view.detail && <p className="mt-1 text-ink-subtle">{view.detail}</p>}

                    {/*
                      ⚠ THE UNSENT REPORT IS ITS OWN LINE, because it is a separate problem from whatever
                      the batch did. This is the case that actually happened: the outcome was recorded and
                      the person who uploaded it was never told. Somebody reading this is the only
                      remaining path to them finding out.
                    */}
                    {reportMissing(batch) && (
                      <p className="mt-1 text-warn-text">
                        No report email was sent for this upload, tell {batch.requestedBy.email || "the uploader"} directly.
                      </p>
                    )}

                    {expandable && (
                      <button
                        onClick={() => setExpanded(isOpen ? null : batch.batchId)}
                        aria-expanded={isOpen}
                        className="mt-1 rounded text-brand-text underline hover:text-brand-text-strong focus:outline-none focus:ring-2 focus:ring-brand"
                      >
                        {isOpen
                          ? "Hide details"
                          : `Show ${failures.length || 1} problem${failures.length === 1 || failures.length === 0 ? "" : "s"}`}
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-ink-muted">
                    {formatWhen(batch.completedAt)}
                    {duration && <span className="block text-ink-subtle">took {duration}</span>}
                  </td>
                </tr>

                {isOpen && (
                  <tr className="bg-danger-bg/40">
                    <td colSpan={4} className="px-3 py-3">
                      {/* The batch-level reason, when the run never started at all. */}
                      {batch.error && (
                        <p className="mb-2 text-danger-text">
                          <span className="font-medium">This upload could not run:</span> {batch.error}
                        </p>
                      )}

                      {failures.length > 0 && (
                        <ul className="space-y-1">
                          {failures.map((failure, i) => (
                            <li key={i} className="text-danger-text">
                              {/*
                                ⚠ A TEAM WITH NO ADDRESS IS THE WORST CASE AND IS LABELLED AS SUCH:
                                nobody on it was invited. `orderedFailures` puts these first.
                              */}
                              <span className="font-medium">
                                {failure.teamName}
                                {failure.email ? ` · ${failure.email}` : ", team NOT created"}
                              </span>
                              {", "}
                              {failure.reason}
                            </li>
                          ))}
                        </ul>
                      )}

                      {batch.failuresTruncated && (
                        <p className="mt-2 text-danger-text">
                          Only the first {failures.length} problems were recorded, the report email
                          lists the rest.
                        </p>
                      )}

                      {/*
                        ⚠ THE ONE INSTRUCTION THAT STOPS THE NATURAL REACTION BEING "RE-UPLOAD AND HOPE".
                        A re-upload retries only the failures: a matching team name adds to the existing
                        team, and an address that already holds a live invitation is skipped rather than
                        re-invited (which would invalidate the link already in their inbox).
                      */}
                      {batch.status === "completed_with_errors" && (
                        <p className="mt-2 text-ink-muted">
                          Uploading the same file again retries the failures, anyone already invited
                          and set up is skipped, so nothing is duplicated.
                          {/*
                            ⚠ NAMED AS AN EXCEPTION, because for this class a re-upload does NOTHING.
                            An address whose account was created but whose email failed keeps a live
                            invitation, so the skip rule passes over it for ever. Telling the operator
                            "just re-upload" would send them round a loop that cannot work.
                          */}
                          {failures.some((f) => /re-invite/i.test(f.reason)) && (
                            <>
                              {" "}
                              The exceptions are the addresses marked “re-invite”: those already have
                              an account, so they must be re-invited individually.
                            </>
                          )}
                        </p>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
