"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { updatePassword } from "aws-amplify/auth";
import {
  INVITABLE_PLATFORM_ROLES,
  displayName,
  normalizeProfileField,
  profileInitials,
  validateProfile,
  type ProfileFieldKey,
  type ProfileFields,
} from "@praimana/shared";
import { trpc } from "@/lib/trpc/client";
import { configureAmplify, isAmplifyConfigured } from "@/lib/amplify";
import { authErrorMessage } from "@/lib/auth-flow";
import { ProfileFieldsForm, EMPTY_PROFILE_FIELDS } from "@/components/auth/ProfileFieldsForm";
import { ProfileMenu } from "@/components/ProfileMenu";
import { BrandMark } from "@/components/BrandMark";
import { AdvancedDisclosure } from "@/components/form/AdvancedDisclosure";
import {
  GIVE_FEEDBACK_LABEL,
  REPORT_BUG_LABEL,
  type FeedbackKind,
} from "@praimana/shared";
import { FeedbackDialog } from "@/components/FeedbackDialog";

import { SiteFooter } from "@/components/SiteFooter";

/**
 * "View profile", the destination of the header menu. Two things live here:
 *
 *   1. The stored profile (first name, last name, organisation), editable.
 *   2. Change password.
 *
 * The password change goes through Amplify's `updatePassword`, which requires the
 * CURRENT password and talks to Cognito directly from the browser. It deliberately
 * does not route through our backend: our services never see a password and should
 * not start now, the identity service has no business handling one, and adding a
 * proxy would give it a credential it currently cannot leak.
 *
 * Email and role are shown read-only. Email is the pool's username and the key the
 * invitation was issued against, so changing it is a re-verification flow rather
 * than a form field. Role is displayed because "why can't I see X?" is answered by
 * it, but a signed-in user must never be able to change their own, that check lives
 * server-side in the identity service, and not rendering an input is simply not
 * offering what would be refused.
 */
export default function ProfilePage() {
  const { data: session, status: sessionStatus } = useSession();
  const utils = trpc.useUtils();

  const { data: me, isLoading: meLoading } = trpc.auth.me.useQuery(undefined, {
    enabled: !!session,
  });

  /**
   * WAITING FOR THE SESSION COUNTS AS LOADING, same defect as /experiences and /welcome.
   *
   * `enabled: !!session` keeps this query disabled until NextAuth resolves, and a disabled query
   * is not "loading", so the first paint skipped the spinner and rendered the form with
   * EMPTY_PROFILE_FIELDS, a profile screen that appears to have lost the user's name and
   * organisation, on a form they might start typing into before the real values arrive.
   */
  const isLoading = meLoading || sessionStatus === "loading";

  const [values, setValues] = useState<ProfileFields>(EMPTY_PROFILE_FIELDS);
  const [errors, setErrors] = useState<Partial<Record<ProfileFieldKey, string>>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the form from the server once the profile arrives. Keyed on the row's
  // updatedAt-independent identity: re-seeding on every render would fight the
  // user's typing, and seeding only on mount would show empty fields because the
  // query hasn't resolved yet.
  useEffect(() => {
    if (!me) return;
    setValues({
      firstName: me.firstName ?? "",
      lastName: me.lastName ?? "",
      organization: me.organization ?? "",
    });
  }, [me]);

  const updateProfile = trpc.auth.updateProfile.useMutation({
    onSuccess: async (updated) => {
      setSaved(true);
      setSaveError(null);
      // Refresh the cached profile so the header menu's name updates immediately
      // rather than on the next full page load.
      utils.auth.me.setData(undefined, updated);
      window.setTimeout(() => setSaved(false), 3000);
    },
    onError: (err) => {
      setSaved(false);
      setSaveError(err.message);
    },
  });

  function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSaved(false);

    const found = validateProfile(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    // Normalised before sending so what's stored matches what the gate and the
    // display name were computed from.
    updateProfile.mutate({
      firstName: normalizeProfileField(values.firstName),
      lastName: normalizeProfileField(values.lastName),
      organization: normalizeProfileField(values.organization),
    });
  }

  const roleLabel =
    INVITABLE_PLATFORM_ROLES.find((r) => r.role === me?.role)?.label ??
    me?.role ??
    session?.user?.role ??
    "-";

  const name = displayName(me ?? { name: session?.user?.name ?? undefined });

  return (
    <div className="min-h-screen bg-surface-1 flex flex-col">
      <header className="sticky top-0 z-40 border-b border-hairline bg-surface-3 px-6 py-4 flex items-center justify-between">
        {/* as="span": the user's own name below is this page's <h1>. */}
        <BrandMark as="span" href="/" tagline priority />
        <ProfileMenu />
      </header>

      {/* flex-1 so the footer sits at the bottom rather than under the content. */}
      <main className="w-full flex-1 max-w-2xl mx-auto px-6 py-10">
        <div className="flex items-center gap-4">
          <span
            aria-hidden="true"
            className="h-14 w-14 shrink-0 rounded-full bg-brand text-brand-ink grid place-items-center text-lg font-semibold"
          >
            {profileInitials(me ?? { name: session?.user?.name ?? undefined })}
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold truncate">{name}</h1>
            <p className="text-sm text-ink-subtle truncate">
              {me?.email ?? session?.user?.email}
            </p>
          </div>
        </div>

        {/* ── Profile details ── */}
        <section className="mt-8 rounded-xl border border-hairline bg-surface-3 p-6">
          <h2 className="text-lg font-semibold text-ink">Your details</h2>
          <p className="mt-1 text-sm text-ink-subtle">
            Your name and organisation, as shown to your team.
          </p>

          {isLoading ? (
            <div className="mt-6 animate-pulse text-ink-tertiary">Loading your profile…</div>
          ) : (
            <form onSubmit={onSave} className="mt-6">
              {saveError && (
                <div
                  role="alert"
                  className="mb-4 rounded-md bg-danger-bg border border-danger-border px-3 py-2.5 text-sm text-danger-text"
                >
                  {saveError}
                </div>
              )}
              {saved && (
                <div
                  role="status"
                  className="mb-4 rounded-md bg-success-bg border border-success-border px-3 py-2.5 text-sm text-success-text"
                >
                  Saved.
                </div>
              )}

              <ProfileFieldsForm
                values={values}
                errors={errors}
                disabled={updateProfile.isPending}
                onChange={(key, value) => {
                  setValues((prev) => ({ ...prev, [key]: value }));
                  setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
                  setSaved(false);
                }}
              />

              <ReadOnlyRow label="Email" value={me?.email ?? "-"} />
              <ReadOnlyRow label="Role" value={roleLabel} />

              <button
                type="submit"
                disabled={updateProfile.isPending}
                className="mt-2 rounded-md bg-brand px-4 py-2.5 text-sm font-semibold text-brand-ink hover:bg-brand-hover disabled:opacity-60 transition-colors"
              >
                {updateProfile.isPending ? "Saving…" : "Save changes"}
              </button>
            </form>
          )}
        </section>

        <ChangePasswordSection />
        <HelpSection />
      </main>

      <SiteFooter />
    </div>
  );
}

