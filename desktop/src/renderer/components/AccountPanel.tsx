import { useEffect, useState } from "react";
import {
  FEEDBACK_BOUNDS,
  FEEDBACK_FIELD_LABELS,
  FEEDBACK_PROMPTS,
  FEEDBACK_SUBJECT_PLACEHOLDERS,
  FEEDBACK_TITLES,
  GIVE_FEEDBACK_LABEL,
  MAX_FEEDBACK_MESSAGE,
  MAX_FEEDBACK_SUBJECT,
  REPORT_BUG_LABEL,
  checkFeedbackField,
  checkFeedbackReport,
  feedbackWordHint,
  type FeedbackField,
  type FeedbackKind,
} from "@praimana/shared";

const api = (window as any).electronAPI;

/**
 * ── THE SIGNED-IN ACCOUNT: READ-ONLY, EXCEPT THE PLATFORM URL ──
 *
 * ⚠ READ-ONLY IS STILL THE DESIGN FOR THE IDENTITY FIELDS. Each is owned somewhere else and cannot
 * honestly be edited from a desktop client:
 *
 *   name / organisation  the identity service derives `name` from firstName + lastName and refuses to
 *                        accept it directly, so a field here would have to patch the parts instead.
 *   email                Cognito owns it, and changing it would break the invitation → role lookup.
 *   role                 authoritative from the token's `cognito:groups` claim. Accepting it from a
 *                        client would be privilege escalation by request — the identity service says so
 *                        in as many words and refuses it on PATCH.
 *   experience / team    set by joining, not by typing.
 *   issuer / client id / Hosted UI / API
 *                        DERIVED from the platform, not independently settable. They are discovered
 *                        from `GET <portal>/api/desktop/config`, and four fields that must agree with
 *                        each other are a config, not four inputs.
 *
 * ⚠ NO FIELD IS EDITABLE, and the page is better for it. The platform arrives WITH the session from
 * the portal, so there is no value here for a participant
 * to set — only one ACTION, "sign in to another experience", which discards the configuration
 * deliberately and is confirmed because it ends the session.
 *
 * The distinction the original note drew still holds and is what keeps this honest: an input that
 * silently fails, or one that appears to work and is overwritten on next login, is worse than a plain
 * statement of fact.
 */

interface CognitoConfig {
  issuer: string;
  clientId: string;
  /** From AWS OIDC discovery — the real URL the browser opens to sign in. */
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
}

interface AccountDetails {
  name: string | null;
  email: string | null;
  userId: string | null;
  role: string | null;
  organization: string | null;
  teamId: string | null;
  teamName: string | null;
  workshopId: string | null;
  workshopName: string | null;
  serverUrl: string | null;
  cognito: CognitoConfig | null;
}

/**
 * Role codes as the platform stores them, mapped to what a participant would call them.
 *
 * The raw values are shown too (see below): a facilitator debugging a permissions question needs the exact
 * string the token carries, and "Executive" is not greppable against `cognito:groups`.
 */
const ROLE_LABELS: Record<string, string> = {
  PARTICIPANT: "Participant",
  EXECUTIVE: "Executive",
  JUDGE: "Judge",
  FACILITATOR: "Facilitator",
  ADMIN: "Administrator",
};

