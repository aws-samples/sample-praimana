"use client";

import { Suspense, useState } from "react";
import { useParams } from "next/navigation";
import { FormatSelect } from "@/components/form/FormatSelect";
import { trpc, type RouterOutputs } from "@/lib/trpc/client";
import type { WorkshopSetupConfig } from "@/lib/backend-types";
import { useSession } from "next-auth/react";
import {
  ASSISTANTS,
  canManageWorkshopSettings,
  type AssistantId,
} from "@praimana/shared";

/** The workshop these two forms edit, derived from the procedure that loads it. Both took
 *  `workshop: any` before the BFF's responses were typed. */
type Workshop = RouterOutputs["workshop"]["getById"];

/* ── ⚠ THE `?from=` RETURN TARGET WAS DELETED WITH THE HEADER THAT USED IT ─────────────────
   A `RETURN_TARGETS` table mapped `?from=<key>` to a path, and `returnTarget()` resolved it, for
   the sole purpose of labelling and pointing the `← Back to …` link that this page no longer
   draws. Nothing else consumed it, saving does not navigate, and there is no Cancel, so it
   became unreachable the moment the header went.

   ⚠ TWO CALLERS STILL APPEND THE PARAMETER AND IT NOW DOES NOTHING:
   `src/app/admin/page.tsx` links to `…/settings?from=admin` and `/experiences/new?from=admin`.
   The consequence is real and worth knowing rather than discovering: an admin who reaches
   Settings from the Administration screen now returns via `ExperienceHeader`'s `← Experiences`,
   which lands on /experiences rather than back on `/admin?tab=experiences`. (The `new` page
   still reads its own copy of `?from=`, so that half is unaffected.)

   The idea it encoded is worth keeping if the path is ever restored: a KEY, never a
   `?returnTo=<path>`, a path taken from the query string and handed to a redirect or an href is
   an open-redirect (or a `javascript:` URL) waiting to happen. */

/* ⚠ THE REASON FOR THIS BOUNDARY IS GONE, AND IT IS KEPT ANYWAY, deliberately, so the next
   reader does not take the stale comment at face value. It said "useSearchParams needs a Suspense
   boundary to prerender", which was true until the `?from=` back link was deleted and
   `useSearchParams` went with it. Nothing in the tree suspends now.

   Kept because it costs one element and it is the boundary any future `useSearchParams` or
   suspending query would otherwise need re-added under pressure, and because the fallback is a
   better first paint than nothing. Same shape as app/experiences/[id]/page.tsx and
   app/admin/page.tsx, which DO still need theirs. */
export default function WorkshopSettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center py-24">
          <div className="animate-pulse text-ink-tertiary">Loading...</div>
        </div>
      }
    >
      <WorkshopSettingsPageInner />
    </Suspense>
  );
}

