"use client";

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { SessionExpiredNotice, ContentLoadError } from "@/components/TeamContentNotice";
import { isUnauthorized } from "@/lib/trpc/errors";

/**
 * THE TEAM'S FILES AND WHO WROTE THEM, rendered inside a workshop phase.
 *
 * ── WHY THIS IS NOT A TAB ──
 *
 * It used to be: a top-level "Code" tab with three sub-tabs (Docs, Commits, Contributors). The
 * tab is gone, and this is where its two surviving halves live.
 *
 * The Code tab was wrong in two ways at once. It was named for source code but the only real
 * content it ever showed was documents, `git.getFiles` is stats-only, so the Docs sub-tab was
 * already reading the docs service. And its other two sub-tabs were built on git commit
 * analysis, which was cut from this platform: the insights page deliberately excludes commits,
 * and its copy carries a note about not naming a source the model never reads. A tab whose
 * headline numbers came from a dropped feature was going to keep making that same claim.
 *
 * Files belong to the phase in which they are produced, so they are rendered there. Attaching
 * them to a phase also gives the reader something the flat list could not: WHEN, relative to
 * the work.
 *
 * ── CONTRIBUTORS WITHOUT COMMITS ──
 *
 * The old rollup counted commits, additions and deletions per git author. None of that survives
 * without commit analysis, so this counts DOCUMENTS per author, the artefacts a team actually
 * produced, and says so in the column heading. It is deliberately not a leaderboard: no bars,
 * no ranking of people by volume, because the number of files someone touched is not a measure
 * of contribution and the insights page is where per-member assessment is published, under a
 * documented methodology and an executive-only rule.
 *
 * `lastAuthor` is the LAST person to write each document, which is the only attribution the docs
 * service stores, so a file edited by three people credits one. The heading says "last edited
 * by" rather than "author" for exactly that reason; a fuller answer needs per-version authorship
 * the store does not currently keep.
 *
 * ⚠ THAT FIELD HOLDS TWO KINDS OF VALUE, which is why every read here prefers `lastAuthorName`.
 * A hand-uploaded file stores the caller's Cognito SUB; a git-synced one stores a git author NAME.
 * The service resolves the former against its users read-model and sends `lastAuthorName` only when
 * it succeeded, so the fallback chain is name, then raw value, then "unknown". Reading `lastAuthor`
 * alone is what showed `94c89498-90e1-7070-dd34-b71a17076f4c` on screen.
 */

/**
 * Per-author document rollup.
 *
 * The document shape itself is NOT redeclared here: `trpc.docs.list` already returns a typed
 * DocPointer, and a local copy would be a second definition to keep in step with the router's -
 * silently diverging the first time the service adds a field.
 */
interface Contributor {
  author: string;
  docs: number;
  /** Most recent `updatedAt` across this author's documents, for ordering. */
  latest: string;
}

