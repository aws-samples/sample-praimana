"use client";

import { signOut as nextAuthSignOut } from "next-auth/react";
import { signOut as amplifySignOut } from "aws-amplify/auth";
import { FEDERATED_LOGOUT_PATH } from "./cognito-logout";
import { configureAmplify, isAmplifyConfigured } from "./amplify";
import { clearSharedActivity } from "./idle-timeout";

/**
 * The ONE sign-out the whole app should call.
 *
 * There are now three separate pieces of session state, and clearing any subset of
 * them leaves the user in a state they can't reason about:
 *
 *   1. The NextAuth httpOnly cookie, this app's actual session.
 *   2. Amplify's Cognito tokens in localStorage, how the browser talks to Cognito.
 *   3. The Cognito Hosted UI's own cookie on the auth domain.
 *
 * (2) is the new one, and the one a bare `nextAuthSignOut()` misses. Leaving it
 * behind is not merely untidy: the next visit to /login finds Amplify still holding
 * a valid session, so `signIn()` throws UserAlreadyAuthenticatedException and the
 * form refuses to work, a signed-out user who cannot sign in. Worse, the tokens
 * outliving the app session means "sign out" on a shared machine doesn't remove the
 * ability to talk to Cognito as that user.
 *
 * Order matters. Amplify's tokens go FIRST, while the page is still alive: (1)
 * triggers a navigation, and anything queued after it may never run.
 *
 * Amplify's signOut() is global: it also revokes the refresh token server-side and
 * clears the Hosted UI cookie where it can, so (3)'s hop is belt-and-braces for the
 * federated case. We keep it because sessions established through the older Hosted
 * UI provider have no Amplify state to clear at all.
 */
export async function signOutEverywhere(): Promise<void> {
  /**
   * ⚠ FIRST, AND BEFORE ANY AWAIT. The shared last-activity instant now ENFORCES the idle deadline
   * rather than only postponing it (`IdleTimeout.tsx` seeds from it on mount), so a value left behind
   * belongs to a session that no longer exists. It is owner-scoped, so a stale row cannot sign the
   * NEXT user out, but leaving one is still litter on a shared machine, and clearing it here is the
   * one place that runs on every deliberate sign-out.
   *
   * The storage failure is swallowed inside `clearSharedActivity` for the same reason the reads
   * swallow theirs: localStorage throws rather than returning null in Safari private mode, and that
   * must not stop the session being cleared.
   */
  clearSharedActivity();

  if (isAmplifyConfigured) {
    // configureAmplify() first: signOut() on an unconfigured Amplify throws, and a
    // user who reaches a header without having passed through an auth screen this
    // page-load (a fresh load on an existing session) hasn't configured it yet.
    configureAmplify();
    // Swallowed deliberately. A network failure here must not prevent the local
    // session from being cleared, a sign-out that half-fails should still sign the
    // user out of THIS app, which is the part they can see.
    await amplifySignOut({ global: true }).catch(() => {});
  }

  // Hands off to the federated-logout route, which 302s to Cognito's /logout and
  // returns the browser to /login.
  await nextAuthSignOut({ callbackUrl: FEDERATED_LOGOUT_PATH });
}
