"use client";

import { useEffect, useState } from "react";
import { signIn as nextAuthSignIn } from "next-auth/react";
import {
  confirmSignIn,
  confirmSignUp,
  fetchAuthSession,
  resendSignUpCode,
  resetPassword,
  confirmResetPassword,
  signIn,
  signOut as amplifySignOut,
} from "aws-amplify/auth";
import {
  validateProfile,
  normalizeProfileField,
  type ProfileFieldKey,
  type ProfileFields,
} from "@praimana/shared";
import { trpc } from "@/lib/trpc/client";
import {
  AuthButton,
  AuthCodeField,
  AuthError,
  AuthField,
  AuthLinkButton,
  AuthNotice,
  AuthShell,
} from "./AuthShell";
import { TotpQrCode } from "./TotpQrCode";
import { EMPTY_PROFILE_FIELDS, ProfileFieldsForm } from "./ProfileFieldsForm";
import {
  authErrorMessage,
  screenForSignInStep,
  TOTP_ISSUER,
  type AuthScreen,
} from "@/lib/auth-flow";
import { configureAmplify, isAmplifyConfigured } from "@/lib/amplify";
import { clearSharedActivity, idleCheck, readSharedActivity } from "@/lib/idle-timeout";

/**
 * The factor names Cognito accepts as a challenge response at a selection step.
 *
 * ⚠ SMS IS KEPT IN THE UNION THOUGH THE POOL DOES NOT ENABLE IT. This list describes what
 * COGNITO can ask for, not what this deployment happens to switch on, and the screen renders
 * only what Cognito actually offers. Trimming it here is how the UI ends up unable to render a
 * factor someone enables later.
 */
const MFA_CHOICES = ["TOTP", "EMAIL", "SMS"] as const;
type MfaChoice = (typeof MFA_CHOICES)[number];

const isMfaChoice = (v: string): v is MfaChoice => (MFA_CHOICES as readonly string[]).includes(v);

/** How each factor is described on the selection screen. */
const MFA_LABELS: Record<MfaChoice, { title: string; hint: string }> = {
  TOTP: {
    title: "Authenticator app",
    hint: "Use a 6-digit code from your authenticator",
  },
  EMAIL: {
    title: "Email",
    hint: "We'll send a code to your email address",
  },
  SMS: {
    title: "Text message",
    hint: "Send a code to your phone",
  },
};

/**
 * The whole auth journey, sign-in, email confirmation, TOTP enrolment and challenge,
 * MFA selection, forced password change, the first-login profile step, forgot/reset -
 * driven by the Amplify Auth SDK.
 *
 * The shape of this component is dictated by how Cognito actually behaves: a
 * sign-in is not one call but a conversation. `signIn()` returns a `nextStep`, and
 * because this pool has MFA ON, a first sign-in ALWAYS continues into TOTP
 * enrolment and every later one into a TOTP challenge. So the component is a small
 * state machine over `screen`, with the step→screen mapping factored into
 * lib/auth-flow.ts (tested there) rather than inlined as a pile of conditionals.
 *
 * ── THERE IS NO SIGN-UP SCREEN ANY MORE, AND THAT IS NOT A SIMPLIFICATION ──
 *
 * Registration is ADMIN-PROVISIONED: `AllowAdminCreateUserOnly: true` on the pool
 * means Cognito refuses the SignUp API entirely, so a sign-up form could never
 * succeed, every submit came back as NotAuthorizedException "SignUp is not permitted
 * for this user pool" (see lib/auth-flow.signup-disabled.test.ts, written when an AWS
 * mitigation flipped that flag and broke registration for every invited user).
 *
 * The invited person's journey is now:
 *
 *   temporary password → forced new password → TOTP enrolment → PROFILE → landing
 *
 * The profile step is the one that moved. The three mandatory fields (first name, last
 * name, organisation) used to be Cognito user attributes submitted with the sign-up
 * form. With no sign-up form they are collected HERE, once, immediately after the
 * password is set and the TOTP factor is enrolled, and saved through the identity
 * service's PATCH /me, which is the real validator either way. Collecting them at
 * first login rather than asking the ADMIN to type them per invitee is deliberate: an
 * admin does not know an invitee's preferred first name, and a bulk invite of thirty
 * addresses would become thirty forms.
 *
 * Two things are deliberate and worth not "simplifying" later:
 *
 *  1. Cognito's tokens are NOT the app session. After a completed sign-in we fetch
 *     the ID token and post it to NextAuth's `cognito-token` provider, which
 *     verifies the signature server-side and sets the httpOnly session cookie that
 *     middleware, tRPC, and every server component read. Skipping that step would
 *     leave the browser "signed in" to Cognito and signed OUT of the app.
 *
 *  2. On a failure to establish that server session we call Amplify's signOut().
 *     Otherwise the browser holds valid Cognito tokens with no app session, and the
 *     next visit to /login finds `signIn()` throwing "there is already a signed in
 *     user", a state the user cannot escape by retrying.
 */
