"use client";

// ── GET THE DESKTOP APP ──────────────────────────────────────────────────────────────────
//
// A compact download + connect card for the pages that are NOT participant onboarding.
//
// ⚠ THE DOWNLOAD USED TO LIVE ONLY ON `/welcome`, WHICH EXECUTIVES NEVER SEE.
// `landingPathForRole` sends PARTICIPANT to `/welcome` and every other role, ADMIN, FACILITATOR,
// EXECUTIVE, JUDGE, to `/experiences`. So an executive had no route to the installer at all: not a
// permissions problem, just a page they are never shown. Reported as "we should also show desktop link
// to executives as well".
//
// ⚠ NOT A COPY OF `/welcome`'s STEPS. That page is onboarding: a join code, three numbered steps, and
// prose written for somebody who has just registered. An executive needs the artefact, not the
// tutorial, so this is one card with the two things that are actually actionable (download, connect)
// and no step numbering to imply a sequence they are partway through.

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";

const PLATFORM_LABELS: Record<string, string> = { macos: "macOS", windows: "Windows" };

/** The installer is a plain browser navigation, a 302 to a presigned URL, not a tRPC call. */
function downloadHref(platform: string): string {
  return `/api/desktop/download?platform=${platform}`;
}

export function DesktopAppCard() {
  /**
   * ── ⚠ THE INSTALLER LOOKUP IS OPT-IN, BECAUSE IT REACHES S3 ──────────────────────────────
   *
   * Collapsed by default, to avoid an unnecessary API call for the S3 download.
   *
   * `desktop.releases` is not a local read: it calls `/v1/desktop/releases`, which lists the shared
   * account's installer bucket through `S3InstallerStore`. That was firing on EVERY `/experiences` load for
   * every executive and participant, a Lambda invoke and an S3 round trip to render a card most of them
   * will never act on, and one which on this deployment currently returns nothing at all because no
   * installer has been published.
   *
   * ⚠ `enabled: showDownloads` IS THE WHOLE POINT, not the collapse. Hiding the markup while still running
   * the query would look tidier and cost exactly the same, the saving is that the request is never made.
   */
  const [showDownloads, setShowDownloads] = useState(false);
  /**
   * ── ⚠ COLLAPSED BY DEFAULT ("can we collapse Get the desktop app") ─────────────────────────
   *
   * This was the tallest block on the experiences list, a heading, a paragraph of explanation, a Connect
   * action and a downloads toggle, for something a person does ONCE and then never again. Everyone who had
   * already installed it read past the whole thing on every visit.
   *
   * ⚠ COLLAPSED, NOT REMOVED, and the difference matters: a participant who has not installed it yet needs
   * to find it, and the summary line says what it is FOR so they can decide to open it. It is also reachable
   * from the profile menu now, which is where somebody looks when they already know they want it.
   */
  const [expanded, setExpanded] = useState(false);
  const { data: releases, isLoading } = trpc.desktop.releases.useQuery(undefined, {
    enabled: showDownloads,
  });
  /**
   * The connect link is best-effort: it throws PRECONDITION_FAILED on a deployment that has not
   * configured its pool ids. That must not blank the download button beside it, so the two are
   * independent queries and the link simply does not render.
   *
   * ⚠ AND IT IS *NOT* GATED ON THE COLLAPSE. It costs no S3 call, and it is the one thing on this card an
   * executive with the app already installed needs, see the note on where it is rendered.
   */
  const { data: desktopLink, isError: linkError } = trpc.desktop.connectLink.useQuery(undefined, {
    retry: false,
  });

  const platforms = releases
    ? (["macos", "windows"] as const).filter((p) => releases[p])
    : [];

  return (
    <section className="rounded-lg border border-hairline bg-surface-3">
      <h2>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls="desktop-app-panel"
          className="flex w-full items-center gap-3 rounded-lg px-5 py-4 text-left hover:bg-surface-1 focus:outline-none focus:ring-2 focus:ring-brand"
        >
          {/*
            A ROTATED caret, not a swapped ▸/▾ glyph, the same idiom as the app's two other disclosures.
            The character swap changes the element's width and nudges the title sideways on every toggle.
          */}
          <span
            aria-hidden="true"
            className={`text-ink-tertiary transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            ▸
          </span>
          <span className="flex-1 font-semibold text-ink">Get the desktop app</span>
          {/* The word that lets a reader skip it in about a second. */}
          <span className="shrink-0 text-xs text-ink-subtle">Optional</span>
        </button>
      </h2>

      {!expanded ? null : (
      <div id="desktop-app-panel" className="px-5 pb-5">
      <p className="mt-1 text-sm text-ink-subtle">
        {/*
          Written for a reader who is not necessarily building: the desktop is where the AI
          assistant and the repo live, and it is optional for them. Saying so is the point, an
          executive who reads the portal should not think they are missing a required step.
        */}
        Optional. The desktop app is where AI chats and code happen; the portal shows you the same
        team workspace, board and transcripts without it.
      </p>

      {/*
        ── ⚠ CONNECT IS FIRST, AND OUTSIDE THE DOWNLOAD BRANCH. ─────────────────────────────────
        Connecting has nothing to do with whether a download exists in a bucket, so it is rendered
        independently of the installer lookup below.

        Run-from-source model: instead of the old praimana:// deep-link button (which depended on OS
        scheme registration, fragile, and wrong for a source zip), this links at the connect.json
        download. The user drops that file next to start.sh and runs it; the app opens on its own
        Connect confirmation screen. Rendered only when the platform's desktop config is set
        (desktopLink built), so a misconfigured deployment shows nothing rather than a broken file.
      */}
      {!linkError && desktopLink?.link && (
        <a
          href="/api/desktop/connect-json"
          download="connect.json"
          className="mt-4 inline-block rounded-md bg-brand px-4 py-2 text-sm font-semibold text-brand-ink transition-colors hover:bg-brand-hover"
        >
          Already installed? Download connect.json
        </a>
      )}

      {/*
        ── ⚠ THE INSTALLER LOOKUP, BEHIND A DISCLOSURE ──────────────────────────────────────────
        Collapsed by default so the S3-backed `releases` query never runs unless somebody asks for a
        download. See the note on `enabled: showDownloads`.

        A plain button rather than <details>, because the query has to be triggered by the state change -
        <details> would toggle visibility without React knowing, and the request would never fire.
      */}
      {!showDownloads ? (
        <button
          onClick={() => setShowDownloads(true)}
          className="mt-3 block text-sm font-medium text-brand-text underline hover:text-brand-text-strong"
        >
          Need the installer? Show downloads
        </button>
      ) : isLoading ? (
        <p className="mt-3 animate-pulse text-sm text-ink-tertiary">Checking for the latest build…</p>
      ) : platforms.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {platforms.map((platform) => (
            <a
              key={platform}
              href={downloadHref(platform)}
              className="inline-block rounded-md border border-brand px-4 py-2 text-sm font-semibold text-brand-text transition-colors hover:bg-brand-subtle"
            >
              Download for {PLATFORM_LABELS[platform] ?? platform}
            </a>
          ))}
        </div>
      ) : (
        <p className="mt-3 rounded-md border border-warn-border bg-warn-bg px-3 py-2 text-sm text-warn-text">
          {/*
            The honest empty state. The installer genuinely may not be published for this deployment,
            and a permanently-disabled button would read as a fault in the reader's own account.
          */}
          No installer has been published for this platform yet. Your facilitator will share it.
        </p>
      )}
      </div>
      )}
    </section>
  );
}
