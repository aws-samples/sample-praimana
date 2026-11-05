"use client";

import { createContext, useContext, type ReactNode } from "react";
import { BrandMark } from "@/components/BrandMark";
import { SiteFooter } from "@/components/SiteFooter";

/**
 * Shared chrome and form primitives for the custom auth screens.
 *
 * These exist so the seven screens of the auth journey (sign-in, TOTP setup, TOTP
 * challenge, sign-up, confirm, forgot, reset) are visibly ONE product. Replacing a
 * hosted UI with a hand-built one only pays off if the result is consistent; seven
 * independently-styled forms would be worse than the page we replaced.
 */

/**
 * ── ⚠ EMBEDDED MODE, AND WHY IT IS A CONTEXT RATHER THAN A PROP ──────────────────────────
 *
 * The landing page reveals the sign-in form in a side panel instead of navigating to
 * /login, so `AuthShell` has to be able to render as a bare card with no page chrome.
 *
 * `AuthFlow` renders `<AuthShell>` TWELVE times, once per step of the journey. Threading an
 * `embedded` prop would mean twelve identical edits, and, the part that actually matters -
 * every future step would silently default to the full-page shell, so a new screen added in
 * a year would break the panel with no error. A context set once at the panel boundary
 * cannot be forgotten by a call site that does not know it exists.
 *
 * ⚠ THE HEADING LEVEL IS PART OF THIS, not a detail. Standalone, the card's title is the
 * page's `<h1>`. Inside the landing page it is not: the brand mark in the header is the
 * `<h1>` and the hero is the `<h2>`, so a card `<h1>` would give the document two level-one
 * headings and break the outline a screen-reader user navigates by.
 */
const AuthShellEmbedded = createContext(false);

/** Wrap `<AuthFlow>` in this to render its steps as bare cards, with no page chrome. */
export function EmbeddedAuthShell({ children }: { children: ReactNode }) {
  return <AuthShellEmbedded.Provider value={true}>{children}</AuthShellEmbedded.Provider>;
}

