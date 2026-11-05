"use client";

// ── BULK TEAM UPLOAD ─────────────────────────────────────────────────────────────────────
//
// Download a template, fill it in, upload it. The response carries the real per-team, per-row
// outcome, so this panel reports what HAPPENED rather than promising a later email.
//
// ⚠ THE OUTCOME IS NOT SHOWN HERE ANY MORE, AND THAT IS THE POINT. The work runs in a worker
// because the requirement is that nobody waits for it, so this panel
// acknowledges and gets out of the way. The per-team, per-address result, including which teams and
// addresses FAILED, arrives by email.
//
// ⚠ THE ACKNOWLEDGEMENT SAYS BOTH THINGS: you may leave, and an email is coming. "Accepted" alone
// would leave someone watching a panel that will never change, which is the waiting this removed.
//
// ⚠ AND A 503 IS REPORTED AS "not enabled here", NEVER as a problem with their file. A facilitator
// sent hunting a mistake in a correct spreadsheet is a worse outcome than a plain "ask an
// administrator".

import { useRef, useState } from "react";
import {
  MAX_BULK_ROWS,
  MAX_FILE_BYTES,
  MAX_NEW_TEAMS_PER_FILE,
} from "@/lib/bulk-invite/contract";
import { buildAnnotatedCsv } from "@/lib/bulk-invite/report";
import type { BulkRowError } from "@/lib/bulk-invite/validate";
import { BulkUploadHistory } from "./BulkUploadHistory";

type Outcome =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "invalid"; errors: BulkRowError[]; rowCount: number; truncated: boolean }
  | { kind: "unavailable"; message: string; teams: number; members: number }
  | { kind: "accepted"; message: string; teams: number; members: number }
  | { kind: "failed"; message: string };

/** Trigger a client-side download without a server round-trip or a stored artefact. */
function download(filename: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked immediately: the blob is already handed to the download, and leaving it attached leaks
  // the whole file for the lifetime of the page.
  URL.revokeObjectURL(url);
}

