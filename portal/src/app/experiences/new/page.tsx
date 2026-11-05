"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { trpc } from "@/lib/trpc/client";
import { ASSISTANTS, ASSISTANT_IDS, type AssistantId ,
  FIXED_PHASE_PIPELINE,
} from "@praimana/shared";
import { AppHeader } from "@/components/AppHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { FormSection } from "@/components/form/FormSection";
import { Field, controlClass } from "@/components/form/Field";
import { FormatSelect } from "@/components/form/FormatSelect";
import { TeamSizeRange } from "@/components/form/TeamSizeRange";
import { AssistantPicker } from "@/components/form/AssistantPicker";
import { AdvancedDisclosure } from "@/components/form/AdvancedDisclosure";

/**
 * Where "Back" (i.e. abandon) goes. The create form is reached from the workshops
 * dashboard's empty state and from the Administration screen's Experiences tab, and
 * an admin who cancels should land back in the list they were looking at.
 *
 * Matched against a closed set rather than following a `?returnTo=<path>`: a path
 * from the query string rendered into an href is an open-redirect vector. Anything
 * unrecognised falls back to the dashboard.
 *
 * NOTE this is only the CANCEL path. A successful create navigates to the new
 * workshop itself, which is where the user needs to be next whichever screen they
 * started from, there is nothing to review in a list they have just added to.
 */
const CANCEL_TARGETS: Record<string, { href: string; label: string }> = {
  admin: { href: "/admin?tab=experiences", label: "Experiences" },
};
const DEFAULT_CANCEL = { href: "/experiences", label: "experiences" };

// useSearchParams needs a Suspense boundary to prerender, same shape as
// app/experiences/[id]/page.tsx and app/admin/page.tsx.
export default function NewWorkshopPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <div className="animate-pulse text-ink-tertiary">Loading...</div>
        </div>
      }
    >
      <NewWorkshopPageInner />
    </Suspense>
  );
}

function NewWorkshopPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const cancel = CANCEL_TARGETS[searchParams.get("from") ?? ""] ?? DEFAULT_CANCEL;
  const setPhases = trpc.workshop.setPhases.useMutation();

  const createWorkshop = trpc.workshop.create.useMutation({
    onSuccess: async (workshop) => {
      if (phases.length > 0) {
        await setPhases.mutateAsync({ workshopId: workshop.id, phases });
      }
      router.push(`/experiences/${workshop.id}`);
    },
  });

  /**
   * The setup config to submit, or undefined when there is genuinely nothing to send.
   *
   * One free-text field now: the natural-language instructions the AI coding assistant follows to
   * perform the initial project setup on the desktop app. An empty box sends nothing (the service
   * persists `body.setupConfig || null`), so an experience with no setup instructions simply has no
   * `setupConfig`.
   */
  function getSetupConfigObject() {
    const instructions = setupConfig.instructions.trim();
    if (!instructions) return undefined;
    return { instructions };
  }

  // Format options come through tRPC like every other call on this page.
  //
  // This was a raw `fetch(NEXT_PUBLIC_BACKEND_URL + "/v1/lookup/formats")` and COULD
  // NOT WORK in a deployed browser: that env var is set nowhere in the repo, so it fell
  // back to http://localhost:4000. Worse, the `.catch(() => setFormats([]))` turned the
  // failure into an empty list, so the form rendered a blank-but-functional-looking
  // <select> instead of surfacing an error, the reported bug. The backend route also
  // calls requireIdentity, so an unauthenticated browser fetch would have 401'd anyway;
  // going through tRPC attaches the caller's token server-side.
  const formatsQuery = trpc.workshop.formats.useQuery(undefined, {
    // Reference data: it changes when someone seeds the table, not during a session.
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const formats = formatsQuery.data ?? [];
  const formatsLoading = formatsQuery.isPending;

  /**
   * ── ⚠ THE PIPELINE IS FIXED, AND IS NO LONGER STATE ────────────────────────────────────────
   *
   * THE RULE: the phases of a new experience are neither editable nor removable.
   *
   * It was `useState` seeded with the three names and driven by `PhasePipelineEditor` (rename, reorder,
   * add, remove). That editor is DELETED, see the note where it used to be rendered, and the value now
   * comes straight from `FIXED_PHASE_PIPELINE`, so the form cannot send anything else and there is no
   * setter for a future edit to reach for.
   *
   * Spread into a mutable array only because `setPhases`'s zod input is not `readonly`.
   */
  const phases = [...FIXED_PHASE_PIPELINE];

  const [setupConfig, setSetupConfig] = useState({
    /*
      ── THE DEVELOPER SETUP INSTRUCTIONS ──

      A single free-text field: natural-language steps the AI coding assistant follows to perform the
      initial project setup on the desktop app when a participant starts working. The desktop app
      injects this verbatim (sanitised and fenced) into the assistant's setup prompt, there is no repo
      download, branch, guide URL, or per-assistant override any more.

      Starts EMPTY: an experience has no automated setup unless the operator writes some. The textarea
      shows a placeholder as a hint, which is not persisted. An empty box sends no setupConfig.
    */
    instructions: "",
  });
  const [showSetupConfig, setShowSetupConfig] = useState(false);

  const [form, setForm] = useState({
    name: "",
    description: "",
    format: "",
    // Held as <input type="datetime-local"> strings ("2026-08-04T09:00"), which have NO
    // timezone, and converted to a real ISO instant on submit. Empty means "not chosen"
    // and is what the blocker list below refuses, these are required.
    startsAtLocal: "",
    endsAtLocal: "",
    maxTeamSize: 6,
    minTeamSize: 3,
  });

  // Assistant catalog is defined once in @praimana/shared (D6).
  const ALL_ASSISTANTS = ASSISTANTS;
  const [enabledAssistants, setEnabledAssistants] = useState<AssistantId[]>([
    ...ASSISTANT_IDS,
  ]);

  function toggleAssistant(id: AssistantId) {
    setEnabledAssistants((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    );
  }

  // ── VALIDATION, DERIVED ─────────────────────────────────────────────────────
  //
  // Derived rather than held in state: a useState copy of a validity flag is a second
  // source of truth that goes stale the moment someone edits a field without triggering
  // the setter. These recompute on every render, which is free at this scale.

  const teamSizeInverted = form.minTeamSize > form.maxTeamSize;

  // Dates, derived like every other check on this form.
  //
  // A <input type="datetime-local"> value carries NO timezone ("2026-08-04T09:00"), so it
  // is converted to a real instant with `new Date(...)`, which interprets it in the
  // BROWSER's zone, i.e. the zone the facilitator typed it in. That is the correct reading
  // of "the experience starts at 9am": 9am where the person scheduling it is.
  const startsAtIso = form.startsAtLocal
    ? new Date(form.startsAtLocal).toISOString()
    : "";
  const endsAtIso = form.endsAtLocal ? new Date(form.endsAtLocal).toISOString() : "";
  // EQUAL is allowed, a zero-length experience is odd, not incoherent, and refusing it
  // would be inventing a policy nobody stated. Only genuinely inverted is refused.
  const datesInverted =
    !!startsAtIso && !!endsAtIso && new Date(endsAtIso) < new Date(startsAtIso);

  // WHAT IS BLOCKING SUBMISSION, in the operator's words, as a LIST.
  //
  // The old button was disabled on three separate conditions and explained none of them -
  // a dead control with no stated reason. Each blocker names where it lives so it is
  // findable without hunting, and `focus` lets submit jump to the first offending control.
  const blockers: { label: string; focus?: string }[] = (
    [
      !form.name.trim() && { label: "Give the experience a name", focus: "name" },
      !form.description.trim() && {
        label: "Add a description",
        focus: "description",
      },
      !form.format && { label: "Choose a format", focus: "format" },
    !form.startsAtLocal && { label: "Set a start date", focus: "startsAt" },
    !form.endsAtLocal && { label: "Set an end date", focus: "endsAt" },
    datesInverted && {
      label: "Fix the dates: the end must be on or after the start",
      focus: "endsAt",
    },
      teamSizeInverted && {
        label: "Fix the team size range: the smallest can't exceed the largest",
        focus: "minTeamSize",
      },
      enabledAssistants.length === 0 && {
        label: "Enable at least one AI assistant",
      },
    ] as ({ label: string; focus?: string } | false | null)[]
  ).filter(Boolean) as { label: string; focus?: string }[];

  // ⚠ NO `noPhases` BRANCH ANY MORE. It guarded a state the form could reach when phases were editable
  // and removable; `FIXED_PHASE_PIPELINE` has three entries and no setter, so "no phases" is now
  // unreachable from here. Keeping the branch would be dead code that reads as a live possibility.

  const submitting = createWorkshop.isPending || setPhases.isPending;

  // NO auto-select of formats[0]. Options arrive alphabetically (the backend Queries
  // ScanIndexForward on `name`), so "first" is an accident of labelling, not a sensible
  // default, it would silently pre-pick "Accelerator" and let someone create a
  // mislabelled experience by never touching the field. `format` starts "" and the
  // placeholder option below keeps the <select> in an explicitly unchosen state, which
  // `required` then enforces.

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // ONE gate, on the derived blocker list, so the button's disabled state and the submit
    // guard can never disagree about what "valid" means, they read the same array. This
    // subsumes the earlier `!form.format` early-return: the service DEFAULTS a missing
    // format to "WORKSHOP" rather than rejecting it, so submitting "" would have created an
    // experience with a format nobody chose. Now it is listed and explained instead.
    if (blockers.length > 0) {
      const target = blockers.find((b) => b.focus)?.focus;
      if (target) document.getElementById(target)?.focus();
      return;
    }

    const setupCfg = getSetupConfigObject();
    // The *Local fields are form state, not API fields: strip them and send the ISO
    // instants the schema expects.
    const { startsAtLocal: _s, endsAtLocal: _e, ...fields } = form;
    createWorkshop.mutate({
      ...fields,
      startsAt: startsAtIso,
      endsAt: endsAtIso,
      enabledAssistants,
      setupConfig: setupCfg,
    });
  }

  return (
    <div className="min-h-screen flex flex-col bg-surface-1">
      <AppHeader />

      <header className="border-b bg-surface-3 px-6 py-4">
        <div className="w-full mx-auto max-w-3xl">
          <Link
            href={cancel.href}
            className="text-sm text-ink-subtle hover:text-ink focus:outline-none focus:ring-2 focus:ring-brand rounded"
          >
            ← Back to {cancel.label}
          </Link>
          <h1 className="mt-2 text-xl font-bold text-brand-text">
            Create Experience
          </h1>
          {/* Says what the screen is FOR. Four sections is more structure than the old
              form had, and one line of orientation is what makes that structure legible
              instead of merely present. */}
          <p className="mt-0.5 text-sm text-ink-subtle">
            Set up a workshop: what it&apos;s called, how it runs, and what tooling
            teams get.
          </p>
        </div>
      </header>

      {/* pb-0: the sticky action bar supplies the bottom spacing, so there is no dead
          gap between the last section and the bar. */}
      <main className="flex-1 w-full max-w-3xl mx-auto px-6 py-8 pb-0">
        {/* noValidate: the browser's own bubble ("Please select an item in the list")
            appears at an arbitrary position, disappears on click and is unreadable by
            assistive tech. The blocker list below is the single, persistent, accessible
            replacement, and it is the same list handleSubmit gates on. */}
        <form onSubmit={handleSubmit} noValidate className="space-y-5">
          {/* ── (1) BASICS ─────────────────────────────────────────────────── */}
          <FormSection
            id="basics"
            step={1}
            title="Basics"
            description="The name and description teams, judges and executives will see."
          >
            <div className="space-y-5">
              <Field
                id="name"
                label="Experience name"
                hint="Shown on the experience card and in every list."
                labelAside={
                  /* A counter, not a silent maxLength. tabular-nums so the digits do not
                     shift the label row as the count climbs past 9 and 99. */
                  <span className="text-xs tabular-nums text-ink-subtle">
                    {form.name.length}/100
                  </span>
                }
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    maxLength={100}
                    aria-describedby={describedBy}
                    autoComplete="off"
                    className={controlClass()}
                    placeholder="e.g. AI Innovation Sprint Q3"
                    required
                  />
                )}
              </Field>

              <Field
                id="description"
                label="Description"
                hint="What teams will build and what a good outcome looks like."
                labelAside={
                  <span className="text-xs tabular-nums text-ink-subtle">
                    {form.description.length}/1000
                  </span>
                }
              >
                {({ id, describedBy }) => (
                  <textarea
                    id={id}
                    value={form.description}
                    onChange={(e) =>
                      setForm({ ...form, description: e.target.value })
                    }
                    maxLength={1000}
                    aria-describedby={describedBy}
                    className={`${controlClass()} min-h-[96px] resize-y`}
                    placeholder="Describe the goals and what teams will build…"
                    required
                  />
                )}
              </Field>

              <Field
                id="format"
                label="Format"
                hint="How the experience runs. Set by an administrator; ask if the one you need is missing."
              >
                {({ id, describedBy }) => (
                  <FormatSelect
                    id={id}
                    describedBy={describedBy}
                    value={form.format}
                    onChange={(format) => setForm({ ...form, format })}
                    formats={formats}
                    isLoading={formatsLoading}
                    isError={formatsQuery.isError}
                    onRetry={() => formatsQuery.refetch()}
                  />
                )}
              </Field>
            </div>
          </FormSection>

          {/* ── (2) TIMELINE ───────────────────────────────────────────────── */}
          <FormSection
            id="timeline"
            step={2}
            title="Timeline"
            description="The stages teams move through, in order. You'll advance them from the experience page during the event."
            aside={
              <span className="text-xs tabular-nums text-ink-subtle">
                {phases.length} {phases.length === 1 ? "phase" : "phases"}
              </span>
            }
          >
            {/* Dates first: WHEN the experience runs frames the phases that fill it, and
                a facilitator scheduling an event knows the dates before the run sheet.
                Both required, see the blocker list. */}
            <div className="mb-5 grid gap-4 sm:grid-cols-2">
              <Field
                id="startsAt"
                label="Starts"
                hint="When teams can begin. Your local time."
              >
                {({ id, describedBy }) => (
                  <input
                    id={id}
                    type="datetime-local"
                    value={form.startsAtLocal}
                    onChange={(e) =>
                      setForm({ ...form, startsAtLocal: e.target.value })
                    }
                    aria-describedby={describedBy}
                    className={controlClass()}
                    required
                  />
                )}
              </Field>

              <Field
                id="endsAt"
                label="Ends"
                hint="When judging closes. Must be on or after the start."
                error={
                  datesInverted
                    ? "The end date must be on or after the start date."
                    : null
                }
              >
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    type="datetime-local"
                    value={form.endsAtLocal}
                    onChange={(e) => setForm({ ...form, endsAtLocal: e.target.value })}
                    // Lets the browser refuse an inverted range at the widget level too,
                    // so the operator is stopped at the field rather than at submit. The
                    // derived check above remains the gate, `min` is a convenience and a
                    // client-side one at that.
                    min={form.startsAtLocal || undefined}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    className={controlClass(!!invalid)}
                    required
                  />
                )}
              </Field>
            </div>

            {/*
              ── ⚠ READ-ONLY. `PhasePipelineEditor` IS DELETED, NOT DISABLED ────────────────────
              The phases are neither editable nor removable.

              A 313-line editor with rename, reorder, add and remove used to sit here. Deleted rather
              than left disabled or left unused, for the reason the AI service gives about its withdrawn
              model port: a wired-but-unreferenced control is an invitation, and this one had two ways to
              cause permanent damage.

              ⚠ WHY IT COULD NOT STAY, EVEN DISABLED. Phases are IMMUTABLE once created, the service
              refuses every later change with `PHASES_IMMUTABLE`, because phase ids key every team's
              notes and appear in released submission snapshots. So the editor offered a permanent,
              uncorrectable choice. And the platform DEPENDS on these names: the Demo phase's two URL
              fields are keyed on "demo", the documents panel is found by "build". Renaming Build to
              "Development" silently removed the file panel. It was offering to break the product.

              Rendered in the same chip-and-arrow vocabulary the experience page's Phases tab uses, so a
              facilitator recognises on the create form what they will later operate.
            */}
            <ol
              aria-describedby="timeline-note"
              className="flex flex-wrap items-center gap-2"
            >
              {phases.map((phase, i) => (
                <li key={phase.name} className="flex items-center gap-2">
                  <span className="rounded-full border bg-surface-1 px-3 py-1 text-sm font-medium text-ink-muted">
                    <span className="mr-1.5 text-xs text-ink-tertiary">{i + 1}</span>
                    {phase.name}
                  </span>
                  {/* `aria-hidden`: the <ol> already conveys the order to assistive tech, and an arrow
                      read aloud between every chip is noise. */}
                  {i < phases.length - 1 && (
                    <span aria-hidden className="text-ink-tertiary">
                      →
                    </span>
                  )}
                </li>
              ))}
            </ol>
            <p id="timeline-note" className="mt-3 text-xs text-ink-subtle">
              {/* ⚠ NO LONGER "Phases can be renamed or reordered later". They cannot, that sentence
                  was already untrue once the service began refusing changes, and it is the kind of
                  untruth a facilitator only discovers when they try. */}
              Every experience runs these three phases. They are fixed: teams&apos; notes and released
              submissions are tied to them, so they cannot be renamed, reordered or removed afterwards.
            </p>
          </FormSection>

          {/* ── (3) TEAM SIZE ──────────────────────────────────────────────── */}
          <FormSection
            id="teams"
            step={3}
            title="Team size"
            description="The bounds teams are formed within. You can change these before registration opens."
          >
            <TeamSizeRange
              min={form.minTeamSize}
              max={form.maxTeamSize}
              onChange={({ minTeamSize, maxTeamSize }) =>
                setForm({ ...form, minTeamSize, maxTeamSize })
              }
            />
          </FormSection>

          {/* ── (4) AI ASSISTANTS ──────────────────────────────────────────── */}
          <FormSection
            id="assistants"
            step={4}
            title="AI assistants"
            description="Which coding assistants participants can use in the desktop app."
            aside={
              <span className="text-xs tabular-nums text-ink-subtle">
                {enabledAssistants.length} of {ALL_ASSISTANTS.length} on
              </span>
            }
          >
            <AssistantPicker
              assistants={ALL_ASSISTANTS}
              enabled={enabledAssistants}
              onToggle={toggleAssistant}
              describedBy="assistants-note"
            />
            <p id="assistants-note" className="mt-3 text-xs text-ink-subtle">
              At least one must be on. All three are enabled by default.
            </p>
          </FormSection>

          {/* ── ADVANCED: unnumbered, because it is not a step ─────────────── */}
          <AdvancedDisclosure
            id="setup"
            title="Developer setup"
            summary="Instructions the AI coding assistant follows to set up a participant's project on first open. Optional: leave it blank for no automated setup, and you can add or change this later in Settings."
            open={showSetupConfig}
            onToggle={() => setShowSetupConfig(!showSetupConfig)}
            badge={
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-muted">
                {setupConfig.instructions.trim() ? "Instructions added" : "Optional"}
              </span>
            }
          >
            <div className="space-y-4">
              <Field
                id="setupInstructions"
                label="AI setup instructions"
                hint="Plain-language steps the AI coding assistant performs in the desktop app when a participant starts a project, e.g. install dependencies, scaffold files, verify the build. Leave blank for no automated setup."
              >
                {({ id, describedBy }) => (
                  <textarea
                    id={id}
                    value={setupConfig.instructions}
                    onChange={(e) =>
                      setSetupConfig({
                        ...setupConfig,
                        instructions: e.target.value,
                      })
                    }
                    aria-describedby={describedBy}
                    className={`${controlClass()} min-h-[200px] text-sm leading-relaxed`}
                    placeholder={
                      "e.g. Install dependencies, then verify the build or tests run and report " +
                      "the result. Only run safe, non-destructive commands."
                    }
                  />
                )}
              </Field>
            </div>
          </AdvancedDisclosure>

          {/* ── STICKY ACTION BAR ──────────────────────────────────────────── */}
          {/* sticky, not fixed: it participates in the document flow, so it cannot
              overlap the footer and needs no body padding hack. It is the LAST child of
              the form, so tab order reaches it naturally after the fields. */}
          <div className="sticky bottom-0 -mx-6 border-t border-hairline bg-surface-3/95 px-6 py-4 backdrop-blur">
            {createWorkshop.error && (
              <div
                role="alert"
                className="mb-3 rounded-md border border-danger-border bg-danger-bg px-3 py-2.5"
              >
                <p className="text-sm font-medium text-danger-text">
                  <span aria-hidden="true">✕ </span>
                  The experience wasn&apos;t created.
                </p>
                <p className="mt-0.5 text-sm text-danger-text">
                  {createWorkshop.error.message}
                </p>
                <p className="mt-1 text-xs text-danger-text">
                  Nothing you&apos;ve entered has been lost. Correct the problem
                  above and try again.
                </p>
              </div>
            )}

            {/* setPhases runs AFTER create succeeds, so its failure means the experience
                EXISTS but has no phases. That is a genuinely different outcome from a
                failed create and must not be reported as one, the operator would
                otherwise submit again and get a duplicate workshop. */}
            {setPhases.error && (
              <div
                role="alert"
                className="mb-3 rounded-md border border-warn-border bg-warn-bg px-3 py-2.5"
              >
                <p className="text-sm font-medium text-warn-text">
                  <span aria-hidden="true">⚠ </span>
                  The experience was created, but its phases weren&apos;t saved.
                </p>
                <p className="mt-0.5 text-xs text-warn-text">
                  Don&apos;t submit again: that would create a second experience.
                  Add the phases from the workshop&apos;s Phases tab.
                  {" "}
                  {setPhases.error.message}
                </p>
              </div>
            )}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              {/* WHY the button is disabled, always, rather than a dimmed control with no
                  explanation. aria-live="polite" so a screen-reader user hears the list
                  shrink as they fix things; polite because it is a running status, not an
                  alert, and assertive would interrupt on every keystroke. */}
              {/* max-h + scroll: with all six blockers showing, an unbounded list makes
                  this sticky bar tall enough to swallow a short viewport (a landscape
                  phone, or a laptop at 200% zoom) and hide the very fields it is asking
                  the operator to fix. Bounded here rather than by trimming the list -
                  every blocker still needs to be reachable. */}
              <div
                id="submit-status"
                aria-live="polite"
                className="min-w-0 max-h-32 overflow-y-auto text-sm sm:max-h-40"
              >
                {blockers.length > 0 ? (
                  <>
                    <p className="font-medium text-ink-muted">
                      Before you can create this:
                    </p>
                    <ul className="mt-0.5 space-y-0.5">
                      {blockers.map((b) => (
                        <li
                          key={b.label}
                          className="flex items-start gap-1.5 text-ink-subtle"
                        >
                          <span aria-hidden="true" className="text-ink-tertiary">
                            •
                          </span>
                          <span>{b.label}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="text-ink-subtle">
                    <span aria-hidden="true">✓ </span>
                    Ready to create.{" "}
                    {`Starts as a draft with ${phases.length} phases: ${phases
                      .map((p) => p.name)
                      .join(" → ")}.`}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-3">
                {/* Cancel is a LINK, styled quietly, and placed to the LEFT of the
                    primary action, the same order as every other confirm pair in the
                    app. It abandons unsaved work, so it is deliberately the lower-contrast
                    of the two and is never the Enter-key target. */}
                <Link
                  href={cancel.href}
                  className="rounded-md px-4 py-2.5 text-sm font-medium text-ink-muted hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-brand"
                >
                  Cancel
                </Link>
                <button
                  type="submit"
                  disabled={submitting || blockers.length > 0}
                  /* Ties the button to the reason it is disabled, so the explanation is
                     reachable FROM the control rather than only by reading the page. A
                     disabled button is skipped by most screen-reader element navigation,
                     so without this the reason is effectively unreachable for the users
                     who most need it. */
                  aria-describedby="submit-status"
                  className="rounded-md bg-brand px-5 py-2.5 text-sm font-semibold text-brand-ink transition-colors hover:bg-brand-hover focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-hairline-strong disabled:text-ink-subtle"
                >
                  {submitting ? "Creating…" : "Create experience"}
                </button>
              </div>
            </div>
          </div>
        </form>
      </main>

      <SiteFooter />
    </div>
  );
}