export function AuthShell({
  title,
  subtitle,
  children,
  footer,
  leadWithBrand = false,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * ⚠ THE BRAND MARK REPLACES THE TITLE AND SUBTITLE, and ONLY when embedded.
   *
   * Standalone, the brand mark already sits above the card, so honouring this there would
   * print the product name twice, 40px apart. Embedded in the landing page there is no mark
   * above the card, and "Sign in / Welcome back." is redundant with the button the reader just
   * pressed, so the card leads with the product name instead, matching the standalone screen.
   *
   * ⚠ SET ON THE SIGN-IN STEP ONLY, and that restriction is the point. The journey behind this
   * card has twelve screens, and the title is the only thing that says WHICH one you are on
   * ("Verify your identity", "Set your password", "Check your email"). Replacing all of them
   * with a logo would leave a user mid-TOTP-enrolment looking at a product name. Only the first
   * step is safely self-describing, because the reader arrived by pressing "Get started".
   */
  leadWithBrand?: boolean;
}) {
  const embedded = useContext(AuthShellEmbedded);
  const brandLead = embedded && leadWithBrand;

  /* The card itself, identical in both modes so the panel and the page cannot drift apart.
     `shadow-[var(--overlay-shadow)]` rather than `shadow-sm`: a drop shadow was doing almost
     nothing on grey and nothing at all in the dark variant, so the token carries a tinted
     shadow per palette. */
  const card = (
    <>
      <div className="bg-surface-3 rounded-xl border border-hairline shadow-[var(--overlay-shadow)] p-6">
        {/* ── ⚠ THE HEADING BLOCK IS CENTRED WHEN EMBEDDED, AND ONLY THE HEADING BLOCK ─────
            In the panel the card is the only object on its side of the page, so a centred
            heading reads as deliberate; left-aligned it looked snagged against the corner.

            ⚠ THIS IS APPLIED TO ALL TWELVE STEPS, not just the one that prompted it. Centring
            "Reset your password" alone would mean the heading jumped left as the reader moved
            Sign in → Reset your password → Set a new password, which reads as a rendering bug
            rather than as a design.

            ⚠ AND IT STOPS AT THE HEADING. `children` below is deliberately NOT centred: it is
            the form, and centred labels above left-aligned inputs break the vertical line the
            eye follows down a field list. Centre the title, never the fields.

            Standalone is untouched: that layout already centres a brand mark above the card and
            leans on a left-aligned title to keep the card's own heading the loudest thing. */}
        <div className={embedded ? "text-center" : undefined}>
          {brandLead ? (
            <>
              {/* ⚠ THE HEADING STAYS, IT JUST STOPS BEING VISIBLE. Swapping a text heading for a
                  logo would delete the card's entry from the document outline, the structure a
                  screen-reader user navigates by, and leave a form whose purpose is announced
                  nowhere. `sr-only` keeps "Sign in" in the outline and in the announcement while
                  the brand mark carries it visually. */}
              <h2 className="sr-only">{title}</h2>
              {/* The mark is an inline-flex row of logo + wordmark, so `text-center` on the
                  wrapper does not move it. It needs a flex parent that centres it. */}
              <div className="flex justify-center">
                <BrandMark size="sm" tone="neutral" />
              </div>
            </>
          ) : (
            <>
              {embedded ? (
                <h2 className="text-xl font-semibold tracking-title-tight text-ink">{title}</h2>
              ) : (
                <h1 className="text-xl font-semibold tracking-title-tight text-ink">{title}</h1>
              )}
              {subtitle && (
                <p className="mt-1.5 text-sm text-ink-subtle leading-relaxed">{subtitle}</p>
              )}
            </>
          )}
        </div>
        <div className="mt-6">{children}</div>
      </div>

      {footer && <div className="mt-5 text-center text-sm">{footer}</div>}
    </>
  );

  // In the panel the host page already supplies the canvas, the brand mark and the footer,
  // and `min-h-screen` here would push the landing page to twice the viewport height.
  if (embedded) return card;

  return (
    // flex-col wrapper so SiteFooter sits at the bottom while the card stays
    // optically centred in the space above it (the centring moved to the flex-1
    // row). Doing it this way keeps the card's position independent of the footer's
    // height, so the form never shifts.
    <div className="min-h-screen flex flex-col bg-surface-1">
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          {/* The real logo, replacing the "A" placeholder tile. Neutral tone and the
              small size keep this line quieter than the card's <h1> below it:
              on an auth screen the action is the heading, not the branding. */}
          <div className="flex justify-center mb-8">
            <BrandMark size="sm" tone="neutral" priority />
          </div>

          {card}
        </div>
      </div>

      <SiteFooter />
    </div>
  );
}

/**
 * An error banner with `role="alert"`, so a screen reader ANNOUNCES the failure.
 * Without it a blind user submits the form, nothing appears to change, and the
 * reason sits silently on screen, the most common accessibility defect in
 * hand-built auth forms.
 */
export function AuthError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="mb-4 rounded-md bg-danger-bg border border-danger-border px-3 py-2.5 text-sm text-danger-text"
    >
      {children}
    </div>
  );
}

/** A success/neutral notice. `role="status"` announces politely, not urgently. */
export function AuthNotice({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div
      role="status"
      className="mb-4 rounded-md bg-notice-bg border border-notice-border px-3 py-2.5 text-sm text-notice-text"
    >
      {children}
    </div>
  );
}