/**
 * A field the user can see but not edit. Rendered as text rather than a disabled
 * input: a greyed-out input invites clicking and implies it might become editable,
 * where a labelled value reads as information.
 */
function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-4">
      <p className="block text-sm font-medium text-ink-muted mb-1.5">{label}</p>
      <p className="text-sm text-ink-subtle">{value}</p>
    </div>
  );
}

/**
 * Change password, straight to Cognito via Amplify.
 *
 * Requires the current password, that is Cognito's rule and the right one: it means
 * someone who finds an unlocked laptop cannot lock the real owner out of their own
 * account by silently rotating the password.
 */
/**
 * ── ⚠ WHERE "REPORT A BUG" AND "GIVE FEEDBACK" ACTUALLY LIVE ────────────────────────────────
 *
 * "Where do I report a bug or give feedback?" is a fair question, because the links were only
 * in the avatar DROPDOWN, which is not where anyone looks for help, and they render nothing unless a
 * support address is configured. Two problems compounding: hidden by config, and hidden by placement.
 *
 * So they are here as well, on the page the reader was already on. ⚠ AND THIS MATCHES THE DESKTOP, which
 * puts the same two links in its Account PANEL rather than in a menu, the two surfaces offering help in
 * structurally different places is the kind of inconsistency that makes a platform feel unfinished. The
 * dropdown entries stay: that is where you reach for them mid-task, without leaving the page you are on.
 *
 * ⚠ AND NOW UNCONDITIONAL. The mailto version rendered nothing without a configured support address, which
 * is precisely why it went unnoticed. A stored report has no address to address, so there is nothing left to
 * configure and nothing left to hide behind.
 */