export function BulkTeamUpload({ workshopId }: { workshopId: string }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  /**
   * Bumped when an upload is accepted so the history reloads immediately.
   *
   * ⚠ THE NEW ROW MUST APPEAR AT ONCE, because this is the moment the operator decides whether they
   * were understood. A history that only refreshed on its own timer would show "Accepted" above an
   * unchanged list, which is exactly the mismatch that made the first failed upload invisible.
   */
  const [historyKey, setHistoryKey] = useState(0);
  /** Kept so the annotated error report can be built from the ORIGINAL bytes, not a re-parse. */
  const [uploadedText, setUploadedText] = useState("");
  const [fileName, setFileName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setOutcome({ kind: "idle" });
    setUploadedText("");
    setFileName("");
    if (inputRef.current) inputRef.current.value = "";
  }

  async function onFile(file: File) {
    setFileName(file.name);

    /**
     * ⚠ THE SIZE CHECK IS REPEATED HERE, and it is NOT the boundary, the route enforces it on the
     * received bytes because a header is a claim. This copy exists only to fail instantly on a
     * 5 MB mis-drop instead of uploading it first.
     */
    if (file.size > MAX_FILE_BYTES) {
      setOutcome({
        kind: "failed",
        message: `That file is ${Math.round(file.size / 1024)} KB, the limit is ${MAX_FILE_BYTES / 1024} KB.`,
      });
      return;
    }

    const text = await file.text();
    setUploadedText(text);
    setOutcome({ kind: "uploading" });

    try {
      const res = await fetch(`/api/workshops/${encodeURIComponent(workshopId)}/bulk-provision`, {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: text,
      });
      const body = await res.json().catch(() => ({}));

      if (res.status === 400 && Array.isArray(body.errors)) {
        setOutcome({
          kind: "invalid",
          errors: body.errors,
          rowCount: body.rowCount ?? 0,
          truncated: !!body.truncated,
        });
        return;
      }
      // The honest refusal: the file is FINE, the feature is not switched on.
      if (res.status === 503) {
        setOutcome({
          kind: "unavailable",
          message: body.error ?? "Bulk upload is not enabled on this environment yet.",
          teams: body.teams ?? 0,
          members: body.members ?? 0,
        });
        return;
      }
      if (res.status === 202 && body.accepted) {
        setOutcome({
          kind: "accepted",
          message: body.message ?? "Processing, we will email you when it finishes.",
          teams: body.teams ?? 0,
          members: body.members ?? 0,
        });
        // Show the new batch immediately, and start the history polling that tracks it to completion.
        setHistoryKey((k) => k + 1);
        return;
      }
      setOutcome({ kind: "failed", message: body.error ?? `Upload failed (${res.status}).` });
    } catch {
      setOutcome({
        kind: "failed",
        message: "The upload could not be sent. Check your connection and try again.",
      });
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="rounded-md border border-field-border px-3 py-1.5 text-sm transition-colors hover:bg-surface-1 focus:outline-none focus:ring-2 focus:ring-brand"
      >
        Bulk upload
      </button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-upload-title"
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-surface-3 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 id="bulk-upload-title" className="font-semibold">
              Bulk upload teams
            </h3>
            <p className="mt-1 text-sm text-ink-subtle">
              Create several teams and invite their members from one CSV.
            </p>
          </div>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="rounded p-1 text-ink-tertiary transition-colors hover:bg-surface-2 hover:text-ink-subtle"
          >
            ✕
          </button>
        </div>

        {/* ── STEP 1 ── */}
        <ol className="space-y-4">
          <li className="rounded-lg border p-4">
            <p className="text-sm font-medium">1. Download the template</p>
            <p className="mt-1 text-xs text-ink-subtle">
              One row per person. Repeat the team name for each member. At most {MAX_BULK_ROWS} rows
              across {MAX_NEW_TEAMS_PER_FILE} teams.
            </p>
            <a
              href={`/api/workshops/${encodeURIComponent(workshopId)}/bulk-provision/template`}
              className="mt-3 inline-block rounded-md border border-field-border px-3 py-1.5 text-sm transition-colors hover:bg-surface-1"
            >
              Download template.csv
            </a>
          </li>

          {/* ── STEP 2 ── */}
          <li className="rounded-lg border p-4">
            <p className="text-sm font-medium">2. Upload the filled-in file</p>
            <p className="mt-1 text-xs text-ink-subtle">
              A team name that already exists here adds members to it; a new name creates the team.
              {/* Set the expectation BEFORE the refusal, so an all-or-nothing rejection is not a
                  surprise. */}{" "}
              One bad row rejects the whole file and nothing is created.
            </p>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
              className="mt-3 block w-full text-sm file:mr-3 file:rounded-md file:border file:border-field-border file:bg-surface-3 file:px-3 file:py-1.5 file:text-sm hover:file:bg-surface-1"
            />
          </li>
        </ol>

        {/* ── RESULT ── */}
        {outcome.kind === "uploading" && (
          <p className="mt-4 text-sm text-ink-subtle">Checking {fileName}…</p>
        )}

        {outcome.kind === "invalid" && (
          <div className="mt-4 rounded-lg border border-danger-border bg-danger-bg p-4">
            <p className="text-sm font-medium text-danger-text">
              {outcome.errors.length} problem{outcome.errors.length === 1 ? "" : "s"} found, nothing
              was created.
            </p>
            {/* Line numbers count the header, matching what the operator sees in their editor. */}
            <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto text-xs text-danger-text">
              {outcome.errors.map((e, i) => (
                <li key={i} className="tabular-nums">
                  <span className="font-medium">Line {e.line}</span>
                  {e.column ? ` · ${e.column}` : ""}, {e.message}
                </li>
              ))}
            </ul>
            {outcome.truncated && (
              <p className="mt-2 text-xs text-danger-text-strong">
                Only the first {outcome.errors.length} are listed.
              </p>
            )}
            <div className="mt-3 flex gap-2">
              {/*
                The annotated file is built CLIENT-SIDE from the JSON response and the bytes the
                operator uploaded, so their file is never stored on the server, nothing to expire
                or leak. `buildAnnotatedCsv` guards the error column against formula injection.
              */}
              <button
                onClick={() =>
                  download(
                    fileName.replace(/\.csv$/i, "") + "-errors.csv",
                    buildAnnotatedCsv(uploadedText, outcome.errors)
                  )
                }
                className="rounded-md border border-danger-field-border bg-surface-3 px-3 py-1.5 text-xs font-medium text-danger-text transition-colors hover:bg-danger-bg"
              >
                Download file with errors marked
              </button>
              <button
                onClick={reset}
                className="rounded-md border border-field-border bg-surface-3 px-3 py-1.5 text-xs transition-colors hover:bg-surface-1"
              >
                Try another file
              </button>
            </div>
          </div>
        )}

        {outcome.kind === "unavailable" && (
          <div className="mt-4 rounded-lg border border-warn-border bg-warn-bg p-4">
            {/*
              ⚠ THE FILE IS VALID AND THE HEADLINE SAYS SO FIRST. The 503 is about the platform, not
              their spreadsheet, and leading with "not enabled" would send them looking for a
              mistake that is not there.
            */}
            <p className="text-sm font-medium text-warn-text">
              Your file is valid, {outcome.teams} team{outcome.teams === 1 ? "" : "s"} and{" "}
              {outcome.members} member{outcome.members === 1 ? "" : "s"}, but nothing was created.
            </p>
            <p className="mt-1 text-sm text-warn-text">{outcome.message}</p>
          </div>
        )}

        {outcome.kind === "accepted" && (
          <div className="mt-4 rounded-lg border border-success-border bg-success-bg p-4">
            <p className="text-sm font-medium text-success-text">
              Accepted, {outcome.teams} team{outcome.teams === 1 ? "" : "s"} and {outcome.members}{" "}
              member{outcome.members === 1 ? "" : "s"} are being set up.
            </p>
            <p className="mt-1 text-sm text-success-text">{outcome.message}</p>
            {/*
              ⚠ THE CLOSE BUTTON IS THE PRIMARY ACTION HERE, deliberately. The whole point of the
              switch to a worker is that nobody waits, leaving them on a panel with no obvious way
              out would recreate exactly the waiting it removed.

              ⚠ AND IT NOW SAYS WHERE TO LOOK. "You can leave" was true and incomplete: the email was
              the only follow-up, and when it could not be sent the operator had nothing. The history
              below is the durable answer, so the acknowledgement points at it.
            */}
            <p className="mt-1 text-xs text-success-text">
              Its progress is tracked under “Recent uploads” below, whether or not the email arrives.
            </p>
            <button
              onClick={() => {
                reset();
                setOpen(false);
              }}
              className="mt-3 rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-brand-ink transition-colors hover:bg-brand-hover"
            >
              Done
            </button>
          </div>
        )}

        {outcome.kind === "failed" && (
          <div className="mt-4 rounded-lg border border-danger-border bg-danger-bg p-4">
            <p className="text-sm text-danger-text">{outcome.message}</p>
            <button
              onClick={reset}
              className="mt-3 rounded-md border border-field-border bg-surface-3 px-3 py-1.5 text-xs transition-colors hover:bg-surface-1"
            >
              Try again
            </button>
          </div>
        )}

        {/* ── ⚠ THE AUDIT TRAIL, AND IT IS ALWAYS VISIBLE ──────────────────────────────────
            Not hidden behind the result of THIS upload, because its most important use is for a
            PREVIOUS one: a batch that finished badly, or never finished, while nobody was looking.
            Opening this dialog is the natural moment to notice that. */}
        <div className="mt-6 border-t pt-4">
          <h4 className="text-sm font-medium">Recent uploads</h4>
          <p className="mb-3 mt-1 text-xs text-ink-subtle">
            Every file uploaded for this experience, and what became of it. Click a problem count to
            see which teams and addresses failed.
          </p>
          <BulkUploadHistory workshopId={workshopId} refreshKey={historyKey} />
        </div>
      </div>
    </div>
  );
}
