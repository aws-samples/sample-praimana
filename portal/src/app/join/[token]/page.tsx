import Link from "next/link";
import { redirect } from "next/navigation";
import { backendFetch, BackendError } from "@/lib/backend";
import { StartSignup } from "./start-signup";

/**
 * The emailed invite link's landing page: /join/<token>.
 *
 * A SERVER component, deliberately. The token is resolved through the backend's
 * internal-only /v1/invitations/lookup-by-token, which the browser cannot reach -
 * so the resolution must happen here, server-side, where BACKEND_URL and the
 * service credentials live. Nothing about the invitation is shipped to the client
 * except what we render.
 *
 * On success we hand off to <StartSignup>, which now renders the SIGN-IN form with the
 * invited address locked in, the account was admin-created when the invitation was
 * sent, and the recipient's email carries its temporary password. Otherwise this page
 * RENDERS the failure cases, expired, unknown token, or an unconfigured user pool -
 * because those are exactly the situations where a bare form leaves the recipient
 * staring at something that refuses them with no explanation.
 *
 * What the token does NOT do: admit the sign-in. That is the temporary password. The
 * token identifies whose invitation this is (and whether it has lapsed), and the ROLE
 * was resolved server-side from the invitation row at provisioning time. This page is
 * the friendly front door, not the lock.
 */

// Whether this environment can authenticate at all. Sign-in is rendered in-place by
// <AuthFlow>, which talks to Cognito from the BROWSER via Amplify, so the vars that
// matter are the public pair the browser gets, not the server-only issuer. Checked here
// so a local environment with no real user pool explains itself instead of rendering a
// form that cannot submit.
const COGNITO_USER_POOL_ID = process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || "";
const COGNITO_CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || "";

interface InviteLookup {
  email: string;
  teamName: string | null;
  platformRole: string;
  status: string;
  expiresAt: string | null;
}

type LookupOutcome =
  | { state: "ok"; invite: InviteLookup }
  | { state: "expired" }
  | { state: "unknown" };

async function resolveToken(token: string): Promise<LookupOutcome> {
  try {
    const invite = (await backendFetch(
      `/v1/invitations/lookup-by-token?token=${encodeURIComponent(token)}`
    )) as InviteLookup;
    return { state: "ok", invite };
  } catch (err) {
    // 410 is the backend's distinct "you held a real invite, it lapsed" answer;
    // everything else (404, 400, a transport failure) collapses to "unknown" so a
    // bad token can't be told apart from an absent one.
    if (err instanceof BackendError && err.status === 410) {
      return { state: "expired" };
    }
    if (!(err instanceof BackendError)) {
      console.error("[join] invite lookup failed", err);
    }
    return { state: "unknown" };
  }
}

// Shared chrome for the two dead-end states, matching the login page's centered
// card. Kept local, it's presentational and used only here.
function Notice({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas px-4 text-ink">
      <div className="w-full max-w-md text-center">
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        <div className="mt-3 text-sm text-ink-subtle leading-relaxed">{children}</div>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-lg bg-brand px-5 py-3 text-sm font-semibold text-brand-ink"
        >
          Go to sign in
        </Link>
      </div>
    </div>
  );
}

export default async function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const outcome = await resolveToken(token);

  if (outcome.state === "expired") {
    return (
      <Notice title="This invitation has expired">
        <p>
          Invite links are only valid for a short time. Ask whoever invited you to
          send a new one. Your place is still there, the link just needs
          refreshing.
        </p>
      </Notice>
    );
  }

  if (outcome.state === "unknown") {
    return (
      <Notice title="This invitation link isn't valid">
        <p>
          The link may have been mistyped or truncated by an email client. Try
          opening it again from the original email, or ask for a new invitation.
        </p>
      </Notice>
    );
  }

  const { invite } = outcome;

  // Already accepted → this person has finished setting up their account, so the
  // temporary password in their invitation email is spent. Send them to the ordinary
  // sign-in page, where "Forgot password?" is available if they need it, rather than to
  // a prefilled form that invites them to reuse a password that no longer works.
  if (invite.status === "ACCEPTED") {
    redirect("/login");
  }

  if (!COGNITO_USER_POOL_ID || !COGNITO_CLIENT_ID) {
    // No user pool configured (e.g. local dev without one). Say so rather than
    // rendering a sign-in form whose every submit would throw from Amplify.
    return (
      <Notice title={`You're invited${invite.teamName ? ` to ${invite.teamName}` : ""}`}>
        <p>
          Sign-in isn&apos;t configured in this environment yet. Try the link again once
          it is, or ask whoever invited you.
        </p>
      </Notice>
    );
  }

  // Hand off to the client, which drives the Amplify sign-in journey. "/" is the one
  // place that routes by role, so this doesn't need to know whether the invitee is
  // staff or a participant.
  return <StartSignup email={invite.email} callbackUrl="/" />;
}
