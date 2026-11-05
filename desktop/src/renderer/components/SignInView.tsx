import { useEffect, useState } from "react";
import { ProfileBadge } from "./ProfileBadge";
import { BrandName } from "./BrandName";
import logo from "../assets/logo.png";
import { configureAmplify, clearRendererTokens } from "../lib/amplify";
import {
  submitPassword,
  submitChallengeCode,
  submitFactorChoice,
  abandonSignIn,
  type FactorChoice,
} from "../lib/desktop-sign-in";

const api = (window as any).electronAPI;

/**
 * ── NATIVE SIGN-IN ──────────────────────────────────────────────────────────────
 *
 * Email + password, then a six-digit code. No browser.
 *
 * ── WHY THIS EXISTS RATHER THAN THE HOSTED UI ──
 *
 * The desktop used to open the system browser at Cognito's Hosted UI. Two things pushed it
 * in-app, and both are measured rather than assumed:
 *
 *   1. The portal's SRP login leaves NO
 *      Hosted UI session, so "already signed in on the website" could never mean "signed in
 *      here". A silent `/oauth2/authorize` returns a login form.
 *   2. No server-side grant can mint a token for the desktop either: `AdminInitiateAuth`
 *      returns `Auth flow not enabled for this client` against the live pool.
 *
 * Doing SRP here needs neither. See `../lib/amplify.ts`.
 *
 * ── ⚠ WHAT THIS PAGE IS RESPONSIBLE FOR ──
 *
 * It holds a PASSWORD and a TOTP CODE, which this app deliberately never touched before
 * (`preload/index.ts` said so in as many words; this reverses that decision). Three
 * rules follow, and none of them is cosmetic:
 *
 *   1. THE TOKEN GOES TO MAIN IMMEDIATELY, then the renderer's copy is cleared. The window in
 *      which a credential is reachable from the renderer bundle is the thing to minimise — a
 *      malicious transitive dependency runs here.
 *   2. NO AUTO-RESUME: entry is always this form. A renderer-side
 *      resume is a second session authority that would silently sign in whoever used the
 *      machine last.
 *   3. NOTHING IS REMEMBERED. No "remember me", no stored email. Main owns the session.
 *
 * ── TWO SCREENS, BECAUSE THE REST ALREADY HAPPENED ──
 *
 * Reaching the desktop requires a completed portal sign-in, so TOTP is enrolled and any forced
 * password change is done. Steps that would need those screens route to the website instead —
 * see `../lib/desktop-sign-in.ts`, which explains why they are still reachable at all.
 */

const PRODUCT_NAME = "Praimana";
const BRAND_YEAR = "2026";

/**
 * ⚠ "totp" AND "emailCode" SHARE ONE SCREEN AND DIFFER ONLY IN COPY. Both are a six-digit field;
 * what changes is where the user should look for the digits. Telling someone to "open your
 * authenticator app" when the code is in their inbox is the whole reason these are not one state.
 */
type Screen = "password" | "totp" | "emailCode" | "chooseFactor";

/** How each factor is described. Mirrors the portal's wording so the two read as one product. */
const FACTOR_LABELS: Record<string, { title: string; hint: string }> = {
  TOTP: { title: "Authenticator app", hint: "Use a 6-digit code from your authenticator" },
  EMAIL: { title: "Email", hint: "We'll send a code to your email address" },
  SMS: { title: "Text message", hint: "Send a code to your phone" },
};