export function PhaseArtifacts({ teamId }: { teamId: string }) {
  const filesQuery = trpc.docs.list.useQuery({ teamId });
  const { data: files, isLoading } = filesQuery;
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const contributors = useMemo(() => {
    if (!files) return undefined;
    const byAuthor = new Map<string, Contributor>();
    for (const file of files) {
      /**
       * PREFER THE RESOLVED NAME, then the raw value, then an explicit label.
       *
       * Keying on the raw id would give one person TWO rows when some of their files were uploaded
       * (a Cognito sub) and others git-synced (a git name), and one of the two rows would be a uuid.
       *
       * An unattributed document is still counted, under a stated label: dropping it would make the
       * totals disagree with the file list above for no reason a reader could see.
       */
      const author = file.lastAuthorName ?? file.lastAuthor ?? "Unattributed";
      const entry = byAuthor.get(author) ?? { author, docs: 0, latest: "" };
      entry.docs += 1;
      if (file.updatedAt > entry.latest) entry.latest = file.updatedAt;
      byAuthor.set(author, entry);
    }
    // Most recently active first, a reading order, not a ranking by volume.
    return [...byAuthor.values()].sort((a, b) => b.latest.localeCompare(a.latest));
  }, [files]);

  if (isLoading) {
    return (
      <p className="text-sm text-ink-tertiary animate-pulse">Loading this team&apos;s files…</p>
    );
  }

  /**
   * NO MEMBER-ONLY BRANCH HERE, and that is not an omission.
   *
   * This renders inside the phases page, which has already taken the membership, expired-session
   * and failure branches for `phase.listForTeam`, a refused caller never reaches this component.
   * A genuine fault on THIS query is still reported, scoped to this panel, because the phase
   * notes around it loaded fine and blanking them would hide working content.
   */
  /**
   * ⚠ AN EXPIRED LOGIN IS NOT A FAILED LOAD, and this is the same gap that was reported on the AI
   * conversation pane: "Couldn't load … Backend error: 401" for what is only an expired session, complete with
   * an invitation to report it as a bug. `isUnauthorized` is the shared decision, see `lib/trpc/errors.ts`.
   */
  if (filesQuery.error) {
    if (isUnauthorized(filesQuery.error)) {
      return <SessionExpiredNotice what="this team's files" />;
    }
    return (
      <ContentLoadError
        what="this team's files"
        detail={filesQuery.error.message}
        onRetry={() => filesQuery.refetch()}
        headingLevel={4}
      />
    );
  }

  if (!files || files.length === 0) {
    return (
      <p className="text-sm text-ink-tertiary italic">
        No files yet, documents the team creates or uploads in the desktop app appear here.
      </p>
    );
  }

  if (selectedFile) {
    return (
      <DocViewer
        teamId={teamId}
        path={selectedFile}
        onBack={() => setSelectedFile(null)}
      />
    );
  }

  return (
    <div className="space-y-5">
      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle mb-2">
          Files ({files.length})
        </h4>
        <div className="border rounded-lg divide-y bg-surface-3">
          {files.map((file) => (
            <button
              key={file.path}
              onClick={() => setSelectedFile(file.path)}
              className="w-full text-left px-4 py-3 hover:bg-surface-1 flex items-center justify-between group"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-ink-tertiary flex-shrink-0" aria-hidden="true">
                  📄
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-ink-muted truncate">
                    {file.path}
                  </div>
                  <div className="text-xs text-ink-tertiary mt-0.5">
                    {/* The commit hash that used to sit here is gone with commit analysis. Who
                        last edited it and when is what a reader of a document needs. */}
                    Last edited by {file.lastAuthorName ?? file.lastAuthor ?? "unknown"}
                    {file.updatedAt && ` · ${new Date(file.updatedAt).toLocaleString()}`}
                  </div>
                </div>
              </div>
              <span className="text-xs text-ink-tertiary group-hover:text-brand transition-colors flex-shrink-0">
                View &rarr;
              </span>
            </button>
          ))}
        </div>
      </section>

      {contributors && contributors.length > 0 && (
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle mb-2">
            Contributors ({contributors.length})
          </h4>
          <div className="border rounded-lg divide-y bg-surface-3">
            {contributors.map((c) => (
              <div
                key={c.author}
                className="px-4 py-2.5 flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-7 h-7 rounded-full bg-brand-subtle flex items-center justify-center text-brand-text text-xs font-bold flex-shrink-0">
                    {c.author.charAt(0).toUpperCase()}
                  </div>
                  <span className="text-sm text-ink-muted truncate">{c.author}</span>
                </div>
                <span className="text-xs text-ink-subtle flex-shrink-0">
                  last edited {c.docs} file{c.docs === 1 ? "" : "s"}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * One document's content, with a dropdown to browse S3 object versions. Moved from the retired
 * Code tab unchanged in behaviour, including the distinction its comment records: a FAILED
 * content fetch must not render as "No content.", because that reports a document which would
 * not load as a blank one, and an older revision that has gone as an empty revision.
 */
function DocViewer({
  teamId,
  path,
  onBack,
}: {
  teamId: string;
  path: string;
  onBack: () => void;
}) {
  const [versionId, setVersionId] = useState<string | undefined>(undefined);

  const { data: versions } = trpc.docs.versions.useQuery({ teamId, path });
  const contentQuery = trpc.docs.content.useQuery({ teamId, path, versionId });
  const { data: doc, isLoading } = contentQuery;

  return (
    <div>
      <button
        onClick={onBack}
        className="text-sm text-brand-text hover:underline mb-3"
      >
        &larr; Back to files
      </button>
      <div className="flex items-center justify-between mb-3 gap-3">
        <span className="text-sm font-mono text-ink-subtle truncate">{path}</span>
        <div className="flex items-center gap-3 flex-shrink-0">
          {(doc?.lastAuthorName || doc?.lastAuthor) && (
            <span className="text-xs text-ink-tertiary">
              Last edited by {doc.lastAuthorName ?? doc.lastAuthor}
            </span>
          )}
          {versions && versions.length > 0 && (
            <select
              value={versionId ?? ""}
              onChange={(e) => setVersionId(e.target.value || undefined)}
              className="text-xs border rounded-md px-2 py-1 text-ink-subtle bg-surface-3"
              aria-label="Document version"
            >
              <option value="">Latest</option>
              {versions.map((v) => (
                <option key={v.versionId} value={v.versionId}>
                  {new Date(v.lastModified).toLocaleString()}
                  {v.isLatest ? " (latest)" : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="bg-surface-3 border rounded-lg p-6">
        {isLoading ? (
          <div className="text-center text-ink-tertiary animate-pulse">Loading…</div>
        ) : contentQuery.error ? (
          /* Same branch as the file list above, an expired session is not a missing document. */
          isUnauthorized(contentQuery.error) ? (
            <SessionExpiredNotice what="this document" />
          ) : (
            <ContentLoadError
              what="this document"
              detail={contentQuery.error.message}
              onRetry={() => contentQuery.refetch()}
              headingLevel={4}
            />
          )
        ) : (
          <pre className="whitespace-pre-wrap text-sm text-ink-muted font-sans leading-relaxed">
            {doc?.content ?? "No content."}
          </pre>
        )}
      </div>
    </div>
  );
}