export function AccountPanel({ onSignOut }: { onSignOut?: () => void }) {
  const [details, setDetails] = useState<AccountDetails | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * ⚠ NO `appVersion` STATE ANY MORE. It existed to put the build number in a `mailto:` body; the version is
   * now read by `feedback:submit` in MAIN, from `app.getVersion()`, which is where it actually lives. A
   * renderer round-tripping over IPC for a value main already has, only to send it straight back, was a
   * consequence of the mailto being composed on this side.
   */
  useEffect(() => {
    let cancelled = false;
    api
      .getAccountDetails()
      .then((d: AccountDetails) => {
        if (cancelled) return;
        setDetails(d);
        setLoading(false);
      })
      .catch(() => {
        // The handler already degrades field by field, so a rejection here means the CHANNEL failed —
        // nothing useful to show, and the empty state below says so rather than hanging on a spinner.
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * ⚠ NO FOCUS TRAP AND NO ESCAPE HANDLER ANY MORE — both belonged to the dialog this used to be.
   *
   * As a routed VIEW it is reached and left through the nav, exactly like Settings, so there is nothing to
   * trap and nothing to dismiss. Keeping an Escape listener would have made Escape do something invisible on
   * a screen that is not modal.
   */

  /**
   * Which report form is open, or null.
   *
   * ⚠ THIS REPLACED TWO `mailto:` LINKS. The report is POSTed and
   * the platform emails staff, so the participant's own mail client is out of the path — and there is no
   * support address to configure, which is what used to make these links render as nothing at all.
   *
   * ⚠ AND THE CONTEXT MOVED TO MAIN. The version and the ids are assembled in `feedback:submit`, which is
   * what knows them; this renderer sends a kind and a message. So the `supportContext` block that used to
   * live here left with the mailto.
   */
  const [reporting, setReporting] = useState<FeedbackKind | null>(null);

  return (
    /*
      ── A ROUTED VIEW, NOT A MODAL ──

      Same shell as `SettingsView`: a scrolling column on the dark surface with `max-w-2xl mx-auto` on an inner
      wrapper, so the background spans the window while the content stays at a readable measure. The heading
      matches Settings' `text-2xl font-bold` rather than the dialog's small `text-sm`, because it is now a page
      title rather than a popup's label.
    */
    <div className="flex-1 overflow-y-auto bg-surface-bg p-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-1 text-2xl font-bold text-surface-text">Account</h1>
        {/*
          The read-only nature is STATED, not implied by the absence of inputs. A page of facts with no edit
          control reads as "not implemented yet" unless it says otherwise.
        */}
        <p className="mb-6 text-sm text-surface-muted">
          Read-only — these are managed by the experience platform.
        </p>

        {/* No inner scroller: the view's own container scrolls, and nesting two was a leftover from the modal —
            which needed its own because the dialog had a fixed max height. */}
        {loading ? (
            <p className="py-6 text-center text-xs text-surface-muted">Loading account details…</p>
          ) : !details ? (
            <p className="py-6 text-center text-xs text-surface-muted">
              Account details are unavailable right now.
            </p>
          ) : (
            <div className="space-y-5">
              <Section title="You">
                <Row label="Name" value={details.name} />
                <Row label="Email" value={details.email} />
                {/*
                  ROLE, WITH ITS RAW CODE ALONGSIDE. The friendly label is for the participant; the code is
                  what appears in `cognito:groups` and in every authorization decision, so a facilitator
                  diagnosing "why can't I see insights" needs the exact string rather than a translation.
                */}
                <Row
                  label="Role"
                  value={
                    details.role
                      ? `${ROLE_LABELS[details.role] ?? details.role} (${details.role})`
                      : null
                  }
                  /*
                    Distinguished from "empty": role is fetched, so absent means the profile call did not
                    land — offline, or a token that has expired. Saying "not available" is honest where a
                    blank would read as "you have no role".
                  */
                  missing="Not available — could not reach the platform"
                />
                {details.organization && <Row label="Organisation" value={details.organization} />}
              </Section>

{/*
                ── "EXPERIENCE", NOT "WORKSHOP" ──

                Renamed everywhere a participant can read it. The
                BACKEND still says workshop — `/v1/workshops/:id`, `workshopId`, the
                `workshop_id` setting — and deliberately so: renaming a wire contract and a
                stored key would break every request and every existing install for a word
                nobody sees. The vocabulary split is between what we CALL it and what we SEND.
              */}
              <Section title="Experience">
                {/*
                  The experience's NAME, resolved from `GET /v1/workshops/:id`. The id is shown beneath it
                  rather than instead of it: the name is what a participant recognises, and the id is what
                  appears in a support conversation or an S3 key.
                */}
                <Row label="Experience" value={details.workshopName} missing="Not available" />
                <Row label="Experience ID" value={details.workshopId} mono />
                <Row label="Team" value={details.teamName} missing="Not on a team" />
                <Row label="Team ID" value={details.teamId} mono />
                {/*
                  THE TEAM CODE, moved here from Settings. It is the one identifier a participant
                  genuinely shares with someone, and it belongs with the team it joins — not among
                  preferences. Copyable for the same reason it always was.
                */}
                <TeamCodeRow />
              </Section>

              {/*
                ── ⚠ REPORT A BUG / GIVE FEEDBACK, IN THE APP ────────────────────────────────────
                Buttons, not links, since the mailto went. An INLINE form rather than a modal: this is
                already a routed page reached from the nav, so there is nothing to overlay and a dialog on a
                page would be a second dismissal idiom for no reason.

                ⚠ ALWAYS PRESENT. The mailto version rendered nothing without a configured address, which is
                how it came to be invisible. A stored report has no address to configure.
              */}
              <Section title="Help">
                {reporting ? (
                  <FeedbackForm kind={reporting} onDone={() => setReporting(null)} />
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2 px-3 py-2.5">
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
                          className="rounded border border-surface-line px-2.5 py-1 text-[11px] font-medium text-surface-text transition-colors hover:border-brand-accent hover:bg-surface-raised"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="px-3 pb-2.5 text-[10px] text-surface-muted">
                      Goes straight to the people running the platform, with your app version and the
                      experience you are in already attached.
                    </p>
                  </>
                )}
              </Section>

              {/* ── ⚠ NO "SIGN-IN CONFIGURATION" SECTION, AND NO POOL ──
                  Removed deliberately: issuer, client id, the two OAuth endpoints,
                  scopes, the API origin and the Cognito pool id are all gone from this page.

                  Nothing is being HIDDEN in a security sense — every one of those values is
                  public by design and travels in a normal OAuth redirect. They are gone because
                  they are not a participant's business: they are facts about our deployment, and
                  a page about "you" that lists four AWS endpoints teaches the reader that this
                  app is complicated rather than that their account is fine.

                  ⚠ THEY ARE STILL FETCHED, and that is not an oversight — `account:getDetails`
                  returns them and `platform:get` still exposes them, because a facilitator
                  debugging a connection needs them and the drift check compares them. What
                  changed is only that this VIEW does not render them.

                  Reset ("sign in to another experience") stays, because it is an ACTION rather
                  than a fact, and it is the only way to leave a platform from inside the app. */}
              <PlatformSection onSignOut={onSignOut} />

              <Row label="User ID" value={details.userId} mono />
            </div>
          )}
      </div>
    </div>
  );
}

/**
 * ── THE PLATFORM, AND THE ONE ACTION THAT LEAVES IT ──
 *
 * Read-only facts plus "Sign in to another experience".
 *
 * ⚠ NOTHING HERE IS EDITABLE ANY MORE, and that is a simplification rather than a limitation.
 * An earlier revision had a pasteable Access Key here. The platform now arrives with the
 * session from the portal, so there is no value for a user to hold, and an input would only
 * offer them a way to break a working install.
 *
 * ⚠ RESET IS DISTINCT FROM SIGN OUT, and the difference is the whole reason it exists. Sign-out
 * keeps the configuration, so signing back in needs nothing re-entered — that is why the
 * platform keys are absent from `SIGN_OUT_SETTINGS`. Reset is the deliberate act of LEAVING a
 * platform, and it is the only thing that discards the config.
 *
 * It is confirmed, and the confirmation names what is lost: the saved accounts for that
 * platform go too, and cannot be recovered from inside the app. A destructive action that
 * reads as routine is how someone loses a session they wanted.
 */
/**
 * The team's join code, copyable.
 *
 * Moved here from Settings. It is the one identifier a participant
 * actually shares with another person, so it belongs beside the team it joins rather than among
 * preferences — and two copies of it was two places to look and one to forget.
 *
 * Its own component because it needs `copied` state, and threading that through the whole panel
 * for one row would make every other row re-render on a copy.
 */
function TeamCodeRow() {
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getSetting("team_invite_code")
      .then((value: string | null) => {
        if (!cancelled && value) setCode(value);
      })
      .catch(() => {
        /* Renders as "—", like any other absent value on this page. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function copy() {
    if (!code) return;
    navigator.clipboard.writeText(code);
    setCopied(true);
    // Long enough to read, short enough that the button is ready again if the first paste went
    // to the wrong window.
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex items-baseline gap-3 border-t border-surface-line px-3 py-2">
      <span className="w-24 flex-shrink-0 text-[11px] text-surface-muted">Team code</span>
      <span className="min-w-0 flex-1 select-text break-all font-mono text-xs tracking-wider text-surface-text">
        {code || "—"}
      </span>
      <button
        type="button"
        onClick={copy}
        disabled={!code}
        className="flex-shrink-0 rounded border border-surface-line px-2 py-0.5 text-[11px] text-surface-muted transition-colors hover:text-surface-text disabled:opacity-50"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function PlatformSection({ onSignOut }: { onSignOut?: () => void }) {
  const [current, setCurrent] = useState<{ portalUrl: string; poolId: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .getPlatformConfig()
      .then((config: { configured: boolean; portalUrl?: string; poolId?: string }) => {
        if (cancelled || !config?.configured) return;
        setCurrent({ portalUrl: config.portalUrl || "", poolId: config.poolId || "" });
      })
      .catch(() => {
        /* Degrades to "Not available", like every other remote field on this page. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * End the session, keeping the configuration.
   *
   * One call: main stops the team event stream, clears the badge, drops its cached bearer, and
   * wipes the session settings. It proceeds even on failure — the user asked to leave, so we
   * route back to the form regardless and let the next request's 401 handle a session that
   * outlived the attempt.
   */
  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setError("");
    try {
      await api.signOut();
    } catch {
      /* Route away anyway — see above. */
    } finally {
      setSigningOut(false);
    }
    onSignOut?.();
  }

  async function handleReset() {
    if (resetting) return;
    setResetting(true);
    setError("");
    try {
      const result = await api.resetPlatform();
      if (!result?.ok) {
        setError(result?.error || "Could not reset the configuration.");
        return;
      }
      // Main broadcasts `platform:changed`, so App.tsx routes to the connect screen and this
      // component unmounts. Nothing to update here.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset the configuration.");
    } finally {
      setResetting(false);
    }
  }

  return (
    <section>
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-surface-faint">
        Platform
      </h3>
      <div className="overflow-hidden rounded-md border border-surface-line bg-surface-panel">
        <Row label="Website" value={current?.portalUrl} mono missing="Not available" />
        <Row label="Pool" value={current?.poolId} mono missing="Not available" />

        <div className="border-t border-surface-line px-3 py-2.5">
          {!confirming ? (
            <>
              {/*
                ── TWO ACTIONS, AND THE DIFFERENCE IS THE POINT ──

                SIGN OUT ends the session and KEEPS the configuration, so signing back in needs
                nothing re-entered. That is why the platform keys are absent from
                `SIGN_OUT_SETTINGS` in main.

                SIGN IN TO ANOTHER EXPERIENCE discards the configuration too, and is the only way
                to leave a platform from inside the app. It is confirmed because it also forgets
                the saved accounts for that platform, which cannot be recovered here.

                Sign out is the ordinary one, so it leads and looks ordinary; reset is quieter and
                asks first.
              */}
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                aria-busy={signingOut || undefined}
                // `tool-error-text` (5.98:1 on the panel) rather than a light-theme red, which
                // measures 3.04:1 here — legal for an indicator, illegal for words in a button.
                // The border stays neutral until hover so it does not read as an error state
                // before it is touched.
                className="rounded border border-surface-line px-2.5 py-1 text-[11px] font-medium text-tool-error-text transition-colors hover:border-tool-error hover:bg-surface-raised disabled:opacity-50"
              >
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
              <p className="mt-1.5 mb-3 text-[10px] text-surface-muted">
                Ends this session. Your experience stays connected, so signing back in needs
                nothing re-entered.
              </p>

              <button
                type="button"
                onClick={() => {
                  setConfirming(true);
                  setError("");
                }}
                className="rounded border border-surface-line px-2.5 py-1 text-[11px] text-surface-muted transition-colors hover:text-surface-text"
              >
                Sign in to another experience
              </button>
              <p className="mt-1.5 text-[10px] text-surface-muted">
                Disconnects this app so you can connect it to a different experience.
              </p>
            </>
          ) : (
            /*
              A two-step confirm rather than a native dialog: this view is routed, and an OS
              dialog here would be the only modal in the app. The destructive button is NOT the
              default-looking one, and the consequence is spelled out above it.
            */
            <div role="group" aria-label="Confirm disconnecting from this platform">
              <p className="text-[11px] text-surface-text">
                Disconnect from this platform? You&apos;ll be signed out, and the saved accounts
                for it will be forgotten. You&apos;ll need a new link from the website to come
                back.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleReset}
                  disabled={resetting}
                  aria-busy={resetting || undefined}
                  className="rounded bg-red-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {resetting ? "Disconnecting…" : "Disconnect"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={resetting}
                  className="rounded border border-surface-line px-2.5 py-1 text-[11px] text-surface-muted hover:text-surface-text disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mt-2 rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-400"
            >
              {error}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-surface-faint">
        {title}
      </h3>
      <div className="divide-y divide-surface-line overflow-hidden rounded-md border border-surface-line bg-surface-panel">
        {children}
      </div>
    </section>
  );
}

/**
 * One labelled fact.
 *
 * `select-text` on the value and NOT on the label: these are ids, URLs and a client id — things people copy
 * into a ticket or a terminal — and a selection that drags the label in with it has to be cleaned up by
 * hand. The whole dialog is read-only, so selecting text is the only interaction it supports.
 */
function Row({
  label,
  value,
  mono,
  missing = "—",
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  /** Shown when the value is absent. Worded per-field, because "why" differs. */
  missing?: string;
}) {
  const present = typeof value === "string" && value.length > 0;
  return (
    <div className="flex items-baseline gap-3 px-3 py-2">
      <span className="w-24 flex-shrink-0 text-[11px] text-surface-muted">{label}</span>
      <span
        className={`min-w-0 flex-1 break-all text-xs ${
          present ? "select-text text-surface-text" : "italic text-surface-faint"
        } ${present && mono ? "font-mono" : ""}`}
        // The full value on hover, since a long issuer URL wraps rather than truncates but is still
        // easier to read in one line in a tooltip.
        title={present ? value : undefined}
      >
        {present ? value : missing}
      </span>
    </div>
  );
}

/**
 * ── THE REPORT FORM, INLINE IN THE HELP SECTION ────────────────────────────────────────────
 *
 * REPLACES A `mailto:`. The report is stored by the platform, which emails
 * staff — so the participant's mail client is no longer part of the path and there is no address to
 * configure.
 *
 * ⚠ THE CONTEXT IS NOT COLLECTED HERE. `feedback:submit` in main assembles the app version, the experience
 * and the team, because main is what knows them; and the SERVICE records who is reporting from the verified
 * token. This component sends a kind and a message, which is all a renderer should be trusted with.
 *
 * ⚠ `maxLength` IS THE SHARED CONSTANT, the same number the service refuses on. A textarea that accepted
 * more would produce a refusal after the writing — the worst moment to be told.
 *
 * ── ⚠ TWO FIELDS, WITH WORD FLOORS AS WELL AS CEILINGS ──
 *
 * The bounds: subject 5–15 words, description 20–200. The same obligations the portal's
 * dialog carries apply here and for the same reason — a minimum is friction, so it is stated under the field
 * BEFORE anything is typed, the counter counts UP to the floor so progress is visible, and Send names why it
 * is disabled. `checkFeedbackReport` is the shared verdict, so this form, main and the service agree.
 */
/**
 * The line under a report field: what it wants, and how far along you are.
 *
 * ⚠ UNDER THE FLOOR IS NOT AN ERROR STATE — half-written is the normal condition of a field being written,
 * so "7 / 20 words" is muted. The error colour is kept for over the ceiling, the one case where more typing
 * makes it worse. Colouring in-progress input as a failure teaches people to ignore the colour.
 */
function FieldHint({ field, value }: { field: FeedbackField; value: string }) {
  const { minWords, maxWords } = FEEDBACK_BOUNDS[field];
  const over = checkFeedbackField(field, value)?.code.endsWith("_TOO_LONG") ?? false;

  return (
    <span className="mt-1 flex items-baseline justify-between text-[10px]">
      <span className="text-surface-muted">
        {minWords}–{maxWords} words
      </span>
      <span className={over ? "font-medium text-tool-error-text" : "text-surface-muted"}>
        {feedbackWordHint(field, value)}
      </span>
    </span>
  );
}

function FeedbackForm({ kind, onDone }: { kind: FeedbackKind; onDone: () => void }) {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const problem = checkFeedbackReport({ subject, message });

  async function send() {
    setSending(true);
    setError("");
    try {
      const res = await api.submitFeedback({ kind, subject, message, location: "Account" });
      if (!res?.ok) throw new Error(res?.error || "Could not send that");
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send that");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div className="px-3 py-2.5">
        {/*
          ⚠ A DISTINCT SUCCESS STATE RATHER THAN CLOSING ON SEND. Closing immediately leaves a reporter with
          no evidence anything happened, and the commonest response to that is to send it again — which is
          how an inbox fills with duplicates.
        */}
        <p className="text-xs text-surface-text">
          Thank you — this has been sent to the people running the platform.
        </p>
        <button
          type="button"
          onClick={onDone}
          className="mt-2 rounded border border-surface-line px-2.5 py-1 text-[11px] text-surface-text hover:bg-surface-raised"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="px-3 py-2.5">
      {/*
        ⚠ WHICH CHANNEL YOU ARE IN, VISIBLY. This form REPLACES the two buttons that opened it, so without a
        heading there is nothing left on screen saying whether this is a bug or a suggestion — the title used
        to exist only as the textarea's `aria-label`, i.e. for screen readers and nobody else. The two are
        triaged differently, so a reporter needs to be able to see they picked the one they meant.
      */}
      <h4 className="mb-1 text-[11px] font-semibold text-surface-text">{FEEDBACK_TITLES[kind]}</h4>
      <p className="mb-1.5 text-[11px] text-surface-muted">{FEEDBACK_PROMPTS[kind]}</p>
      <input
        type="text"
        value={subject}
        maxLength={MAX_FEEDBACK_SUBJECT}
        onChange={(e) => setSubject(e.target.value)}
        aria-label={FEEDBACK_FIELD_LABELS.subject}
        placeholder={FEEDBACK_SUBJECT_PLACEHOLDERS[kind]}
        className="w-full rounded-md border border-surface-line bg-surface-raised px-3 py-2 text-sm text-surface-text outline-none placeholder:text-surface-muted focus:border-brand-accent"
      />
      <FieldHint field="subject" value={subject} />
      <textarea
        rows={5}
        value={message}
        maxLength={MAX_FEEDBACK_MESSAGE}
        onChange={(e) => setMessage(e.target.value)}
        aria-label={FEEDBACK_FIELD_LABELS.message}
        // `text-surface-text` on a raised fill, never `muted` — muted measures 4.06:1 there.
        className="mt-2 w-full rounded-md border border-surface-line bg-surface-raised px-3 py-2 text-sm text-surface-text outline-none placeholder:text-surface-muted focus:border-brand-accent"
      />
      <FieldHint field="message" value={message} />
      {error && <p className="mt-1 text-[11px] text-tool-error-text">{error}</p>}
      {/*
        Why Send is disabled, in words, next to Send. `aria-live` so it reaches a screen reader as it
        changes rather than only when the panel is re-read.
      */}
      {problem && !error && (
        <p aria-live="polite" className="mt-1 text-[11px] text-surface-muted">
          {problem.message}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => void send()}
          // Disabled until BOTH fields pass, as well as in-flight: main and the service refuse the same
          // input, and finding that out after pressing Send is a worse way to learn it.
          disabled={sending || problem !== null}
          className="rounded-md bg-brand-strong px-3 py-1 text-[11px] text-white transition-colors hover:bg-brand-accent hover:text-surface-bg disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded border border-surface-line px-2.5 py-1 text-[11px] text-surface-text hover:bg-surface-raised"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