export function SignInView({
  onComplete,
  notice,
  profileLabel,
  onSwitchProfile,
}: {
  onComplete: () => void;
  /**
   * Why the user is being asked to sign in, when they did not choose to.
   *
   * ⚠ ABSENT ON THE NORMAL PATH. A first sign-in needs no explanation. It is set when App routed the
   * user here after a 401 or a 403 — and in the 403 case it also warns that a re-join may follow,
   * because signing in successfully and then being sent somewhere else is otherwise baffling.
   */
  notice?: string;
  /** Current profile name, shown so the user knows WHICH profile they are acting in. */
  profileLabel?: string | null;
  /** Open the profiles page. */
  onSwitchProfile?: () => void;
}) {
  const [screen, setScreen] = useState<Screen>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  /** The factors Cognito offered, in its order. Only set when it actually asked. */
  const [factors, setFactors] = useState<FactorChoice[]>([]);
  const [error, setError] = useState("");
  /** Set when Cognito needs a step the desktop defers; carries the link-out copy. */
  const [websiteMessage, setWebsiteMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [portalUrl, setPortalUrl] = useState("");
  /**
   * ── ⚠ WHICH IDENTITY THIS PROFILE ALREADY BELONGS TO ────────────────────────────────────────
   *
   * `count` is how many identities this profile has ever signed in as; `onlyEmail` is the address when
   * there is exactly one. Main returns at most ONE address on purpose — SettingsView records that the
   * account switcher was removed because "a list of other people's accounts on a shared machine
   * disclosed every previous signed-in user's email to whoever opened Settings next", and this screen
   * needs no authentication to reach, so it is the last place that list should appear.
   */
  const [profileIdentity, setProfileIdentity] = useState<{
    count: number;
    onlyEmail: string | null;
  } | null>(null);
  /**
   * The email field is fixed to the profile's identity when it has exactly one.
   *
   * ⚠ ONLY WHEN THERE IS EXACTLY ONE. A profile that already holds several — `…-jarvisdeploy` holds
   * two — leaves the field editable, because pinning it to one of them would strand the others, whose
   * chats and projects live in that profile and are reachable by no other route since the account
   * switcher was removed. A new address is still refused there, by main, at submit.
   */
  const locked = !!profileIdentity?.onlyEmail;

  /**
   * Configure Amplify from the STORED platform config, and read the portal URL for the
   * link-out. Not a sign-in attempt — see rule 2 above.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await configureAmplify();
      if (cancelled) return;
      if (!ok) {
        setError("This app isn't connected to a platform yet.");
        return;
      }
      try {
        const config = await api.getPlatformConfig();
        if (!cancelled) setPortalUrl(config?.portalUrl || "");
      } catch {
        // The link-out degrades to plain text without a URL; sign-in still works.
      }
      /**
       * ⚠ A FAILURE HERE LEAVES THE FIELD EDITABLE, deliberately. The lock is accident prevention, and
       * the main-process check in `adoptSession` is what actually enforces it — so degrading to "no
       * lock" costs a confusing error at submit instead of locking somebody out of their own workspace
       * because one IPC call failed.
       */
      try {
        const identity = await api.profileIdentity?.();
        if (!cancelled && identity) {
          setProfileIdentity(identity);
          // Prefill so the single-identity case is one field to fill, not two.
          if (identity.onlyEmail) setEmail(identity.onlyEmail);
        }
      } catch {
        /* Field stays editable; main still refuses a foreign identity. */
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
      // Belt and braces: if this unmounts mid-flow, no token is left held in the renderer.
      clearRendererTokens();
    };
  }, []);

  /**
   * Hand BOTH tokens to main, clear the renderer's copy, and route onward.
   *
   * ⚠ THE REFRESH TOKEN IS WHY THIS PASSES TWO. Amplify holds it in the renderer's in-memory
   * store, which dies with the window — so without handing it over, the session would last the
   * ID token's ~30 minutes and end with no way to renew.
   */
  async function finish(idToken: string, refreshToken?: string) {
    try {
      const result = await api.completeSignIn(idToken, refreshToken);
      if (!result?.ok) {
        setError(result?.error || "Signed in, but the session could not be stored.");
        return;
      }
      onComplete();
    } finally {
      /**
       * ⚠ CLEARED WHETHER OR NOT THE HANDOFF SUCCEEDED, and in a `finally` so an early return
       * cannot skip it. Main either has the token or does not; the renderer keeping a copy
       * helps in neither case.
       */
      clearRendererTokens();
    }
  }

  function applyOutcome(outcome: Awaited<ReturnType<typeof submitPassword>>) {
    switch (outcome.status) {
      case "done":
        void finish(outcome.idToken, outcome.refreshToken);
        return;
      case "totp":
        setScreen("totp");
        setError("");
        return;
      case "emailCode":
        setScreen("emailCode");
        setError("");
        return;
      case "chooseFactor":
        setFactors(outcome.options);
        setScreen("chooseFactor");
        setError("");
        return;
      case "useWebsite":
        setWebsiteMessage(outcome.message);
        return;
      case "error":
        setError(outcome.message);
        return;
    }
  }

  /** Tell Cognito which enrolled factor to use. Its reply is the next challenge. */
  async function handleFactorChoice(choice: FactorChoice) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      applyOutcome(await submitFactorChoice(choice));
    } finally {
      setBusy(false);
    }
  }

  async function handlePassword() {
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError("");
    try {
      applyOutcome(await submitPassword(email, password));
    } finally {
      setBusy(false);
      /**
       * ⚠ THE PASSWORD IS DROPPED FROM STATE the moment it has been used, successfully or not.
       * Keeping it would leave a plaintext credential in a React component for as long as the
       * view is mounted, reachable from anything in the renderer bundle. A retry re-types it;
       * that is the correct trade.
       */
      setPassword("");
    }
  }

  async function handleTotp() {
    if (busy || code.trim().length < 6) return;
    setBusy(true);
    setError("");
    try {
      applyOutcome(await submitChallengeCode(code));
    } finally {
      setBusy(false);
      // Cleared for the same reason as the password, and because a stale code in the field
      // would be re-submitted and rejected.
      setCode("");
    }
  }

  /**
   * Back out of a challenge screen, abandoning the half-finished Cognito challenge.
   *
   * Shared by the code screens AND the factor chooser — one handler, because backing out means the
   * same thing from all of them. `factors` is cleared too: a stale list from a previous attempt
   * rendered on the next one would offer a choice Cognito is no longer asking for.
   */
  async function handleBack() {
    // Without this, Amplify keeps the challenge and the next attempt throws
    // UserAlreadyAuthenticatedException — the trap `submitPassword` guards, from the other side.
    await abandonSignIn();
    clearRendererTokens();
    setScreen("password");
    setCode("");
    setFactors([]);
    setError("");
  }

  return (
    <div className="h-screen flex flex-col bg-surface-bg overflow-y-auto">
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          {/* Explicit width/height reserve the box — an unsized logo reflows the page the
              moment it decodes, under a pointer already moving toward the field. */}
          <div className="flex items-center justify-center gap-2.5 mb-8">
            <img src={logo} width={32} height={32} className="shrink-0 rounded-lg" alt="" />
            <span className="text-xl font-bold text-surface-text"><BrandName /></span>
          </div>

          {/* Which profile this window is. See ProfileBadge for why it sits before the form. */}
          <ProfileBadge label={profileLabel ?? null} onSwitch={onSwitchProfile} />

          {/*
            Why the user was sent here, when they did not ask to be. `tool-error` as a BORDER is legal
            at 3.87:1 (a graphical indicator); the words use `tool-error-text` at 7.22:1 — the two reds
            are not interchangeable, per the ratios in tailwind.config.ts.
          */}
          {notice && (
            <div
              role="alert"
              className="mb-5 rounded-lg border border-tool-error bg-surface-raised p-3 text-xs text-tool-error-text"
            >
              {notice}
            </div>
          )}

          <div className="bg-surface-panel rounded-xl border border-surface-line shadow-sm p-6">
            {/*
              ⚠ EVERY FIELD BELOW SETS `bg-surface-bg` EXPLICITLY.
              The fields set `text-surface-text` (near-white) and, for a background, only
              `disabled:bg-surface-bg` — a STATE-prefixed class that applies when the field is
              disabled and never otherwise. So an enabled input fell back to the browser's white
              default and rendered near-white text on white.

              `disabled:opacity-60` replaces the disabled fill: dimming the whole control reads as
              disabled on a dark surface, whereas swapping to a darker fill did not.
            */}
            {websiteMessage ? (
              /*
                A step the desktop defers. Shown INSTEAD of the form, because leaving the form
                visible would invite a retry that cannot succeed.
              */
              <>
                <h1 className="text-xl font-bold tracking-tight text-surface-text">
                  Finish on the website
                </h1>
                <p role="status" className="mt-2 text-sm text-surface-muted leading-relaxed">
                  {websiteMessage}
                </p>
                {portalUrl && (
                  /* target=_blank goes to the system browser: main's setWindowOpenHandler
                     routes external URLs there and denies in-app windows. */
                  <a
                    href={portalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-5 inline-block w-full rounded-md bg-blue-600 px-6 py-2.5 text-center text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
                  >
                    Open the website
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setWebsiteMessage("");
                    setScreen("password");
                  }}
                  className="mt-3 w-full rounded-md border border-surface-line px-6 py-2.5 text-sm font-medium text-surface-text hover:bg-surface-bg transition-colors"
                >
                  Back to sign in
                </button>
              </>
            ) : screen === "password" ? (
              <>
                <h1 className="text-xl font-bold tracking-tight text-surface-text">Sign in</h1>
                <p className="mt-2 text-sm text-surface-muted leading-relaxed">
                  Use the same email and password as the website.
                </p>

                <label htmlFor="signin-email" className="mt-6 block text-xs font-medium text-surface-text">
                  Email
                </label>
                <input
                  id="signin-email"
                  type="email"
                  /**
                   * ⚠ THE FULL ADDRESS, DELIBERATELY. An earlier version masked it, on the
                   * reasoning SettingsView gives for deleting the account switcher — "a list of other
                   * people's accounts on a shared machine disclosed every previous signed-in user's
                   * email to whoever opened Settings next". The answer is that this app is
                   * always used by ONE person who holds SEVERAL addresses, one per experience or team,
                   * so there is no other person to disclose to and the mask only hid from the user
                   * which of their own accounts this profile is. Reinstating the mask is a one-line
                   * change if that assumption ever stops holding — the threat it addressed is a shared
                   * machine, not a hostile one.
                   */
                  value={email}
                  readOnly={locked}
                  aria-readonly={locked || undefined}
                  aria-describedby={profileIdentity?.count ? "signin-profile-bound" : undefined}
                  onChange={(e) => {
                    if (locked) return;
                    setEmail(e.target.value);
                    setError("");
                  }}
                  // Enter moves to the password field rather than submitting a half-filled form.
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      document.getElementById("signin-password")?.focus();
                    }
                  }}
                  autoFocus
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  disabled={!ready || busy}
                  className={
                    "mt-1.5 w-full rounded-md border border-surface-line px-3 py-2 text-sm text-surface-text placeholder:text-surface-faint focus:outline-none disabled:opacity-60 " +
                    (locked
                      ? // Reads as a fact rather than an empty box somebody should type in.
                        "bg-surface-raised text-surface-muted cursor-not-allowed"
                      : "bg-surface-bg focus:border-blue-500 focus:ring-1 focus:ring-blue-500")
                  }
                />

                {/**
                 * ── ⚠ THE SENTENCE THAT MAKES THE LOCK MAKE SENSE ────────────────────────────────
                 *
                 * A locked field with no explanation reads as a bug, and the remedy — switch profile, or make
                 * a new one — is not something a participant would guess.
                 *
                 * ⚠ TWO CASES, BECAUSE ONE PROFILE HERE HAD THREE ACCOUNT ROWS ACROSS TWO IDENTITIES.
                 * With exactly one identity the field is locked to it. With several already present the
                 * field stays EDITABLE — locking it to one would strand the other, whose chats and
                 * projects are in this profile and reachable no other way, since the account switcher
                 * was removed. A new address is still refused, by main, at submit.
                 */}
                {profileIdentity && profileIdentity.count > 0 && (
                  <p id="signin-profile-bound" className="mt-2 text-xs text-surface-muted leading-relaxed">
                    {locked
                      ? "This profile is signed in as the account above."
                      : `This profile has been used by ${profileIdentity.count} accounts.`}{" "}
                    To sign in as someone else,{" "}
                    {onSwitchProfile ? (
                      <button
                        type="button"
                        onClick={onSwitchProfile}
                        className="underline hover:text-surface-text focus:outline-none focus:ring-1 focus:ring-blue-500 rounded"
                      >
                        switch profiles
                      </button>
                    ) : (
                      "switch profiles"
                    )}{" "}
                    or create a new one — each profile keeps its own chats, projects and team.
                  </p>
                )}

                <label
                  htmlFor="signin-password"
                  className="mt-4 block text-xs font-medium text-surface-text"
                >
                  Password
                </label>
                <input
                  id="signin-password"
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handlePassword();
                    }
                  }}
                  // `current-password`, so a password manager offers the right entry and does
                  // not treat this as a change-password form.
                  autoComplete="current-password"
                  disabled={!ready || busy}
                  className="mt-1.5 w-full rounded-md border border-surface-line bg-surface-bg px-3 py-2 text-sm text-surface-text focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60"
                />

                <button
                  type="button"
                  onClick={handlePassword}
                  disabled={!ready || busy || !email.trim() || !password}
                  aria-busy={busy || undefined}
                  className="mt-6 w-full rounded-md bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                >
                  {busy ? "Signing in…" : "Sign in"}
                </button>

                {portalUrl && (
                  <p className="mt-4 text-xs text-surface-muted leading-relaxed">
                    Forgot your password? Reset it on{" "}
                    <a
                      href={portalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-blue-600 hover:underline"
                    >
                      the website
                    </a>
                    .
                  </p>
                )}

                {/*
                  ── ⚠ THE BROWSER ROUTE, KEPT AS AN OPTION ───────────────────────────────────
                  A new profile now INHERITS the experience from the window that created it, so this screen
                  is what it lands on — sign in with the same credentials, same pool. That is the default,
                  and it is the right one.

                  ⚠ BUT THERE WAS NO WAY BACK, and that was the other half of the problem. This screen had no
                  route to the connect flow at all: `resetPlatform` lives in the account panel, which is
                  BEHIND a sign-in. So a participant who wanted the portal's "Open in desktop" button — or
                  whose profile was seeded with the wrong experience — was stuck on a form they could not
                  complete, with the fix on the other side of it.

                  ⚠ IT CLEARS THE PLATFORM, SO IT SAYS SO. The label names the consequence rather than
                  reading as a neutral alternative, because a mis-click here disconnects the profile. It is
                  recoverable — connecting again is exactly what it takes you to — but it should not be a
                  surprise.
                */}
                <p className="mt-3 text-xs text-surface-muted leading-relaxed">
                  Signing in to a different platform?{" "}
                  <button
                    onClick={async () => {
                      await api.resetPlatform();
                      /* Re-runs the shell's state check, which now finds no platform and shows the
                         connect screen. */
                      onComplete();
                    }}
                    className="font-medium text-blue-600 hover:underline"
                  >
                    Disconnect and connect from the browser
                  </button>
                </p>
              </>
            ) : screen === "chooseFactor" ? (
              <>
                {/*
                  ── ⚠ RENDERED FROM WHAT COGNITO OFFERED ────────────────────────────────────
                  `factors` is `nextStep.allowedMFATypes`, filtered to names this app can submit —
                  never a hardcoded pair. The portal shipped exactly that mistake: an
                  "Authenticator app / Text message" pair where the SMS half could not work, since
                  the pool enables no SMS factor and no user has a phone number. The one screen a
                  locked-out participant reaches offered them a dead button.

                  This screen became routine when EMAIL_OTP was enabled: a user with both factors
                  and no stated preference is asked on every sign-in.
                */}
                <h1 className="text-xl font-bold tracking-tight text-surface-text">
                  Choose a verification method
                </h1>
                <p className="mt-2 text-sm text-surface-muted leading-relaxed">
                  How would you like to confirm it&apos;s you?
                </p>

                <div className="mt-6 space-y-3">
                  {factors.map((factor) => (
                    <button
                      key={factor}
                      type="button"
                      onClick={() => void handleFactorChoice(factor)}
                      disabled={busy}
                      className="w-full rounded-md border border-surface-line bg-surface-bg px-4 py-3 text-left transition-colors hover:border-blue-500 disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      <span className="block text-sm font-medium text-surface-text">
                        {FACTOR_LABELS[factor]?.title ?? factor}
                      </span>
                      <span className="mt-0.5 block text-xs text-surface-muted">
                        {FACTOR_LABELS[factor]?.hint ?? ""}
                      </span>
                    </button>
                  ))}
                </div>

                {error && <p className="mt-4 text-sm text-tool-error-text">{error}</p>}

                <button
                  type="button"
                  onClick={handleBack}
                  disabled={busy}
                  className="mt-6 w-full text-xs text-surface-muted hover:text-surface-text disabled:opacity-60"
                >
                  Back to sign in
                </button>
              </>
            ) : (
              <>
                <h1 className="text-xl font-bold tracking-tight text-surface-text">
                  Enter your code
                </h1>
                <p className="mt-2 text-sm text-surface-muted leading-relaxed">
                  {screen === "emailCode" ? (
                    <>
                      We emailed a six-digit code to{" "}
                      <span className="font-medium text-surface-text">{email}</span>. Enter it to
                      finish signing in.
                    </>
                  ) : (
                    <>Open your authenticator app and enter the six-digit code for <BrandName />.</>
                  )}
                </p>

                <label htmlFor="signin-totp" className="mt-6 block text-xs font-medium text-surface-text">
                  Six-digit code
                </label>
                <input
                  id="signin-totp"
                  // `text` with a numeric mode, not `type="number"`: a number input strips
                  // leading zeros, and a TOTP code beginning 0 is perfectly ordinary.
                  type="text"
                  inputMode="numeric"
                  // Six is the whole code, so a paste of anything longer is a mistake worth
                  // truncating rather than submitting.
                  maxLength={6}
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
                    setError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleTotp();
                    }
                  }}
                  autoFocus
                  // `one-time-code` lets the OS offer a code from Messages/Keychain.
                  autoComplete="one-time-code"
                  /*
                    ⚠ SIX POSITIONS, NOT AN EXAMPLE CODE. The placeholder is 000000, the same as the portal's —
                    this field had none at all, and the portal's said
                    `123456`, which reads as a code somebody might actually try.

                    ⚠ AND IT MUST NOT READ AS PRE-FILLED. This input is `font-mono text-lg` and centred, so a
                    placeholder at normal ink weight looks like a VALUE already entered — on a field whose
                    submit button is disabled until six characters exist, that is actively confusing.
                    `placeholder:text-surface-faint` is 5.73:1 on `surface-bg`: clearly legible, clearly not
                    typed. The tracking is repeated for the placeholder because letter-spacing on a centred
                    monospace field does not otherwise apply to it.
                  */
                  placeholder="000000"
                  disabled={busy}
                  className="mt-1.5 w-full rounded-md border border-surface-line bg-surface-bg px-3 py-2 text-center font-mono text-lg tracking-[0.3em] text-surface-text placeholder:text-surface-faint placeholder:tracking-[0.3em] focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60"
                />

                <button
                  type="button"
                  onClick={handleTotp}
                  disabled={busy || code.length < 6}
                  aria-busy={busy || undefined}
                  className="mt-6 w-full rounded-md bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                >
                  {busy ? "Verifying…" : "Verify"}
                </button>

                <button
                  type="button"
                  onClick={handleBack}
                  disabled={busy}
                  className="mt-3 w-full rounded-md border border-surface-line px-6 py-2.5 text-sm font-medium text-surface-text hover:bg-surface-bg disabled:opacity-50 transition-colors"
                >
                  Back
                </button>
              </>
            )}

            {/* role=alert so the failure is ANNOUNCED, not only seen. */}
            {error && (
              <div
                role="alert"
                className="mt-4 rounded-md bg-red-500/10 border border-red-500/40 px-3 py-2.5 text-sm text-red-400"
              >
                {error}
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="border-t border-surface-line px-6 py-5 text-center text-xs text-surface-muted">
        <p>
          &copy; {BRAND_YEAR} {PRODUCT_NAME}
        </p>
      </footer>
    </div>
  );
}