function WorkshopSettingsPageInner() {
  const params = useParams();
  const { data: session } = useSession();
  const workshopId = params.id as string;

  const { data: workshop, isLoading } = trpc.workshop.getById.useQuery({
    id: workshopId,
  });

  const [settingsSaved, setSettingsSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const utils = trpc.useUtils();

  /**
   * The formats lookup, needed by the details form's Format select. Queried HERE rather than inside
   * the form so the retry handler can reuse the same query instance the select reports errors from.
   */
  const formatsQuery = trpc.workshop.formats.useQuery(undefined, { staleTime: 5 * 60_000 });

  const updateWorkshop = trpc.workshop.update.useMutation({
    onSuccess: () => {
      utils.workshop.getById.invalidate({ id: workshopId });
      setSaveError(null);
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 3000);
    },
    onError: (err) => setSaveError(err.message || "Failed to save."),
  });

  const updateStatus = trpc.workshop.updateStatus.useMutation({
    onSuccess: () => {
      utils.workshop.getById.invalidate({ id: workshopId });
      setSaveError(null);
    },
    onError: (err) => setSaveError(err.message || "Failed to change status."),
  });

  if (isLoading || !workshop) {
    return (
      <div className="flex flex-1 items-center justify-center py-24">
        <div className="animate-pulse text-ink-tertiary">Loading...</div>
      </div>
    );
  }

  const userRole = session?.user?.role;
  const isAdmin = userRole === "ADMIN";
  const isOwner = workshop.ownerId === session?.user?.id;
  // Only the owner/facilitator (or a global ADMIN) may edit, AND only a role that
  // may configure experiences at all. Both halves matter: middleware.ts keeps
  // JUDGE/EXECUTIVE off this route entirely, and the role check here is the same
  // rule so the two cannot disagree if the matcher is ever narrowed. The backend
  // additionally enforces ownerId on every write, so a non-manager who reaches this
  // URL sees a friendly notice instead of edit controls that would 403 on save.
  const canManage = canManageWorkshopSettings(userRole) && (isAdmin || isOwner);

  return (
    // The shell (header + footer) is `experiences/[id]/layout.tsx`. See the note there.
    <>
      {/* ── ⚠ THIS PAGE'S OWN HEADER IS GONE, AND IT WAS THREE DUPLICATIONS IN ONE ──────────
          It rendered a `← Back to {label}` link, an `<h1>Experience Settings</h1>` and the
          workshop's name. Every one of those is already on screen, supplied by
          `ExperienceHeader` in `experiences/[id]/layout.tsx`:

            - the back link         → that bar's `← Experiences`
            - the workshop name     → that bar's `<h1>{workshop.name}</h1>`
            - "Experience Settings" → the "Settings" tab, which also carries the active state

          ⚠ AND THE `<h1>` WAS A SECOND ONE ON THE PAGE, which is the part that was not merely
          untidy. `ExperienceHeader` already owns the document's `<h1>`, so a page-level `<h1>`
          underneath it gave this route two level-one headings and broke the outline a
          screen-reader user navigates by. Deleting the block fixes that as a side effect.

          ⚠ `?from=` IS NOW INERT ON THIS ROUTE, see the note at the top of the file. Saving
          does not navigate and there is no Cancel, so the parameter had no consumer other than
          that link. The trade is stated there rather than buried here. */}

      {/* flex-1 so the footer sits at the bottom rather than under the content. */}
      <main className="w-full flex-1 max-w-3xl mx-auto px-6 py-8">
        {!canManage ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-ink-subtle">
            You don&apos;t have permission to edit this workshop.
          </div>
        ) : (
          <>
            {saveError && (
              <div className="mb-4 rounded-md border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-text">
                {saveError}
              </div>
            )}
            <WorkshopDetailsForm
              workshop={workshop}
              formats={formatsQuery.data ?? []}
              formatsLoading={formatsQuery.isLoading}
              formatsError={formatsQuery.isError}
              onRetryFormats={() => formatsQuery.refetch()}
              onSaveDetails={(name, description, startsAt, endsAt, format) =>
                updateWorkshop.mutate({
                  id: workshopId,
                  name,
                  description,
                  startsAt,
                  endsAt,
                  format,
                })
              }
              onChangeStatus={(status) =>
                updateStatus.mutate({ id: workshopId, status })
              }
              savingDetails={updateWorkshop.isPending}
              savedDetails={settingsSaved}
              changingStatus={updateStatus.isPending}
            />

            <SettingsForm
              workshop={workshop}
              onSave={({ setupConfig, enabledAssistants }) =>
                updateWorkshop.mutate({ id: workshopId, setupConfig, enabledAssistants })
              }
              saving={updateWorkshop.isPending}
              saved={settingsSaved}
            />
          </>
        )}
      </main>
    </>
  );
}

// Assistant catalog is defined once in @praimana/shared (D6).
const ALL_ASSISTANTS = ASSISTANTS;

// Full status lifecycle. Ordered so the selector reads as a progression.
const WORKSHOP_STATUSES = [
  "DRAFT",
  "REGISTRATION",
  "ACTIVE",
  "JUDGING",
  "COMPLETED",
  "ARCHIVED",
] as const;
type WorkshopStatus = (typeof WORKSHOP_STATUSES)[number];

const STATUS_STYLES: Record<WorkshopStatus, string> = {
  DRAFT: "bg-surface-2 text-ink-subtle",
  REGISTRATION: "bg-notice-bg text-notice-text",
  ACTIVE: "bg-success-bg text-success-text",
  JUDGING: "bg-warn-bg text-warn-text",
  COMPLETED: "bg-series-1/15 text-series-1",
  ARCHIVED: "bg-surface-2 text-ink-subtle",
};