function HelpSection() {
  /**
   * Which report form is open, or null.
   *
   * ⚠ THIS SECTION USED TO RENDER TWO `mailto:` LINKS, and rendered NOTHING at all unless a support address
   * was configured, which is how the feature came to be invisible and prompted "where can i see report bug
   * and feedback on portal?". A stored report has no address to configure, so the buttons are always here.
   *
   * ⚠ AND IT NO LONGER ASSEMBLES CONTEXT. The dialog captures the page it opens over, and the service takes
   * the reporter's identity from the verified token, so the pathname parsing and the role read that used to
   * live here left with the mailto.
   */
  const [reporting, setReporting] = useState<FeedbackKind | null>(null);

  return (
    <section className="mt-6 rounded-xl border border-hairline bg-surface-3 p-6">
      <h2 className="text-lg font-semibold text-ink">Help</h2>
      <p className="mt-1 text-sm text-ink-subtle">
        Tell us what broke or what would make this better. We record which page you were on, so you
        don&apos;t need to explain where you were.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        {(
          [
            ["BUG", REPORT_BUG_LABEL],
            ["FEEDBACK", GIVE_FEEDBACK_LABEL],
          ] as const
        ).map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            onClick={() => setReporting(kind)}
            className="rounded-md border border-field-border px-4 py-2 text-sm font-medium text-ink-muted hover:bg-surface-1"
          >
            {label}
          </button>
        ))}
      </div>

      {reporting && <FeedbackDialog kind={reporting} onClose={() => setReporting(null)} />}
    </section>
  );
}

function ChangePasswordSection() {
  /**
   * ── ⚠ COLLAPSED BY DEFAULT ("can we collapse Change password in my profile") ────────────────
   *
   * Three password fields and a submit button were the tallest thing on this page, permanently open,
   * for an action almost nobody takes on any given visit. Collapsed, the page is about who you are; the
   * form is one click away when it is what you came for.
   *
   * ⚠ `AdvancedDisclosure`, NOT `Disclosure`, and the distinction is documented on both. `Disclosure` is
   * for PRIMARY content, a roster you came to read, and opens by default. This is the other case
   * exactly: a control the reader should be able to IGNORE, which is why it is collapsed and carries a
   * summary line so they can decide not to open it in about two seconds.
   *
   * ⚠ AND IT FORCES ITSELF OPEN ON AN ERROR OR A SUCCESS. `open || !!error || !!done`, a failure
   * message hidden inside a collapsed panel is a failure nobody can see, and the same is true of the
   * confirmation. That is the one behaviour that made this component right rather than
   * `<details>`/`<summary>`, whose open state cannot be controlled.
   */
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    configureAmplify();
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);

    if (next !== confirm) {
      // Checked here rather than server-side because Cognito never sees the
      // confirmation field, it exists only to catch a typo in the new password,
      // which would otherwise lock the user out of an account they just changed.
      setError("The new passwords don't match.");
      return;
    }

    setSaving(true);
    try {
      await updatePassword({ oldPassword: current, newPassword: next });
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // No disclosure on this branch: there is no form to reveal, so a caret would open an empty panel.
  if (!isAmplifyConfigured) {
    return (
      <section className="mt-6 rounded-xl border border-hairline bg-surface-3 p-6">
        <h2 className="text-lg font-semibold text-ink">Password</h2>
        <p className="mt-1 text-sm text-ink-subtle">
          Password changes aren&apos;t available in this environment.
        </p>
      </section>
    );
  }

  return (
    <div className="mt-6">
      <AdvancedDisclosure
        id="change-password"
        title="Change password"
        summary="At least 12 characters, with upper and lower case, a number, and a symbol."
        // Forced open when there is something to read, see the note above.
        open={open || !!error || !!done}
        onToggle={() => setOpen((v) => !v)}
      >
      <form onSubmit={onSubmit}>
        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md bg-danger-bg border border-danger-border px-3 py-2.5 text-sm text-danger-text"
          >
            {error}
          </div>
        )}
        {done && (
          <div
            role="status"
            className="mb-4 rounded-md bg-success-bg border border-success-border px-3 py-2.5 text-sm text-success-text"
          >
            Your password has been changed.
          </div>
        )}

        <PasswordField
          id="current-password"
          label="Current password"
          autoComplete="current-password"
          value={current}
          onChange={setCurrent}
          disabled={saving}
        />
        <PasswordField
          id="next-password"
          label="New password"
          autoComplete="new-password"
          value={next}
          onChange={setNext}
          disabled={saving}
        />
        <PasswordField
          id="confirm-password"
          label="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          disabled={saving}
        />

        <button
          type="submit"
          disabled={saving}
          className="mt-2 rounded-md bg-ink px-4 py-2.5 text-sm font-semibold text-brand-ink hover:bg-ink-muted disabled:opacity-60 transition-colors"
        >
          {saving ? "Changing…" : "Change password"}
        </button>
      </form>
      </AdvancedDisclosure>
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  disabled?: boolean;
}) {
  return (
    <div className="mb-4">
      <label htmlFor={id} className="block text-sm font-medium text-ink-muted mb-1.5">
        {label}
      </label>
      <input
        id={id}
        type="password"
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required
        className="w-full rounded-md border border-field-border px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand"
      />
    </div>
  );
}
