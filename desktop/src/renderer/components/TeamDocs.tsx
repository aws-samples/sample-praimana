import { useState, useEffect } from "react";

const api = (window as any).electronAPI;

interface DocFile {
  path: string;
  versionId: string | null;
  lastCommitHash: string | null;
  /**
   * Two kinds of value: a Cognito SUB for a hand-uploaded file, a git author NAME for a synced one.
   * The service resolves the former and sends `lastAuthorName` only when it succeeded, so every read
   * prefers the name and falls back to this. Reading it alone is what put
   * `94c89498-90e1-7070-dd34-b71a17076f4c` on screen.
   */
  lastAuthor: string | null;
  lastAuthorName?: string;
  updatedAt: string;
}

/** One candidate file in the open repository, as `git:listUploadable` reports it. */
interface RepoFile {
  path: string;
  sizeBytes: number;
  lastCommitHash: string | null;
  lastAuthor: string | null;
  lastModified: string | null;
}

interface DocVersion {
  versionId: string;
  lastModified: string;
  size: number;
  isLatest: boolean;
}

/** Matches the docs service's allowlist — shown so a refusal is predictable, not a surprise. */
const ALLOWED = "md, txt, pdf, html";
const MAX_MB = 20;

/**
 * The team's synced documents: every `.md` the AI agent committed and pushed, plus any
 * file uploaded by hand, with S3 version history per file.
 *
 * ── WHY IT LIVES IN THE BUILD PHASE ──
 *
 * This is the phase where the spec-driven artefacts actually get produced, so it is where
 * a participant looks for them and where a facilitator looks to see progress. The store
 * itself is team-wide rather than phase-scoped — a doc synced during Ideation appears here
 * too — which is correct: the list answers "what has our team produced", not "what did we
 * produce in this phase".
 *
 * Reads and the upload all run in the MAIN process, so the bearer never crosses the
 * bridge and the renderer never holds a presigned S3 URL.
 */