export function AuthFlow({
  callbackUrl = "/",
  initialScreen = "signIn",
  /**
   * Prefilled on the invite path. Rendered read-only there, because the invitation
   * AND the admin-created account are both keyed on this address server-side: letting
   * it be edited would produce a sign-in against an account that does not exist, with
   * the invited person unable to see why.
   */
  initialEmail = "",
  lockEmail = false,
  /** A message from OUTSIDE the flow, e.g. NextAuth's ?error= on the login page. */
  initialError = null,
  /**
   * A message from outside the flow explaining WHY this form is being shown, the
   * invite path uses it to say "sign in with the temporary password from your email".
   * Distinct from initialError because it is not a failure, and rendering it as one
   * would make a normal first sign-in look broken.
   */
  initialNotice = null,
}: {
  callbackUrl?: string;
  initialScreen?: AuthScreen;
  initialEmail?: string;
  lockEmail?: boolean;
  initialError?: string | null;
  initialNotice?: string | null;
}) {
  const [screen, setScreen] = useState<AuthScreen>(initialScreen);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [loading, setLoading] = useState(false);
  const [totp, setTotp] = useState<{ uri: string; secret: string } | null>(null);
  /**
   * The factors Cognito offered at the last selection step.
   *
   * Defaults to TOTP alone rather than to every factor: if a selection screen is somehow
   * reached without Cognito having said what it accepts, offering a button that cannot work is
   * worse than offering one that can. TOTP is the factor this pool has always had.
   */
  const [allowedMfa, setAllowedMfa] = useState<readonly MfaChoice[]>(["TOTP"]);
  const [profile, setProfile] = useState<ProfileFields>(EMPTY_PROFILE_FIELDS);
  const [profileErrors, setProfileErrors] = useState<
    Partial<Record<ProfileFieldKey, string>>
  >({});

  // The first-login profile step talks to the BFF, not to Cognito. `utils` is used for
  // an imperative fetch (the check runs once, mid-flow, not as a render-time query) and
  // the mutation is the same one /profile uses, so there is one write path for these
  // three fields rather than two.
  const utils = trpc.useUtils();
  const updateProfile = trpc.auth.updateProfile.useMutation();
  const acceptMyInvitations = trpc.team.acceptMyInvitations.useMutation();

  useEffect(() => {
    configureAmplify();
  }, []);

  /**
   * Whether the signed-in user still owes us the three mandatory profile fields.
   *
   * MUST be called only after the app session cookie exists, `auth.me` is a protected
   * procedure. Both landing paths (a fresh sign-in and the resumed-session path) call
   * this, so there is ONE definition of "needs the profile step" and no way for one path
   * to skip it.
   *
   * `profileComplete` is computed server-side by the identity service from
   * isProfileComplete(), which checks PRESENCE rather than validity, that is
   * deliberate and load-bearing (see the note on that function): re-deriving
   * completeness here with the VALIDATOR would bounce anyone whose stored value predates
   * a rule change to a form whose Save then refuses it. So this asks the server rather
   * than judging the fields itself.
   *
   * Returns FALSE on any failure. An unreadable profile must not trap a user who has
   * just authenticated successfully; the worst case is a prompt not shown, versus a
   * lockout, and /profile is always available.
   */
  async function needsProfileStep(): Promise<boolean> {
    try {
      const me = await utils.auth.me.fetch();
      return !me?.profileComplete;
    } catch {
      return false;
    }
  }

  /**
   * Record that this person has TAKEN UP their invitation.
   *
   * WHY IT IS HERE, of all places. Registration is admin-provisioned now, and that
   * removed the only thing that ever marked an invitation accepted, the old self-signup
   * flow did it as part of registering. With the account created by an admin, an invited
   * FACILITATOR could finish the entire journey (Cognito CONFIRMED, group assigned,
   * profile row written) while their invitation still read `status: PENDING` with
   * `acceptedAt: null`. Confirmed live; the Administration screen showed "Pending" for
   * someone who had plainly accepted.
   *
   * `acceptedAt` means "the person acted", which is why the flip cannot move earlier into
   * provisioning: the revoke gate refuses to delete an ACCEPTED row precisely because the
   * row is the evidence someone redeemed the grant. Stamping it when an ADMIN creates the
   * account would assert the invitee acted before they had seen the email, and would make
   * every provisioned-but-unused account un-revocable. Signing in is the first moment they
   * demonstrably acted, and this component is the only code that knows a sign-in just
   * completed.
   *
   * CALLED ON EVERY SIGN-IN, not just the first, and that is fine by design rather than
   * by luck: the service's write is conditional on the row not already being ACCEPTED, so
   * `acceptedAt` records the first acceptance and never moves. A returning user's call
   * performs no write at all.
   *
   * AWAITED BUT NEVER FATAL. It runs before the navigation so the flip is not racing a
   * page unload, and every failure is swallowed, a stale status is a cosmetic defect on
   * an admin screen, while a sign-in that fails because a status update errored locks a
   * user out of the product. The next sign-in retries it for free. Deliberately NOT
   * fire-and-forget: an unobserved promise here would be a write we neither wait for nor
   * ever learn about, and the browser may tear it down mid-flight on navigation.
   *
   * MUST run after the app session cookie exists, it is a protected procedure, like
   * `auth.me` above.
   */
  async function markInvitationsAccepted(): Promise<void> {
    try {
      await acceptMyInvitations.mutateAsync();
    } catch {
      // Intentionally silent to the USER: they have signed in successfully and there is
      // nothing for them to act on. The service logs the real cause with correlating
      // identifiers, and answers 200 with a failure count rather than an error for the
      // per-row case, so a rejection here means the call itself did not land.
    }
  }

  /**
   * Everything that must happen ONCE the app session cookie exists, and the one
   * question the caller then has to branch on.
   *
   * ONE function rather than two calls per path, for the reason handleNextStep's comment
   * gives about flags: there are TWO ways to arrive at a live session, a fresh sign-in
   * (establishAppSession) and a resumed Amplify session (the effect below), and the one
   * that forgets a step is the one that breaks silently. A resumed session is a real
   * sign-in for our purposes: someone who closed the tab on the profile step and came
   * back has still taken up their invitation, so recording it on only the fresh path
   * would leave exactly that person PENDING forever.
   *
   * ORDER IS DELIBERATE: the accept runs BEFORE the profile check, because the profile
   * step can park the user on a form indefinitely and the invitation status should not
   * wait on them filling it in. It is also the reason this awaits rather than firing in
   * the background, the profile check's own round trip would otherwise race it.
   */
  async function onSessionEstablished(): Promise<{ needsProfile: boolean }> {
    await markInvitationsAccepted();
    return { needsProfile: await needsProfileStep() };
  }

  /**
   * If Amplify still holds a valid Cognito session, mint the app session from it
   * instead of asking for a password.
   *
   * This is the expiry path, and it's what makes the two session layers behave like
   * one. Our NextAuth cookie is short-lived; Amplify's refresh token is not. When
   * only the cookie has lapsed, the user has not actually signed out of anything -
   * demanding a password AND a TOTP code every half hour would be a regression from
   * the Hosted UI, whose own cookie used to make that round-trip silent.
   *
   * It also disarms a trap: with tokens still in localStorage, `signIn()` throws
   * UserAlreadyAuthenticatedException, so a user who reached this form with a live
   * Amplify session could not have signed in by typing anything.
   *
   * fetchAuthSession() refreshes an expired ID token using the refresh token, and
   * throws (or returns no tokens) when there is nothing valid left, in which case
   * we simply show the form. Only runs on the sign-in screen: mid-journey screens
   * have their own session state that this must not pre-empt.
   */
  const [resuming, setResuming] = useState(initialScreen === "signIn");

  useEffect(() => {
    if (initialScreen !== "signIn") return;

    let cancelled = false;
    (async () => {
      if (!isAmplifyConfigured) {
        if (!cancelled) setResuming(false);
        return;
      }
      configureAmplify();
      try {
        const session = await fetchAuthSession();
        const idToken = session.tokens?.idToken?.toString();
        if (!idToken) throw new Error("no session");

        /**
         * ── ⚠ AN IDLE ABSENCE REFUSES THE SILENT RESUME ────────────────────────────────────────
         *
         * This effect re-mints a full app session from the ~30-day Amplify refresh token with no
         * user interaction, which is the whole point when someone comes back to a tab, and was a
         * hole in the idle timeout when they come back after walking away. A security review
         * traced the path: tab closed, no enforcement point left alive, cookie expired
         * past its 24 hours, and then THIS ran and produced a fresh session with no password and no
         * TOTP. `idle-timeout.ts` states that inactivity "IS a request to leave, made by walking away
         * from an unlocked machine"; honouring that has to include this door.
         *
         * The `sub` comes from the token's own payload, which is UNVERIFIED here, and that is
         * acceptable because of the direction it can fail. A wrong or absent subject means no stored
         * activity matches, so the resume proceeds exactly as before; it cannot manufacture a resume
         * that idleness should have refused. The verified check still happens server-side in
         * `cognito-verify.ts` a moment later.
         *
         * ⚠ AND IT IS DEFENCE IN DEPTH, NOT A BOUNDARY. Someone who can edit localStorage can delete
         * this key, but they can also read the refresh token sitting next to it, so the key is not
         * what stands between them and the session. What this closes is the ordinary case the finding
         * described: a machine left unattended, reopened by whoever is next at the keyboard.
         */
        const subject = session.tokens?.idToken?.payload?.sub;
        if (typeof subject === "string" && subject.length > 0) {
          const now = Date.now();
          const lastActivityAt = readSharedActivity(subject, now);
          if (lastActivityAt !== null && idleCheck(lastActivityAt, now).stage === "IDLE") {
            // Clear both, then show the form: the Amplify session has to go or `signIn()` throws
            // UserAlreadyAuthenticatedException on submit, and the stale instant has to go or the
            // next successful sign-in inherits it and is refused again.
            clearSharedActivity();
            await amplifySignOut().catch(() => {});
            if (!cancelled) setResuming(false);
            return;
          }
        }

        const result = await nextAuthSignIn("cognito-token", {
          idToken,
          redirect: false,
        });
        if (cancelled) return;

        if (result && !result.error) {
          // The SAME post-session work the fresh-sign-in path does, through the SAME
          // function. Without the profile check, someone who closed the tab ON the
          // profile step would be resumed straight into the app on their next visit with
          // none of the three mandatory fields, the one way to skip a step that is
          // supposed to be unskippable. And without the invitation accept, that same
          // person's invitation would stay PENDING forever, since they never take the
          // fresh-sign-in path again.
          const { needsProfile } = await onSessionEstablished();
          if (cancelled) return;
          if (needsProfile) {
            setScreen("completeProfile");
            setResuming(false);
            return;
          }
          window.location.assign(callbackUrl);
          return;
        }
        // A live Cognito session the server won't accept (e.g. no role assigned).
        // Clear it so the form below is usable rather than throwing on submit.
        await amplifySignOut().catch(() => {});
        setResuming(false);
      } catch {
        // No resumable session, the normal case for a first visit.
        if (!cancelled) setResuming(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialScreen, callbackUrl]);

  /**
   * Exchange the Cognito session for OUR server session, then navigate, or stop at
   * the profile step when the three mandatory fields are missing.
   *
   * Uses a full page load (`window.location`) rather than a client-side router
   * push: the destination is chosen by middleware from the freshly-set session
   * cookie, and a soft navigation can render against the pre-sign-in cache.
   *
   * THE PROFILE CHECK HAPPENS AFTER THE COOKIE IS SET, and it has to: `auth.me` and
   * `auth.updateProfile` are protected procedures that read the session cookie, so a
   * profile step before this point would have nothing to authenticate with. The
   * consequence is that a user completing the profile form is already signed in, which
   * is correct and not a hole: the fields are display data, the gate is about
   * completeness rather than authorization, and /profile lets them be edited later
   * anyway.
   */
  async function establishAppSession() {
    const session = await fetchAuthSession();
    const idToken = session.tokens?.idToken?.toString();

    if (!idToken) {
      // Signed in to Cognito with no usable ID token, nothing to verify, so no app
      // session can be minted. Clear the Cognito side so a retry is possible.
      await amplifySignOut().catch(() => {});
      setError("Signed in, but no identity token was returned. Please try again.");
      setLoading(false);
      return;
    }

    // redirect:false so a rejection comes back as a value we can display, rather
    // than as a redirect to NextAuth's own generic error page.
    const result = await nextAuthSignIn("cognito-token", {
      idToken,
      redirect: false,
    });

    if (!result || result.error) {
      // The server refused the token. The likeliest real cause is no Cognito group -
      // which, now that accounts are admin-provisioned, means the group assignment in
      // the provisioning sequence failed and the invite response reported
      // groupAssigned:false. The fix is for an admin to RE-INVITE (which re-asserts the
      // group), so the copy points at that rather than at "wait and retry".
      await amplifySignOut().catch(() => {});
      setError(
        "Your account doesn't have a role assigned yet. Ask whoever invited you to send the invitation again. That repairs it."
      );
      setLoading(false);
      return;
    }

    // The session cookie now exists, so the caller's own profile is readable and their
    // invitation can be marked accepted. An admin-provisioned account has none of the
    // three mandatory fields (nobody has ever been asked for them), so this is where a
    // first-login user is stopped.
    //
    // NEITHER STEP CAN BLOCK SIGN-IN. If the profile cannot be read, a backend blip, a
    // cold Lambda, the user is let through to the app rather than trapped at a form we
    // cannot verify; the fields are display data and /profile remains available. The
    // invitation accept is absorbed the same way, and for a stronger reason: a stale
    // "Pending" on an admin screen is cosmetic, a sign-in that fails is not. Trading a
    // possibly-missed prompt or a stale status for a possible lockout is the correct
    // direction in both cases.
    const { needsProfile } = await onSessionEstablished();
    if (needsProfile) {
      setScreen("completeProfile");
      setError(null);
      setNotice(null);
      setLoading(false);
      return;
    }

    window.location.assign(callbackUrl);
  }

  /**
   * Save the three mandatory profile fields, then land.
   *
   * Goes through the SAME tRPC mutation the /profile page uses, which forwards to the
   * identity service's PATCH /me, the real validator. The courtesy validation below
   * uses the shared `validateProfile`, so the message shown here is the message the API
   * would have returned; that is what keeps a user from being bounced to a form whose
   * Save then refuses the value it asked for.
   */
  async function onCompleteProfile(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const errors = validateProfile(profile);
    setProfileErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setLoading(true);
    try {
      // Normalised before sending for the same reason sign-up did it: a trailing space
      // would persist into the display name forever.
      await updateProfile.mutateAsync({
        firstName: normalizeProfileField(profile.firstName),
        lastName: normalizeProfileField(profile.lastName),
        organization: normalizeProfileField(profile.organization),
      });
      window.location.assign(callbackUrl);
    } catch (err) {
      // A tRPC/BFF rejection, not a Cognito one, its message is already the shared
      // validator's, so it is shown as-is rather than run through authErrorMessage.
      setError(
        err instanceof Error
          ? err.message
          : "Your details couldn't be saved. Please try again."
      );
      setLoading(false);
    }
  }

  /**
   * Route on the step Cognito returned, or finish the sign-in.
   *
   * "done" hands off to establishAppSession(), which mints the app session and THEN
   * decides whether the profile step is needed. That decision is deliberately made
   * there and only there, from the profile the server actually holds, not from a flag
   * threaded through these callers.
   *
   * The alternative was to have each caller say "this was a first login". That is the
   * version that goes wrong: the flow reaches "done" from five places (sign-in, TOTP
   * enrolment, TOTP challenge, MFA selection, forced password change), any one of them
   * can be the last step for a brand-new account depending on what Cognito asks for,
   * and the one that forgets the flag is the one that skips the mandatory fields
   * silently. Asking the server is both simpler and cannot be forgotten.
   */
  async function handleNextStep(step: string) {
    const { screen: next, message } = screenForSignInStep(step);

    if (next === "done") {
      await establishAppSession();
      return;
    }

    // TOTP enrolment carries the secret in the step PAYLOAD, which a bare step
    // string cannot convey, so this function must never be the one that routes to
    // the totpSetup screen. Callers holding a nextStep object use
    // advanceAfterChallenge() instead; see the note there.
    setScreen(next);
    setError(message);
    setNotice(null);
    setCode("");
    setLoading(false);
  }

  /**
   * Advance from a `nextStep` object, extracting the TOTP enrolment secret when the
   * next step is enrolment.
   *
   * This exists because the secret is only ever available HERE, on the step object
   * Amplify just returned. Four handlers can receive CONTINUE_SIGN_IN_WITH_TOTP_SETUP
   *, first sign-in, MFA selection, post-confirmation sign-in, and a forced password
   * change, and three of them each had their own copy of this extraction. The fourth
   * (the forced password change, which is the ONLY path an admin-provisioned user
   * takes) called handleNextStep instead and so rendered the QR screen with no
   * secret. Routing every caller through one function is what stops the next handler
   * reintroducing that.
   */
  async function advanceAfterChallenge(nextStep: {
    signInStep: string;
    /** Which factors Cognito will accept at a selection step. Drives the buttons shown. */
    allowedMFATypes?: readonly string[];
    totpSetupDetails?: {
      sharedSecret: string;
      getSetupUri: (issuer: string, account?: string) => URL;
    };
  }) {
    // Remember what Cognito offered, so the selection screen renders the real options rather
    // than a guess. Cleared implicitly on the next selection step.
    if (nextStep.allowedMFATypes) {
      setAllowedMfa(nextStep.allowedMFATypes.filter(isMfaChoice));
    }

    /**
     * ⚠ ANSWERED WITHOUT A SCREEN. Cognito asks for the destination address; the only one it
     * accepts is the account's own, which the user typed on the sign-in form seconds ago. So
     * this is answered directly and the user goes straight to the code entry, the alternative
     * is a form whose only correct value is already known.
     */
    if (nextStep.signInStep === "CONTINUE_SIGN_IN_WITH_EMAIL_SETUP") {
      await submitEmailSetup(email);
      return;
    }
    if (nextStep.signInStep === "CONTINUE_SIGN_IN_WITH_TOTP_SETUP") {
      const details = nextStep.totpSetupDetails;
      if (!details) {
        // Fail loudly rather than showing an unscannable QR code. A user who cannot
        // enrol cannot sign in at all, and a blank code with no message is the one
        // outcome they cannot act on or report usefully.
        setError(
          "We couldn't start authenticator setup. Please sign in again, and contact your facilitator if it keeps happening."
        );
        setLoading(false);
        return;
      }
      setTotp({
        uri: details.getSetupUri(TOTP_ISSUER, email).toString(),
        secret: details.sharedSecret,
      });
      setScreen("totpSetup");
      setLoading(false);
      return;
    }
    await handleNextStep(nextStep.signInStep);
  }

  async function onSignIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);

    try {
      // Amplify v6 defaults to SRP, which is what this pool allows
      // (ALLOW_USER_SRP_AUTH). The password is never sent in the clear.
      const { nextStep } = await signIn({ username: email, password });

      await advanceAfterChallenge(nextStep);
    } catch (err) {
      // "already a signed in user": a previous attempt left Cognito tokens behind
      // without an app session. Clear them and tell the user to retry, rather than
      // leaving them stuck on an error they can't act on.
      if (
        typeof err === "object" &&
        err !== null &&
        "name" in err &&
        String((err as { name: unknown }).name) === "UserAlreadyAuthenticatedException"
      ) {
        await amplifySignOut().catch(() => {});
        setError("Your previous session was still open. Please sign in again.");
        setLoading(false);
        return;
      }

      // An unconfirmed user must finish email confirmation; send them there rather
      // than showing an error they can do nothing about on this screen.
      //
      // Unreachable on the admin-provisioned path, those accounts are created with
      // email_verified:true (the invitation IS the proof of the address) and go straight
      // to the force-change-password challenge. Kept because accounts that registered
      // through the OLD self-signup flow may still be sitting unconfirmed, and because
      // deleting a real branch to tidy up is how a user ends up stranded.
      if (
        typeof err === "object" &&
        err !== null &&
        "name" in err &&
        String((err as { name: unknown }).name) === "UserNotConfirmedException"
      ) {
        setScreen("confirmSignUp");
        setNotice("Enter the confirmation code we emailed you.");
        setLoading(false);
        return;
      }

      setError(authErrorMessage(err));
      setLoading(false);
    }
  }

  /** Finish TOTP ENROLMENT: prove the authenticator works, then continue sign-in. */
  async function onVerifyTotpSetup(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // During sign-in-driven enrolment the code goes to confirmSignIn (not
      // verifyTOTPSetup, which is for enrolling an ALREADY signed-in user).
      const { nextStep } = await confirmSignIn({ challengeResponse: code.trim() });
      await handleNextStep(nextStep.signInStep);
    } catch (err) {
      setError(authErrorMessage(err));
      setCode("");
      setLoading(false);
    }
  }

  /** The per-sign-in TOTP (or SMS) challenge. */
  async function onConfirmChallenge(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { nextStep } = await confirmSignIn({ challengeResponse: code.trim() });
      await handleNextStep(nextStep.signInStep);
    } catch (err) {
      setError(authErrorMessage(err));
      setCode("");
      setLoading(false);
    }
  }

  /**
   * Cognito asked which second factor to use, or which to ENROL.
   *
   * ⚠ "EMAIL" IS NEW AND "SMS" IS NOT REMOVED. The pool enables TOTP and EMAIL_OTP today, but
   * the answer set comes from Cognito (`allowedMFATypes`), so this must be able to send
   * whichever of the three it names. Hardcoding the pair is what put a dead "Text message"
   * button on this screen in the first place.
   */
  async function chooseMfa(choice: MfaChoice) {
    setError(null);
    setLoading(true);
    try {
      const { nextStep } = await confirmSignIn({ challengeResponse: choice });
      await advanceAfterChallenge(nextStep);
    } catch (err) {
      setError(authErrorMessage(err));
      setLoading(false);
    }
  }

  /**
   * Finish EMAIL enrolment by telling Cognito which address to use.
   *
   * ⚠ THE ANSWER IS THE EMAIL ADDRESS, not a code, this step is Cognito asking "where do I
   * send codes?", and it is answered with the address the user already signed in as. There is
   * no screen for it: asking someone to retype the address they just typed adds a step and a
   * way to get it wrong, and Cognito only accepts the account's own verified address anyway.
   */
  async function submitEmailSetup(address: string) {
    setError(null);
    setLoading(true);
    try {
      const { nextStep } = await confirmSignIn({ challengeResponse: address });
      await advanceAfterChallenge(nextStep);
    } catch (err) {
      setError(authErrorMessage(err));
      setLoading(false);
    }
  }

  /** A forced password change (admin-created user, or admin-reset password). */
  async function onNewPasswordRequired(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { nextStep } = await confirmSignIn({ challengeResponse: newPassword });
      // MUST go through advanceAfterChallenge, not handleNextStep: on this pool MFA
      // is mandatory, so the step AFTER a forced password change is
      // CONTINUE_SIGN_IN_WITH_TOTP_SETUP, and that step carries the enrolment
      // secret in its payload. handleNextStep cannot see the payload, so it rendered
      // the QR screen with no secret and the half-finished sign-in was abandoned:
      // the user set a password (Cognito accepted it, status went CONFIRMED) and was
      // then bounced to sign-in, where their new password appeared not to work.
      await advanceAfterChallenge(nextStep);
    } catch (err) {
      setError(authErrorMessage(err));
      setLoading(false);
    }
  }

  /** Email confirmation for a user who never finished sign-up. */
  async function onConfirmSignUp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await confirmSignUp({ username: email, confirmationCode: code.trim() });
      // Confirmed. Sign in with the password already in state so the user isn't
      // asked to type it a second time; they continue straight into TOTP enrolment.
      setCode("");
      if (password) {
        const { nextStep } = await signIn({ username: email, password });
        if (nextStep.signInStep === "CONTINUE_SIGN_IN_WITH_TOTP_SETUP") {
          const details = nextStep.totpSetupDetails;
          setTotp({
            uri: details.getSetupUri(TOTP_ISSUER, email).toString(),
            secret: details.sharedSecret,
          });
          setScreen("totpSetup");
          setLoading(false);
          return;
        }
        await handleNextStep(nextStep.signInStep);
        return;
      }
      setScreen("signIn");
      setNotice("Your email is confirmed. Sign in to continue.");
      setLoading(false);
    } catch (err) {
      setError(authErrorMessage(err));
      setLoading(false);
    }
  }

  async function onResendCode() {
    setError(null);
    setLoading(true);
    try {
      await resendSignUpCode({ username: email });
      setNotice("We've sent a new code.");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  /** Start a password reset: Cognito emails a code. */
  async function onForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { nextStep } = await resetPassword({ username: email });
      if (nextStep.resetPasswordStep === "CONFIRM_RESET_PASSWORD_WITH_CODE") {
        setScreen("resetPassword");
        setNotice("We've emailed you a reset code.");
      } else {
        setScreen("signIn");
        setNotice("Your password is already reset. Sign in to continue.");
      }
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function onResetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await confirmResetPassword({
        username: email,
        confirmationCode: code.trim(),
        newPassword,
      });
      setScreen("signIn");
      setCode("");
      setNewPassword("");
      setPassword("");
      setNotice("Your password has been reset. Sign in with your new password.");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  /** Abandon a half-finished challenge and start over cleanly. */
  async function startOver() {
    // Amplify holds challenge state between calls, so returning to the sign-in form
    // without clearing it leaves the NEXT signIn() throwing about an existing user.
    await amplifySignOut().catch(() => {});
    setScreen("signIn");
    setCode("");
    setNewPassword("");
    setTotp(null);
    setError(null);
    setNotice(null);
    setLoading(false);
  }

  if (!isAmplifyConfigured) {
    // A missing NEXT_PUBLIC_COGNITO_* pair would otherwise surface as an opaque
    // Amplify throw on first keystroke. Say what's wrong instead.
    return (
      <AuthShell title="Sign-in unavailable">
        <AuthError>
          This deployment is missing its Cognito configuration
          (NEXT_PUBLIC_COGNITO_USER_POOL_ID / NEXT_PUBLIC_COGNITO_CLIENT_ID).
          Please contact your administrator.
        </AuthError>
      </AuthShell>
    );
  }

  // ─── TOTP enrolment ───
  if (screen === "totpSetup" && totp) {
    return (
      <AuthShell
        title="Set up two-factor authentication"
        subtitle="Scan this with an authenticator app (1Password, Authy, Google Authenticator), then enter the 6-digit code it shows."
        footer={<AuthLinkButton onClick={startOver}>Back to sign in</AuthLinkButton>}
      >
        <AuthError>{error}</AuthError>
        <TotpQrCode setupUri={totp.uri} secret={totp.secret} />
        <form onSubmit={onVerifyTotpSetup} className="mt-5">
          <AuthCodeField
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoFocus
            hint="The code changes every 30 seconds, so enter the current one."
          />
          <AuthButton loading={loading}>Verify and continue</AuthButton>
        </form>
      </AuthShell>
    );
  }

  /**
   * ─── EMAIL CODE ───
   *
   * Both the enrolment verification and the per-sign-in challenge land here; Cognito uses the
   * same step for each, and the copy is true of both. `emailSetup` appears too because
   * `submitEmailSetup` answers that step without a screen, if its response ever routes back
   * here rather than onward, the user sees a code field instead of a spinner that never ends.
   */
  if (screen === "emailChallenge" || screen === "emailSetup") {
    return (
      <AuthShell
        title="Check your email"
        subtitle={`Enter the code we sent to ${email}.`}
        footer={<AuthLinkButton onClick={startOver}>Back to sign in</AuthLinkButton>}
      >
        <AuthError>{error}</AuthError>
        <form onSubmit={onConfirmChallenge}>
          <AuthCodeField
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoFocus
          />
          <AuthButton loading={loading}>Verify</AuthButton>
        </form>
      </AuthShell>
    );
  }

  // ─── TOTP / SMS challenge ───
  if (screen === "totpChallenge" || screen === "smsChallenge") {
    const isSms = screen === "smsChallenge";
    return (
      <AuthShell
        title="Two-factor authentication"
        subtitle={
          isSms
            ? "Enter the code we texted you."
            : "Enter the 6-digit code from your authenticator app."
        }
        footer={<AuthLinkButton onClick={startOver}>Back to sign in</AuthLinkButton>}
      >
        <AuthError>{error}</AuthError>
        <form onSubmit={onConfirmChallenge}>
          <AuthCodeField
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoFocus
          />
          <AuthButton loading={loading}>Verify</AuthButton>
        </form>
      </AuthShell>
    );
  }

  // ─── Choose a second factor ───
  /*
    Both selection steps render here: the portal can COMPLETE either one, because it owns the
    enrolment screens too. Only the desktop needs them apart, see the shared state machine.
  */
  if (screen === "mfaSelection" || screen === "mfaSetupSelection") {
    return (
      <AuthShell
        title="Choose a verification method"
        /*
          Cognito uses one screen for two questions, "which factor now?" and "which factor
          will you set up?", and the second is mandatory before a first sign-in can finish.
          Saying so removes the reasonable fear that picking one is irreversible.
        */
        subtitle="You can add another method later."
        footer={<AuthLinkButton onClick={startOver}>Back to sign in</AuthLinkButton>}
      >
        <AuthError>{error}</AuthError>
        {/*
          ⚠ RENDERED FROM WHAT COGNITO OFFERED, not from a hardcoded pair. This screen used to
          show "Authenticator app" and "Text message" unconditionally, and Text message could
          NEVER work here: the pool does not enable SMS_MFA, no user has a phone_number, and the
          pool's SNS role had been deleted. A participant choosing it got an error at the one
          moment they are least able to recover, while the factor that DOES work (email) was
          not offered at all.
        */}
        <div className="space-y-3">
          {allowedMfa.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => chooseMfa(choice)}
              disabled={loading}
              className="w-full rounded-md border border-field-border px-4 py-3 text-left text-sm hover:bg-surface-1 disabled:opacity-50"
            >
              <span className="font-medium text-ink">{MFA_LABELS[choice].title}</span>
              <span className="block text-xs text-ink-subtle mt-0.5">
                {MFA_LABELS[choice].hint}
              </span>
            </button>
          ))}
        </div>
      </AuthShell>
    );
  }

  // ─── Forced password change ───
  //
  // The FIRST STEP for every invited person now, not an edge case: an admin-created
  // account starts in FORCE_CHANGE_PASSWORD, so the temporary password from the
  // invitation email gets them exactly this far. The copy says so rather than describing
  // it as something being wrong with the account.
  if (screen === "newPasswordRequired") {
    return (
      <AuthShell
        title="Choose your password"
        subtitle="That was your temporary password. Pick your own to finish setting up your account."
        footer={<AuthLinkButton onClick={startOver}>Back to sign in</AuthLinkButton>}
      >
        <AuthError>{error}</AuthError>
        <form onSubmit={onNewPasswordRequired}>
          <AuthField
            id="new-password"
            label="New password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            autoFocus
            hint={PASSWORD_HINT}
          />
          <AuthButton loading={loading}>Set password and continue</AuthButton>
        </form>
      </AuthShell>
    );
  }

  // ─── Email confirmation ───
  if (screen === "confirmSignUp") {
    return (
      <AuthShell
        title="Confirm your email"
        subtitle={
          email ? (
            <>
              Enter the code we sent to <strong>{email}</strong>.
            </>
          ) : (
            "Enter the code we emailed you."
          )
        }
        footer={<AuthLinkButton onClick={startOver}>Back to sign in</AuthLinkButton>}
      >
        <AuthError>{error}</AuthError>
        <AuthNotice>{notice}</AuthNotice>
        <form onSubmit={onConfirmSignUp}>
          {!email && (
            <AuthField
              id="confirm-email"
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          )}
          <AuthCodeField
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoFocus={!!email}
          />
          <AuthButton loading={loading}>Confirm</AuthButton>
        </form>
        <div className="mt-4 text-center">
          <AuthLinkButton onClick={onResendCode} disabled={loading || !email}>
            Resend code
          </AuthLinkButton>
        </div>
      </AuthShell>
    );
  }

  // ─── Forgot password ───
  if (screen === "forgotPassword") {
    return (
      <AuthShell
        title="Reset your password"
        subtitle="We'll email you a code to set a new password."
        footer={<AuthLinkButton onClick={startOver}>Back to sign in</AuthLinkButton>}
      >
        <AuthError>{error}</AuthError>
        <form onSubmit={onForgotPassword}>
          <AuthField
            id="forgot-email"
            label="Email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
          <AuthButton loading={loading}>Send reset code</AuthButton>
        </form>
      </AuthShell>
    );
  }

  // ─── Set the new password with the emailed code ───
  if (screen === "resetPassword") {
    return (
      <AuthShell
        title="Set a new password"
        subtitle={
          <>
            Enter the code sent to <strong>{email}</strong> and choose a new
            password.
          </>
        }
        footer={<AuthLinkButton onClick={startOver}>Back to sign in</AuthLinkButton>}
      >
        <AuthError>{error}</AuthError>
        <AuthNotice>{notice}</AuthNotice>
        <form onSubmit={onResetPassword}>
          <AuthCodeField
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoFocus
          />
          <AuthField
            id="reset-new-password"
            label="New password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            hint={PASSWORD_HINT}
          />
          <AuthButton loading={loading}>Reset password</AuthButton>
        </form>
      </AuthShell>
    );
  }

  // ─── Complete your profile (first login) ───
  //
  // The three mandatory fields, asked ONCE, after the Cognito journey is finished and
  // the app session exists. This replaced the sign-up form's copy of these fields:
  // there is no sign-up form any more (self-service sign-up is off on the pool), and
  // an admin-provisioned account has never been asked for them.
  //
  // No "Back to sign in" link, deliberately. The user IS signed in at this point;
  // offering a way back to a form they have already passed would either loop them
  // through the whole TOTP challenge again or, worse, look like the only way out of a
  // screen they can simply complete. The fields are also editable later at /profile,
  // so this is a prompt rather than a trap.
  if (screen === "completeProfile") {
    return (
      <AuthShell
        title="Tell us who you are"
        subtitle="Just once: this is how your name appears to your team."
      >
        <AuthError>{error}</AuthError>
        <AuthNotice>{notice}</AuthNotice>
        <form onSubmit={onCompleteProfile}>
          <ProfileFieldsForm
            values={profile}
            errors={profileErrors}
            disabled={loading}
            autoFocusFirst
            onChange={(key, value) => {
              setProfile((prev) => ({ ...prev, [key]: value }));
              // Clear this field's error as soon as it's edited, leaving a stale
              // "required" under a field the user has just filled reads as though
              // the form is still rejecting it.
              setProfileErrors((prev) =>
                prev[key] ? { ...prev, [key]: undefined } : prev
              );
            }}
          />
          <AuthButton loading={loading}>Save and continue</AuthButton>
        </form>
      </AuthShell>
    );
  }

  // Checking for a resumable Cognito session. Rendering the form here would flash
  // an email/password prompt at a user who is about to be redirected in, and any
  // keystroke would be thrown away by the navigation.
  if (resuming) {
    return (
      <AuthShell title="Signing you in…">
        <div role="status" className="flex items-center gap-3 text-sm text-ink-subtle">
          <svg
            aria-hidden="true"
            className="animate-spin h-5 w-5 text-brand-text"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          Checking your session…
        </div>
      </AuthShell>
    );
  }

  // ─── Sign in (default, and now the ONLY entry point) ───
  //
  // Also the invite path's first screen: an admin-provisioned account signs in with the
  // temporary password from its invitation email, and Cognito answers with the
  // force-change-password challenge. `initialNotice` is what says so, see StartSignup.
  return (
    <AuthShell
      title="Sign in"
      /* Embedded in the landing page the card leads with the brand mark instead of
         "Sign in / Welcome back.", see the prop's own note in AuthShell. Ignored on the
         standalone /login screen, which already carries the mark above the card. */
      leadWithBrand
      subtitle={
        lockEmail && email ? (
          <>
            Signing in as <strong>{email}</strong>.
          </>
        ) : (
          "Welcome back."
        )
      }
      footer={
        <p className="text-xs text-ink-tertiary">
          Accounts are created by invitation. If you were invited, use the link in your
          invitation email. It carries your temporary password.
        </p>
      }
    >
      <AuthError>{error}</AuthError>
      <AuthNotice>{notice}</AuthNotice>
      <form onSubmit={onSignIn}>
        <AuthField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          // Read-only rather than hidden on the invite path: the person should SEE which
          // address the account belongs to, since that is what their sign-in uses. The
          // invitation and the account are both keyed on it, so an edited value would
          // produce a sign-in against an account that does not exist.
          readOnly={lockEmail}
          disabled={lockEmail}
          autoFocus={!lockEmail}
        />
        <AuthField
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          // On the invite path the password field is where the person starts, since the
          // email above is fixed.
          autoFocus={lockEmail}
        />
        <AuthButton loading={loading}>Sign in</AuthButton>
      </form>
      <div className="mt-4 text-center">
        <AuthLinkButton
          onClick={() => {
            setScreen("forgotPassword");
            setError(null);
            setNotice(null);
          }}
        >
          Forgot password?
        </AuthLinkButton>
      </div>
    </AuthShell>
  );
}

/** Stated up front so the pool's policy isn't discovered via a rejection. */
const PASSWORD_HINT =
  "At least 12 characters, with upper and lower case, a number, and a symbol.";
