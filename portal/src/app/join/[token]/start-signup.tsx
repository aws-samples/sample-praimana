"use client";

import { AuthFlow } from "@/components/auth/AuthFlow";

/**
 * The FIRST SIGN-IN leg of the invite flow, rendered in-place.
 *
 * This used to render a SIGN-UP form. It cannot any more: self-service sign-up is
 * disabled on the pool (`AllowAdminCreateUserOnly: true`), so Cognito refuses the
 * SignUp API outright, the form's every submit would come back as
 * NotAuthorizedException "SignUp is not permitted for this user pool", which is
 * exactly the dead end that once broke registration (see
 * lib/auth-flow.signup-disabled.test.ts).
 *
 * By the time this page is reached the ACCOUNT ALREADY EXISTS: the invite API
 * admin-created it and emailed the recipient a temporary password alongside this link.
 * So the recipient's first action is a sign-in, and Cognito answers it with the
 * force-change-password challenge, which <AuthFlow> already handles
 * (CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED → the newPasswordRequired screen), and
 * then continues into mandatory TOTP enrolment because the pool is MfaConfiguration:
 * ON.
 *
 * The invited email is passed through and LOCKED, for the same reason as before: the
 * invitation and the account are both keyed on that address, so letting it be edited
 * would produce a sign-in attempt against an account that does not exist, with the
 * recipient unable to see why.
 *
 * The component keeps the name StartSignup deliberately, it is the same seam in the
 * same flow and renaming it would churn the page for no behavioural gain. What it
 * starts is now a sign-in.
 */
export function StartSignup({
  email,
  callbackUrl,
}: {
  email: string;
  callbackUrl: string;
}) {
  return (
    <AuthFlow
      initialScreen="signIn"
      initialEmail={email}
      lockEmail
      // Says WHY a password is being asked for. Without it the recipient sees a bare
      // sign-in form after clicking "Sign in to your account" in an email that just
      // gave them a temporary password, and has to infer that the two go together.
      initialNotice="Your account is ready. Sign in with the temporary password from your invitation email. You'll choose your own password next."
      callbackUrl={callbackUrl}
    />
  );
}