// Edit the core workshop metadata: name, description, and lifecycle status.
// Status changes save immediately (one click = one PATCH); name/description are
// batched behind a Save button so typing doesn't fire a request per keystroke.
/**
 * A stored UTC ISO instant → the "YYYY-MM-DDTHH:mm" a <input type="datetime-local">
 * expects, in the BROWSER's timezone.
 *
 * `toISOString().slice(0,16)` is the obvious wrong answer: it renders in UTC, so a
 * facilitator in London opening a workshop they set for 09:00 BST would see 08:00 and,
 * saving, would move it. Subtracting the offset first makes the round trip lossless.
 *
 * Returns "" for null/absent/unparseable, which the form treats as "not set", the state
 * every workshop created before dates existed is in.
 */
function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function WorkshopDetailsForm({
  workshop,
  formats,
  formatsLoading,
  formatsError,
  onRetryFormats,
  onSaveDetails,
  onChangeStatus,
  savingDetails,
  savedDetails,
  changingStatus,
}: {
  workshop: Workshop;
  onSaveDetails: (
    name: string,
    description: string,
    startsAt: string,
    endsAt: string,
    format: string
  ) => void;
  formats: { name: string; value: string }[];
  formatsLoading: boolean;
  formatsError: boolean;
  onRetryFormats: () => void;
  onChangeStatus: (status: WorkshopStatus) => void;
  savingDetails: boolean;
  savedDetails: boolean;
  changingStatus: boolean;
}) {
  const [name, setName] = useState(workshop.name || "");  // nosemgrep: react-props-in-state
  const [description, setDescription] = useState(workshop.description || "");  // nosemgrep: react-props-in-state
  /**
   * ⚠ THE FORMAT FIELD WAS ABSENT FROM THIS FORM ENTIRELY, and it was not merely a missing input:
   * `workshop.update` in the tRPC router did not accept `format`, so zod STRIPPED it and any save
   * silently changed nothing. Both halves are fixed, see the router's note.
   *
   * ⚠ AND "workshop" SURVIVES HERE ON PURPOSE. The word is being replaced with "Experience"
   * throughout the UI, but `format` is a VALUE whose options include a format literally called
   * "Workshop" (alongside Hackathon, Bootcamp, …). Renaming a stored value would break existing
   * records and the lookup it comes from; only the surrounding CHROME is renamed.
   */
  const [format, setFormat] = useState(workshop.format || "");  // nosemgrep: react-props-in-state
  // <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in LOCAL time, whereas the
  // stored value is a UTC ISO instant. toISOString() would render it in UTC and shift the
  // displayed hour, so the offset is subtracted first, otherwise a facilitator opens the
  // form and sees a start time an hour or more from the one they set.
  const [startsAtLocal, setStartsAtLocal] = useState(toLocalInput(workshop.startsAt));  // nosemgrep: react-props-in-state
  const [endsAtLocal, setEndsAtLocal] = useState(toLocalInput(workshop.endsAt));  // nosemgrep: react-props-in-state
  const currentStatus: WorkshopStatus = WORKSHOP_STATUSES.includes(workshop.status)
    ? workshop.status
    : "DRAFT";

  const startsAtIso = startsAtLocal ? new Date(startsAtLocal).toISOString() : "";
  const endsAtIso = endsAtLocal ? new Date(endsAtLocal).toISOString() : "";
  const datesInverted =
    !!startsAtIso && !!endsAtIso && new Date(endsAtIso) < new Date(startsAtIso);

  const dirty =
    name !== workshop.name ||
    description !== workshop.description ||
    startsAtIso !== (workshop.startsAt || "") ||
    endsAtIso !== (workshop.endsAt || "");

  // BOTH DATES REQUIRED to save. Consequence worth knowing: a workshop
  // created before dates existed has none, so the first edit of that workshop must supply
  // them. That is a one-time prompt on an existing row, not data loss, nothing is
  // rejected until someone actively opens this form and saves.
  const missingDates = !startsAtLocal || !endsAtLocal;

  return (
    <section className="mb-8 rounded-lg border p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Experience Details</h2>
        <span
          className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_STYLES[currentStatus]}`}
        >
          {currentStatus}
        </span>
      </div>

      <div>
        <label className="block text-xs font-medium text-ink-subtle mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          className="w-full rounded-md border border-field-border px-3 py-2 text-sm focus:border-brand focus:ring-1 focus:ring-brand outline-none"
          placeholder="Experience name"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-ink-subtle mb-1">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={1000}
          className="w-full rounded-md border border-field-border px-3 py-2 text-sm focus:border-brand focus:ring-1 focus:ring-brand outline-none min-h-[80px]"
          placeholder="What is this experience about?"
        />
      </div>

      {/*
        ⚠ THE FORMAT FIELD, WHICH WAS MISSING ENTIRELY. Reported as "not showing the format field in
        the settings page to update". It was absent from the form AND silently stripped by the tRPC
        mutation, so even a hand-crafted request changed nothing.

        Reuses the same `FormatSelect` the create page uses, rather than a second <select>: the two
        would otherwise drift on loading, error and retry behaviour, and this one has to handle a
        formats lookup that fails just as gracefully.
      */}
      <div>
        <label htmlFor="settings-format" className="block text-xs font-medium text-ink-subtle mb-1">
          Format
        </label>
        <FormatSelect
          id="settings-format"
          value={format}
          onChange={setFormat}
          formats={formats}
          isLoading={formatsLoading}
          isError={formatsError}
          onRetry={onRetryFormats}
        />
        <p className="mt-1 text-xs text-ink-subtle">
          How this experience runs. Set by an administrator; ask if the one you need is missing.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label
            htmlFor="settings-startsAt"
            className="block text-xs font-medium text-ink-subtle mb-1"
          >
            Starts
          </label>
          <input
            id="settings-startsAt"
            type="datetime-local"
            value={startsAtLocal}
            onChange={(e) => setStartsAtLocal(e.target.value)}
            required
            className="w-full rounded-md border border-field-border px-3 py-2 text-sm focus:border-brand focus:ring-2 focus:ring-brand outline-none"
          />
        </div>
        <div>
          <label
            htmlFor="settings-endsAt"
            className="block text-xs font-medium text-ink-subtle mb-1"
          >
            Ends
          </label>
          <input
            id="settings-endsAt"
            type="datetime-local"
            value={endsAtLocal}
            onChange={(e) => setEndsAtLocal(e.target.value)}
            min={startsAtLocal || undefined}
            required
            aria-invalid={datesInverted || undefined}
            aria-describedby={datesInverted ? "settings-dates-error" : undefined}
            className={`w-full rounded-md border px-3 py-2 text-sm focus:ring-2 focus:ring-brand outline-none ${
              datesInverted
                ? "border-danger-field-border bg-danger-bg"
                : "border-field-border focus:border-brand"
            }`}
          />
        </div>
        {datesInverted && (
          <p
            id="settings-dates-error"
            role="alert"
            className="sm:col-span-2 flex items-start gap-1 text-xs text-danger-text-strong"
          >
            <span aria-hidden="true">✕</span>
            <span>The end date must be on or after the start date.</span>
          </p>
        )}
        {missingDates && !datesInverted && (
          <p className="sm:col-span-2 text-xs text-warn-text">
            Both dates are required. This experience was created before dates were
            captured, so set them to save any change here.
          </p>
        )}
      </div>

      <div>
        <label className="block text-xs font-medium text-ink-subtle mb-1">Status</label>
        <select
          value={currentStatus}
          onChange={(e) => onChangeStatus(e.target.value as WorkshopStatus)}
          disabled={changingStatus}
          className="w-full rounded-md border border-field-border px-3 py-2 text-sm focus:border-brand focus:ring-1 focus:ring-brand outline-none disabled:opacity-50"
        >
          {WORKSHOP_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <p className="text-xs text-ink-tertiary mt-1">
          Controls the workshop lifecycle. Changes save immediately.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() =>
            onSaveDetails(name.trim(), description.trim(), startsAtIso, endsAtIso, format)
          }
          disabled={
            savingDetails || !dirty || !name.trim() || missingDates || datesInverted
          }
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-ink hover:bg-brand-hover disabled:opacity-50 transition-colors"
        >
          {savingDetails ? "Saving..." : "Save Details"}
        </button>
        {savedDetails && !dirty && (
          <span className="text-xs text-success-text">Saved!</span>
        )}
      </div>
    </section>
  );
}

function SettingsForm({
  workshop,
  onSave,
  saving,
  saved,
}: {
  workshop: Workshop;
  onSave: (payload: {
    setupConfig: WorkshopSetupConfig;
    enabledAssistants: AssistantId[];
  }) => void;
  saving: boolean;
  saved: boolean;
}) {
  const existing: WorkshopSetupConfig = workshop.setupConfig || {};
  const [instructions, setInstructions] = useState(existing.instructions || "");

  // Existing workshops without the field default to all assistants enabled.
  const initialEnabled: AssistantId[] = Array.isArray(workshop.enabledAssistants)
    ? workshop.enabledAssistants.filter((a: string): a is AssistantId =>
        ALL_ASSISTANTS.some((x) => x.id === a)
      )
    : ALL_ASSISTANTS.map((a) => a.id);
  const [enabledAssistants, setEnabledAssistants] = useState<AssistantId[]>(
    initialEnabled.length ? initialEnabled : ALL_ASSISTANTS.map((a) => a.id)
  );

  function toggleAssistant(id: AssistantId) {
    setEnabledAssistants((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    );
  }

  function handleSave() {
    // One free-text field. An empty box means "no automated setup", send an empty
    // setupConfig rather than a stale value, and the desktop app skips the setup turn.
    const trimmed = instructions.trim();
    onSave({
      setupConfig: trimmed ? { instructions: trimmed } : {},
      enabledAssistants,
    });
  }

  return (
    <div className="rounded-lg border p-5 bg-surface-1 space-y-4">
      <div>
        <h3 className="font-semibold text-sm mb-1">AI Assistants</h3>
        <p className="text-xs text-ink-subtle mb-2">
          Choose which coding assistants participants can use in the desktop app.
        </p>
        <div className="space-y-2">
          {ALL_ASSISTANTS.map((a) => {
            const on = enabledAssistants.includes(a.id);
            return (
              <div
                key={a.id}
                className={`flex items-center justify-between rounded-lg border p-3 transition-all ${
                  on ? "border-brand-border bg-surface-3" : "border-hairline bg-surface-1"
                }`}
              >
                <div className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={a.img}
                    alt={a.name}
                    className={`w-7 h-7 rounded-full transition-opacity ${on ? "" : "opacity-40 grayscale"}`}
                  />
                  <div>
                    <div className={`text-sm font-medium ${on ? "text-ink-muted" : "text-ink-tertiary"}`}>
                      {a.name}
                    </div>
                    <div className="text-xs text-ink-tertiary">{on ? "Enabled" : "Disabled"}</div>
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={`${on ? "Disable" : "Enable"} ${a.name}`}
                  onClick={() => toggleAssistant(a.id)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    on ? "bg-brand" : "bg-hairline-strong"
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-surface-3 shadow transition-transform ${
                      on ? "translate-x-5" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </div>
        {enabledAssistants.length === 0 && (
          <p className="text-xs text-danger-text-strong mt-2">At least one assistant must be enabled.</p>
        )}
      </div>

      <div className="border-t pt-4">
        <h3 className="font-semibold text-sm mb-1">Developer Setup</h3>
        <p className="text-xs text-ink-subtle">
          Instructions the AI coding assistant follows to set up a participant&apos;s project when they
          start working in the desktop app.
        </p>
      </div>

      <div>
        <label className="block text-xs font-medium text-ink-subtle mb-1">AI setup instructions</label>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          className="w-full rounded-md border border-field-border px-3 py-2 text-sm focus:border-brand focus:ring-1 focus:ring-brand outline-none min-h-[200px] leading-relaxed"
          placeholder={
            "e.g. Install dependencies, then verify the build or tests run and report " +
            "the result. Only run safe, non-destructive commands."
          }
        />
        <p className="text-xs text-ink-tertiary mt-1">
          Plain language, e.g. install dependencies, scaffold files, verify the build. Leave blank for
          no automated setup.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving || enabledAssistants.length === 0}
          className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-ink hover:bg-brand-hover disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving..." : "Save Settings"}
        </button>
        {saved && (
          <span className="text-xs text-success-text">Settings saved!</span>
        )}
      </div>
    </div>
  );
}
