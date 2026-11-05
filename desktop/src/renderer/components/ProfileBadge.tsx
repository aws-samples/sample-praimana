/**
 * ── ⚠ WHICH PROFILE AM I SIGNING INTO? ────────────────────────────────────────────────────────
 *
 * Correct, and the cause is structural rather than a regression. The profile name lives in the
 * titlebar strip inside the SIGNED-IN shell (App.tsx), and every pre-auth gate — platform setup,
 * sign-in, join-team, assistant selection — returns before that shell renders. So the one moment the
 * answer matters most is the one moment it was never shown: profiles keep separate sign-ins, so two
 * windows on two profiles present two identical login forms, and typing a password into the wrong one
 * is a mistake the app gave no way to notice.
 *
 * ⚠ IT SHOWS THE NAME *AND* OFFERS THE WAY OUT. Naming the profile answers "where am I"; without a
 * switch control the answer is useless to someone who is in the wrong place — they would have to quit
 * and relaunch to correct it, and the launch chooser only appears when the remembered profile is
 * missing or ambiguous. `onSwitch` opens the profiles page, which is the request's own suggestion.
 *
 * ⚠ RENDERS NOTHING WITHOUT A LABEL, deliberately. A default install has no profile, and "Profile:
 * default" would be noise invented for a concept that user has not opted into.
 */
export function ProfileBadge({
  label,
  onSwitch,
}: {
  /** The current profile's display name, or null on a default install. */
  label: string | null;
  /** Open the profiles page. Omitted where switching is not offered. */
  onSwitch?: () => void;
}) {
  if (!label) return null;

  return (
    <div className="mb-5 flex items-center justify-center gap-2 text-xs">
      <span className="text-surface-muted">Profile</span>
      {/*
        `bg-surface-raised` rather than a tinted fill: this is orientation, not a warning. The
        surrounding alert boxes use `tool-error` and this must not compete with them for attention —
        it answers a question the user may not have thought to ask.
      */}
      <span
        className="max-w-[300px] truncate rounded bg-surface-raised px-2 py-0.5 font-medium text-surface-text"
        title={`This window is signed in as the "${label}" profile. Profiles keep separate sign-ins, teams and chat history.`}
      >
        {label}
      </span>
      {onSwitch && (
        <button
          type="button"
          onClick={onSwitch}
          className="rounded px-1.5 py-0.5 text-brand-accent underline-offset-2 transition-colors hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-accent"
        >
          Switch
        </button>
      )}
    </div>
  );
}
