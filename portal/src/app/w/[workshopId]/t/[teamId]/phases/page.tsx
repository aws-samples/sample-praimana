"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { teamContentGate } from "@/lib/team-content-gate";
import { teamTabHref } from "@/lib/team-routes";
import { PhaseArtifacts } from "@/components/PhaseArtifacts";
import { PhaseNoteBody } from "@/components/PhaseNoteBody";
import { buildPhaseIdFor } from "@/lib/build-phase";
import {
  ContentLoadError,
  MemberOnlyNotice,
  SessionExpiredNotice,
} from "@/components/TeamContentNotice";

interface TeamPhase {
  id: string;
  order: number;
  name: string;
  description: string;
  content: string;
  aiGenerated: boolean;
  editedByName: string | null;
  editedAt: string | null;
}

export default function PhasesPage() {
  const params = useParams();
  const workshopId = params.workshopId as string;
  const teamId = params.teamId as string;

  const { data: workshop } = trpc.workshop.getById.useQuery({ id: workshopId });
  const phasesQuery = trpc.phase.listForTeam.useQuery({ teamId, workshopId });
  const { data, isLoading } = phasesQuery;

  const [expanded, setExpanded] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-ink-tertiary">Loading phases...</div>
      </div>
    );
  }

  /**
   * NOTHING TO SHOW, AND WHY. `phase.listForTeam` returns this team's phase NOTES, content
   * the team wrote or generated, so it becomes member-only even though the
   * phase PIPELINE it hangs on belongs to the workshop.
   *
   * Gated on the phases query only, NOT on `workshop.getById`: the workshop read is a
   * different scope and keeps answering, and it supplies nothing this page can render on its
   * own (it contributes `currentPhaseOrder`, a highlight on a list that would not exist).
   *
   * Before the `phases.length === 0` branch, and for the reason that recurs on every page
   * here: that branch says "No phases defined for this workshop yet", which is a claim about
   * the WORKSHOP's configuration. A refused read would have blamed a facilitator's own setup
   * for a rule about team membership, and sent them to check a pipeline that is fine.
   */
  const gate = teamContentGate([phasesQuery]);
  // SESSION EXPIRED outranks both branches below: a 401 means the server could not
  // evaluate any rule, so "member-only" would be a lie and "failed" blames the data.
  // Providers() is already signing out; this is what renders during that round trip.
  if (gate.state === "expired") {
    return <SessionExpiredNotice what="this team's phases" />;
  }
  if (gate.state === "member-only") {
    return (
      <MemberOnlyNotice
        what="This team's phase notes are visible to its members. The workshop's phase pipeline is on the workshop page."
        teamHref={teamTabHref(workshopId, teamId)}
      />
    );
  }
  if (gate.state === "failed") {
    return (
      <ContentLoadError
        what="this team's phases"
        detail={gate.detail}
        onRetry={gate.retry}
      />
    );
  }

  const phases: TeamPhase[] = data?.phases ?? [];
  if (phases.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-3xl mb-3">📋</p>
          <p className="text-sm text-ink-subtle">No phases defined for this workshop yet.</p>
        </div>
      </div>
    );
  }

  const currentPhaseOrder = workshop?.currentPhaseOrder || 0;
  // Exactly one phase carries the files-and-contributors panel, see build-phase.ts for why this
  // is a name match with a positional fallback, and why it must never resolve to more than one.
  const buildPhaseId = buildPhaseIdFor(phases);

  return (
    <div className="w-full max-w-3xl mx-auto px-6 py-8">
      <h2 className="text-lg font-bold mb-1">Workshop Phases</h2>
      <p className="text-sm text-ink-subtle mb-6">
        Click a phase to view what this team is working on.
      </p>

      <div className="space-y-3">
        {phases.map((phase) => {
          const isCurrent = phase.order === currentPhaseOrder;
          const isCompleted = phase.order < currentPhaseOrder;
          const isUpcoming = phase.order > currentPhaseOrder;
          const isOpen = expanded === phase.id;

          return (
            <div
              key={phase.id}
              className={`rounded-lg border transition-all ${
                isCurrent
                  ? "border-brand-border bg-brand-wash/50 shadow-sm"
                  : isCompleted
                  ? "border-success-border bg-success-bg/40"
                  : "border-hairline bg-surface-3"
              }`}
            >
              <button
                onClick={() => setExpanded(isOpen ? null : phase.id)}
                className="w-full flex items-center gap-3 p-5 text-left"
              >
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${
                    isCurrent
                      ? "bg-brand text-brand-ink"
                      : isCompleted
                      ? "bg-success-text text-brand-ink"
                      : "bg-surface-2 text-ink-subtle"
                  }`}
                >
                  {isCompleted ? "✓" : phase.order}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className={`font-semibold ${isUpcoming ? "text-ink-tertiary" : "text-ink"}`}>
                      {phase.name}
                    </h3>
                    {isCurrent && (
                      <span className="text-xs bg-brand text-brand-ink px-2 py-0.5 rounded-full">Current</span>
                    )}
                    {/*
                      ⚠ NO "Completed" PILL ("pleae remove completed on phases"). The step marker for a
                      completed phase is a ✓ GLYPH where every other phase shows its NUMBER, so the word
                      repeated what the shape already said. "Current" stays: it has no marker of its own
                      and is the only thing distinguishing the live phase from an upcoming one.
                    */}
                    {/*
                      ── ⚠ NO CONTENT BADGE AT ALL, THREE REPORTS, ONE ROOT CAUSE ─────────────────
                      In order: "build still shows empty even when the files are uploaded" → "totally
                      avoid the labels empty" → "remove has notes stuff".

                      The badge read `phase.content`, the phase's NOTES. A team's FILES live in the docs
                      store and are fetched only when a row expands, so uploading a document never
                      touched `content` and Build read "• empty" directly above a panel listing its
                      files.

                      Each fix was right and each was too small, because the problem was the badge
                      itself: `content` answers one narrow question ("did somebody type in the notes
                      box") and the collapsed row was using it to summarise the whole phase. The
                      Current pill and the ✓ marker already say where the experience has got to, and the
                      row expands to show the rest. A second, weaker signal beside them was noise however
                      it was worded.
                    */}
                  </div>
                  {phase.description && (
                    <p className={`text-sm mt-1 ${isUpcoming ? "text-ink-tertiary" : "text-ink-subtle"}`}>
                      {phase.description}
                    </p>
                  )}
                </div>
                <span className="text-ink-tertiary text-sm flex-shrink-0">{isOpen ? "▾" : "▸"}</span>
              </button>

              {isOpen && (
                <div className="border-t px-5 py-4">
                  {/*
                    THE NOTES THEMSELVES, shared with the judge's snapshot view, see
                    `components/PhaseNoteBody.tsx` for why THIS is the extracted seam and the
                    accordion around it is not.

                    ⚠ THE TIMESTAMP CHANGED WITH THE EXTRACTION. This block used to render
                    `new Date(phase.editedAt).toLocaleString()`, which reads a zone-less stored
                    timestamp an hour out in summer, one of the four divergent copies that
                    `constants/message-time.ts` was consolidated to end. It now goes through the
                    shared rule, like every other instant on the platform.
                  */}
                  <PhaseNoteBody
                    note={phase}
                    emptyNote="No notes yet. The team can add or generate them in the desktop app."
                  />

                  {/**
                   * THE TEAM'S FILES, on the build phase and nowhere else.
                   *
                   * Rendered only when this phase is EXPANDED, which is what keeps it honest
                   * about cost: `docs.list` is a real request, and mounting it on every row
                   * would fire it on arrival for a page whose primary content is phase notes.
                   *
                   * Below the notes, not above: the notes are what the phase IS, the files are
                   * what came out of it.
                   */}
                  {phase.id === buildPhaseId && (
                    <div className="mt-6 border-t pt-4">
                      <PhaseArtifacts teamId={teamId} />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