export function TeamDocs() {
  const [files, setFiles] = useState<DocFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [content, setContent] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ path: string; versionId: string | null } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  /**
   * ── THE REPO PICKER ──
   *
   * `null` means closed. Listing is a pure read (nothing leaves the machine), so opening this costs
   * nothing and the participant sees exactly what would be uploaded before committing to it.
   *
   * Selection is a Set of relative paths rather than a per-row boolean, so "select all" and the
   * count are one operation and there is no parallel array to keep in step with the list.
   */
  const [repoFiles, setRepoFiles] = useState<RepoFile[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [listing, setListing] = useState(false);
  const [repoTruncated, setRepoTruncated] = useState<number | null>(null);
  const [error, setError] = useState("");
  /**
   * The path awaiting confirmation, or null. ⚠ A TWO-STEP CONFIRM RATHER THAN A `confirm()` DIALOG:
   * this is a team's work, any member may remove any file (see the service route), and the row itself
   * is where the participant can see WHOSE file it is and WHEN it changed before deciding. A modal
   * would cover exactly that context.
   */
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const res = await api.docsList();
    // `ok: false` covers a transport failure and a shed request alike. Not an error
    // banner: an empty list is the honest rendering of "we could not read it either".
    setFiles(res?.ok && Array.isArray(res.files) ? res.files : []);
    setLoading(false);
  }

  async function remove(path: string) {
    setDeleting(path);
    setError("");
    try {
      const res = await api.docsDelete({ path });
      if (!res?.ok) throw new Error(res?.error || "Delete failed");
      // Collapse the row if it was open — its version list belongs to a file that is gone.
      if (expanded === path) {
        setExpanded(null);
        setVersions([]);
        setContent(null);
        setViewing(null);
      }
      setConfirmingDelete(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(null);
    }
  }

  async function toggle(path: string) {
    if (expanded === path) {
      setExpanded(null);
      setVersions([]);
      setViewing(null);
      setContent(null);
      return;
    }
    setExpanded(path);
    setViewing(null);
    setContent(null);
    const res = await api.docsVersions({ path });
    setVersions(res?.ok && Array.isArray(res.versions) ? res.versions : []);
  }

  async function view(path: string, versionId: string | null) {
    setViewing({ path, versionId });
    setContent(null);
    const res = await api.docsContent({ path, versionId: versionId ?? undefined });
    // Empty string is a legitimate answer for an empty file; null means "failed".
    setContent(res?.ok ? res.content : null);
  }

  /**
   * Push the project's committed `.md` files to the workshop store.
   *
   * ON DEMAND, deliberately. Nothing here watches the filesystem or uploads on commit —
   * a participant's repository is theirs until they choose to publish it, and a
   * background sync would put work in a shared store before they meant to share it.
   *
   * ── NOW TWO STEPS, AND THAT IS THE REPORTED CHANGE ──
   *
   * It used to collect EVERY `.md` in the repo and push all of them on one click. Wrong in both
   * directions: a repo's licence files, dependency READMEs and scratch notes landed in the team's
   * documents, while a participant who wanted to publish one design doc had no way to say so.
   *
   * So: list first (a pure read — nothing leaves the machine), then upload only what was ticked.
   * Opening the list is therefore free and reversible, which is what makes it safe to put a
   * destination-shared action behind one button.
   */
  async function openRepoPicker() {
    setError("");
    setNotice("");
    const projectPath = await api.getSetting("project_path");
    if (!projectPath) {
      setError("No project folder is open — open one in the Code tab first.");
      return;
    }

    setListing(true);
    try {
      const res = await api.gitListUploadable(projectPath);
      const found: RepoFile[] = Array.isArray(res?.files) ? res.files : [];
      setRepoFiles(found);
      setRepoTruncated(res?.truncated ? (res.total ?? found.length) : null);
      /**
       * NOTHING IS PRE-SELECTED. Pre-ticking everything would reproduce the old behaviour for
       * anybody who clicks straight through — the participant has to say what they want published,
       * because publishing puts their work in a store their team and executives read.
       */
      setSelected(new Set());
    } catch (e) {
      // The git handlers REJECT on failure (unlike the docs:* ones, which return {ok:false}), so
      // the message is caught here rather than read off a result object.
      setError(e instanceof Error ? e.message : "Could not list the repository's files");
    } finally {
      setListing(false);
    }
  }

  function toggleSelected(path: string) {
    setSelected((prev) => {
      // A NEW Set, not a mutation: React compares by identity, so mutating in place would not
      // re-render the list.
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function uploadSelected() {
    setError("");
    setNotice("");
    const projectPath = await api.getSetting("project_path");
    if (!projectPath) {
      setError("No project folder is open — open one in the Code tab first.");
      return;
    }

    setSyncing(true);
    try {
      const res = await api.gitUploadSelected({
        repoPath: projectPath,
        paths: [...selected],
      });
      const stored = res?.stored ?? 0;
      const skipped = Array.isArray(res?.skipped) ? res.skipped : [];
      setNotice(
        `Uploaded ${stored} file${stored === 1 ? "" : "s"}` +
          (skipped.length ? ` · ${skipped.length} skipped` : "")
      );
      /**
       * The first skipped REASON is surfaced rather than just a count. "3 skipped" tells a
       * participant nothing actionable; "unsupported file type '.png'" tells them what to do.
       */
      if (skipped.length > 0 && skipped[0]?.reason) {
        setError(`${skipped[0].path}: ${skipped[0].reason}`);
      }
      // Close the picker only on success, so a failure leaves the selection intact to retry.
      setRepoFiles(null);
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setSyncing(false);
    }
  }

  async function upload() {
    setError("");
    setNotice("");
    const chosen = await api.selectUpload();
    if (!chosen?.filePath) return; // cancelled — not an error

    setUploading(true);
    try {
      const res = await api.docsUpload({ filePath: chosen.filePath });
      if (!res?.ok) {
        setError(res?.error || "Upload failed");
        return;
      }
      setNotice(`Uploaded ${res.path}`);
      await load();
    } finally {
      setUploading(false);
    }
  }

  const sizeLabel = (bytes: number) =>
    bytes > 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : bytes > 1024
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${bytes} B`;

  return (
    <div className="mt-4 border-t border-surface-line pt-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h4 className="text-sm font-semibold text-surface-text">Team documents</h4>
          <p className="text-xs text-surface-muted">
            Files you choose from the repo, or upload by hand, with full version history.
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          {/* Opens a PICKER rather than uploading. Listing is a pure read, so this button
              publishes nothing on its own — see openRepoPicker. */}
          <button
            type="button"
            onClick={openRepoPicker}
            disabled={syncing || uploading || listing}
            title="Choose files from this project to publish to the experience"
            className="rounded-md border border-surface-line px-3 py-1.5 text-xs font-medium text-surface-text hover:bg-surface-raised disabled:opacity-50"
          >
            {listing ? "Reading repo…" : "☁ Choose from repo"}
          </button>
          <button
            type="button"
            onClick={upload}
            disabled={uploading || syncing}
            title={`Upload a document (${ALLOWED}, max ${MAX_MB}MB)`}
            className="rounded-md border border-surface-line px-3 py-1.5 text-xs font-medium text-surface-text hover:bg-surface-raised disabled:opacity-50"
          >
            {uploading ? "Uploading…" : "⬆ Upload file"}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mb-2 break-words text-xs text-tool-error-text">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-2 text-xs text-tool-ok">
          {notice}
        </p>
      )}

      {/**
        * ── THE REPO PICKER ──
        *
        * Rendered only while open (`repoFiles !== null`), so an empty array is a real answer — "this
        * repo has no uploadable files" — and distinct from "the picker is closed".
        *
        * Inline rather than a modal: the participant is comparing this list against the documents
        * ALREADY published below it, and a modal would cover exactly the thing they need to see to
        * decide.
        */}
      {repoFiles !== null && (
        <div className="mb-3 rounded-md border border-surface-line bg-surface-panel p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-surface-text">
                Files in this project ({repoFiles.length})
              </p>
              <p className="text-[11px] text-surface-muted">
                Only {ALLOWED} can be published. Nothing is uploaded until you press Publish.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setRepoFiles(null);
                setSelected(new Set());
              }}
              className="flex-shrink-0 text-xs text-surface-muted hover:text-surface-text"
            >
              Cancel
            </button>
          </div>

          {/* Says WHAT was dropped rather than silently showing a prefix. A truncated list that
              looks complete is how somebody concludes a file is missing from their repo. */}
          {repoTruncated !== null && (
            <p className="mb-2 text-[11px] text-tool-warning">
              Showing the first {repoFiles.length} of {repoTruncated} files. Narrow the project
              folder if the one you want is not listed.
            </p>
          )}

          {repoFiles.length === 0 ? (
            <p className="text-xs italic text-surface-muted">
              No {ALLOWED} files found in this project (excluding node_modules, dist and .git).
            </p>
          ) : (
            <>
              <div className="mb-2 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setSelected(new Set(repoFiles.map((f) => f.path)))}
                  className="text-[11px] text-brand-accent hover:underline"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="text-[11px] text-brand-accent hover:underline"
                >
                  Clear
                </button>
                <span className="text-[11px] text-surface-muted">{selected.size} selected</span>
              </div>

              {/* Bounded height with its own scroll: a 500-file list must not push the published
                  documents off the screen. */}
              <div className="max-h-56 divide-y divide-surface-line overflow-y-auto rounded border border-surface-line bg-surface-panel">
                {repoFiles.map((f) => (
                  <label
                    key={f.path}
                    className="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-surface-raised"
                  >
                    {/* A real checkbox inside a <label>, so the whole row is a hit target and the
                        control is reachable by keyboard and announced by a screen reader. */}
                    <input
                      type="checkbox"
                      checked={selected.has(f.path)}
                      onChange={() => toggleSelected(f.path)}
                      className="flex-shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-surface-text">
                      {f.path}
                    </span>
                    <span className="flex-shrink-0 text-[10px] text-surface-muted">
                      {sizeLabel(f.sizeBytes)}
                      {/* "not committed" is the honest label for an untracked file, and it is
                          probably the most likely thing somebody wants to publish. */}
                      {f.lastAuthor ? ` · ${f.lastAuthor}` : " · not committed"}
                    </span>
                  </label>
                ))}
              </div>

              <button
                type="button"
                onClick={uploadSelected}
                disabled={syncing || selected.size === 0}
                className="mt-2 rounded-md bg-brand-strong px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-accent hover:text-surface-bg disabled:opacity-50"
              >
                {syncing
                  ? "Publishing…"
                  : `Publish ${selected.size} file${selected.size === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-surface-muted">Loading documents…</p>
      ) : files.length === 0 ? (
        <div className="rounded-md border border-dashed border-surface-line p-4 text-center">
          <p className="text-xs text-surface-muted">
            No documents yet. Commit your work, then use{" "}
            <span className="font-medium">Sync from repo</span> above — or upload a file
            directly. Nothing is sent to the workshop until you ask.
          </p>
          <p className="mt-1 text-[11px] text-surface-muted">
            Allowed: {ALLOWED} · up to {MAX_MB}MB
          </p>
        </div>
      ) : (
        <div className="divide-y divide-surface-line rounded-lg border border-surface-line">
          {files.map((f) => {
            const isOpen = expanded === f.path;
            return (
              <div key={f.path}>
                <button
                  type="button"
                  onClick={() => toggle(f.path)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-raised"
                >
                  <span className="text-xs text-surface-muted">{isOpen ? "▾" : "▸"}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-surface-text">{f.path}</span>
                  {/* The RESOLVED name when the service could look it up, else the raw value. An
                      uploaded file stores a Cognito sub, which is what displayed before. */}
                  {(f.lastAuthorName ?? f.lastAuthor) && (
                    <span className="max-w-[120px] truncate text-[11px] text-surface-muted">
                      {f.lastAuthorName ?? f.lastAuthor}
                    </span>
                  )}
                  {f.updatedAt && (
                    <span className="flex-shrink-0 text-[11px] text-surface-muted">
                      {new Date(f.updatedAt).toLocaleDateString()}
                    </span>
                  )}
                </button>

                {/*
                  ── ⚠ REMOVE, OUTSIDE THE ROW BUTTON ─────────────────────────────────────────────
                  "users should be able to delete file which they have uploaded in build".

                  ⚠ A SIBLING OF THE ROW BUTTON, NEVER NESTED INSIDE IT. The row is a <button> that
                  expands the file; a button inside a button is invalid HTML and browsers resolve it by
                  dropping one — so a nested Remove would either not fire or would also toggle the row.

                  ⚠ AND IT CONFIRMS IN PLACE. Any team member may remove any of the team's files (see
                  the route's note on why "only my own" is not expressible), so the click needs a second
                  step — and it belongs HERE, in the row, where the author and the date are visible. A
                  modal would cover the very context needed to decide.
                */}
                <div className="flex items-center justify-end gap-2 px-3 pb-2">
                  {confirmingDelete === f.path ? (
                    <>
                      <span className="mr-auto text-[11px] text-surface-muted">
                        Remove this file from the team&apos;s list?
                      </span>
                      <button
                        type="button"
                        onClick={() => setConfirmingDelete(null)}
                        className="rounded border border-surface-line px-2 py-0.5 text-[11px] text-surface-text hover:bg-surface-raised"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(f.path)}
                        disabled={deleting === f.path}
                        className="rounded bg-tool-error px-2 py-0.5 text-[11px] text-white disabled:opacity-50"
                      >
                        {deleting === f.path ? "Removing…" : "Remove"}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(f.path)}
                      className="text-[11px] text-surface-muted hover:text-tool-error-text"
                    >
                      Remove
                    </button>
                  )}
                </div>

                {isOpen && (
                  <div className="bg-surface-panel px-3 pb-3">
                    {/* Version history. S3 keeps every version of the key, so a team can
                        see how a document changed across syncs. */}
                    <div className="mb-1 text-[11px] font-medium text-surface-muted">
                      Versions ({versions.length})
                    </div>
                    <div className="space-y-1">
                      {versions.length === 0 && (
                        <p className="text-[11px] text-surface-muted">No version history available.</p>
                      )}
                      {versions.map((v) => (
                        <div key={v.versionId} className="flex items-center gap-2 text-[11px]">
                          <button
                            type="button"
                            onClick={() => view(f.path, v.isLatest ? null : v.versionId)}
                            className="text-brand-accent hover:underline"
                          >
                            {v.isLatest ? "latest" : v.versionId.slice(0, 8)}
                          </button>
                          <span className="text-surface-muted">
                            {v.lastModified ? new Date(v.lastModified).toLocaleString() : ""}
                          </span>
                          <span className="ml-auto text-surface-muted">{sizeLabel(v.size)}</span>
                        </div>
                      ))}
                    </div>

                    {viewing?.path === f.path && (
                      <div className="mt-2">
                        {content === null ? (
                          <p className="text-[11px] text-surface-muted">Loading…</p>
                        ) : (
                          // Rendered as PLAIN TEXT, never as markdown or HTML. These are
                          // participant-authored files in a shared store, and one of the
                          // permitted types IS html — rendering it here would execute
                          // someone else's markup inside the app.
                          <pre className="max-h-64 overflow-x-auto whitespace-pre-wrap rounded border border-surface-line bg-surface-bg p-3 text-[11px] text-surface-text">
                            {content || "(empty file)"}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