export function AuthField({
  label,
  error,
  hint,
  id,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string | null;
  hint?: ReactNode;
  id: string;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <div className="mb-4">
      <label htmlFor={id} className="block text-sm font-medium text-ink-muted mb-1.5">
        {label}
      </label>
      <input
        id={id}
        // Tie the hint and error to the input so a screen reader reads them WITH
        // the field, rather than leaving the user to hunt for why it was rejected.
        aria-describedby={[hintId, errorId].filter(Boolean).join(" ") || undefined}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-md border bg-surface-3 px-3 py-2 text-sm text-ink placeholder:text-field-placeholder focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand ${
          error ? "border-danger-field-border bg-danger-field-bg" : "border-field-border"
        }`}
        {...props}  // nosemgrep: react-props-spreading
      />
      {hint && (
        <p id={hintId} className="mt-1.5 text-xs text-ink-subtle leading-relaxed">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1.5 text-xs text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A six-digit verification-code input.
 *
 * The attributes are the point, not the styling: `inputMode="numeric"` brings up
 * the number pad on a phone, and `autoComplete="one-time-code"` lets iOS/Android
 * offer the code from the SMS or authenticator directly. Getting these wrong is
 * the difference between one tap and hand-copying six digits under a 30-second
 * expiry.
 */
export function AuthCodeField({
  label = "Verification code",
  error,
  hint,
  id = "code",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string | null;
  hint?: ReactNode;
  id?: string;
}) {
  return (
    <AuthField
      id={id}
      label={label}
      error={error}
      hint={hint}
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      // Cognito codes are 6 digits; the cap prevents a paste with trailing
      // whitespace from silently failing.
      maxLength={6}
      pattern="[0-9]*"
      /*
        ⚠ `000000` AND NOT `123456`, the same placeholder the desktop uses. A sequential example reads as a real code somebody could try, the sort of thing that
        gets typed in under a 30-second expiry and then blamed on the code being wrong. Repeated zeros read as
        a MASK: six positions, no suggestion.

        Kept identical to the desktop's field on purpose: the two are the same step of the same login, and a
        participant who sees a different hint in each has to wonder which one is asking for something else.
      */
      placeholder="000000"
      /*
        ⚠ CENTRED, AND `tracking` IS WHY IT HAD TO BE. The verification code is centre-aligned rather
        than left-aligned.
        `tracking-[0.3em]` adds letter-spacing AFTER the last character too, so a left-aligned
        six-digit code sits visually off-centre even in a box that looks symmetrical. `text-center`
        alone would inherit that lopsidedness, so the trailing space is compensated with an equal
        left indent, the standard fix for a letter-spaced centred field.
      */
      /*
        ⚠ THE PLACEHOLDER COLOUR WAS AN ACCESSIBILITY BUG, not a style choice. It was
        `placeholder:text-ink-tertiary`, #d1d5db, which is 1.47:1 against the field. The "000000"
        mask this comment defends was therefore very nearly invisible, on the one field in the
        product with a 30-second expiry. `--field-placeholder` is 4.77:1 and still far lighter
        than the entered digits (--ink, 16.8:1), so it still reads as a mask, not as a value.
      */
      className="w-full rounded-md border border-field-border bg-surface-3 px-3 py-2 text-center indent-[0.3em] text-lg tracking-[0.3em] font-mono text-ink placeholder:text-field-placeholder placeholder:tracking-[0.3em] focus:outline-none focus:ring-2 focus:ring-brand focus:border-brand"
      {...props}  // nosemgrep: react-props-spreading
    />
  );
}

export function AuthButton({
  loading,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button
      type="submit"
      // Disabled while in flight so a double-submit can't fire two Cognito calls -
      // which, mid-challenge, invalidates the session the first one was using.
      disabled={loading || props.disabled}
      aria-busy={loading || undefined}
      className="w-full rounded-md bg-brand px-4 py-2.5 text-sm font-semibold text-brand-ink transition-colors hover:bg-brand-hover active:translate-y-px disabled:opacity-60 disabled:cursor-not-allowed disabled:active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-3"
      {...props}  // nosemgrep: react-props-spreading
    >
      {loading ? "Please wait…" : children}
    </button>
  );
}

/** A low-emphasis text action ("Resend code", "Back to sign in"). */
export function AuthLinkButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className="rounded text-sm font-medium text-brand-text transition-colors hover:text-brand-text-strong disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface-3"
      {...props}  // nosemgrep: react-props-spreading
    >
      {children}
    </button>
  );
}
