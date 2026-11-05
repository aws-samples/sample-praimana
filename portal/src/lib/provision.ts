import { backendFetch, BackendError } from "@/lib/backend";

/**
 * PROVISIONING a Cognito account for an invited address.
 *
 * Self-service sign-up is OFF (`AllowAdminCreateUserOnly: true` on the pool), so an
 * invitation on its own no longer produces an account, an invited person has nothing
 * to sign in to until an account is admin-created for them. This module is the BFF's
 * half of that: it calls the out-of-VPC user-access service, which owns the one
 * `cognito-idp:AdminCreateUser` permission on the platform.
 *
 * ── THE ORDERING, WHICH IS FORCED AND NOT A PREFERENCE ──
 *
 *   1. store the invitation row   (POST /v1/teams/:teamId/invitations)
 *   2. create the Cognito account (POST /v1/user-access/provision)   ← this module
 *   3. send our branded email     (POST /v1/notify/registration-invite)
 *
 * The row MUST exist before step 2. The pre-signup trigger has no `triggerSource`
 * check, so it fires on `PreSignUp_AdminCreateUser` too and reads the invitations
 * table during the AdminCreateUser call, verified against the live dev pool: a create
 * for an un-invited address is REFUSED with "Registration is by invitation only." and
 * no account appears. Creating the account first would therefore fail every time, and
 * the invite-only gate is something this flow depends on rather than re-implements.
 *
 * Step 3 must come after step 2 for a different reason: an email carrying a temporary
 * password for an account that does not exist is worse than no email. The recipient
 * would be told their credentials are wrong on every attempt, with no way to tell that
 * the fault is ours.
 *
 * ⚠ THE TEMPORARY PASSWORD. `temporaryPassword` in the response is a live credential.
 * It exists in exactly two places, this value and the email, and is recoverable from
 * neither afterwards. It must never be logged, stored, put in a response to the
 * browser, or attached to an error. The functions here take care not to include it in
 * any thrown error or log line, and callers must do the same.
 */

/** What POST /v1/user-access/provision answers on success. */
export interface ProvisionResult {
  /** ⚠ A LIVE CREDENTIAL. Goes into the invitation email and nowhere else. */
  temporaryPassword: string;
  /** The role the account was actually given, resolved from the invitation row. */
  role: string;
  /** True when the account already existed, a benign re-invite. */
  alreadyExisted: boolean;
  /**
   * FALSE means the account exists with NO ROLE. The person can sign in and will then
   * be refused a session by the role gate, so this must be surfaced rather than
   * treated as success.
   */
  groupAssigned: boolean;
  profileWritten: boolean;
}

/** Why one address could not be provisioned, in terms an operator can act on. */
export interface ProvisionFailure {
  email: string;
  /** Operator-facing reason. Never contains a credential. */
  reason: string;
  /**
   * True when a retry might work (a timeout, a throttle, an upstream blip) and false
   * when the input or the data is at fault. Drives whether the UI says "try again".
   */
  retryable: boolean;
}

export type ProvisionOutcome =
  | { ok: true; email: string; result: ProvisionResult }
  | { ok: false; email: string; failure: ProvisionFailure };

/**
 * How many accounts are provisioned CONCURRENTLY within one invite request.
 *
 * 4, not "all of them". Each provisioning is three-plus sequential Cognito calls, and
 * Cognito's admin APIs are rate-limited per pool, an unbounded fan-out over a
 * 50-address bulk invite would burn through that quota and turn a partial success into
 * a wall of TooManyRequestsException. 4 keeps a 20-invite batch to five waves inside
 * the request budget while leaving Cognito headroom for the sign-ins happening
 * concurrently.
 *
 * Raising this is a load decision against a shared, pool-wide quota, not a tuning
 * knob: the throttle it would trip is the same one that would block a real user's
 * sign-in.
 */
export const PROVISION_CONCURRENCY = 4;

/**
 * Provision ONE account. Never throws, the outcome is the return value, because a
 * bulk invite must be able to report per-address results rather than losing the whole
 * batch to one bad address.
 */
export async function provisionAccount(
  email: string,
  token: string
): Promise<ProvisionOutcome> {
  try {
    const result = (await backendFetch("/v1/user-access/provision", {
      method: "POST",
      body: JSON.stringify({ email }),
      token,
    })) as ProvisionResult;

    // A response with no password is not a success we can act on: there would be
    // nothing to put in the email, and reporting it as provisioned would leave the
    // invitee holding a link and no credential.
    if (!result?.temporaryPassword) {
      return {
        ok: false,
        email,
        failure: {
          email,
          reason: "the account service returned no temporary password",
          retryable: true,
        },
      };
    }

    return { ok: true, email, result };
  } catch (err) {
    return { ok: false, email, failure: classifyFailure(email, err) };
  }
}

/**
 * Turn a provisioning error into an operator-facing reason.
 *
 * Branches on the STATUS and the machine-readable `code`, never on message text: the
 * status is the contract (see the user-access service's routes) and the text is not.
 */
function classifyFailure(email: string, err: unknown): ProvisionFailure {
  if (err instanceof BackendError) {
    // The invite gate refused a create for an address we had just stored a row for.
    // Distinct because it means the SEQUENCE is wrong on our side, not that the
    // operator mistyped something, worth its own message so it is diagnosable.
    if (err.code === "INVITE_GATE_REFUSED") {
      return {
        email,
        reason:
          "the sign-up gate did not see the invitation, re-send the invitation",
        retryable: true,
      };
    }
    if (err.status === 400) {
      return { email, reason: err.message, retryable: false };
    }
    if (err.status === 403) {
      return {
        email,
        reason: "this account is not permitted to create accounts",
        retryable: false,
      };
    }
    if (err.status === 409) {
      return {
        email,
        reason: "no live invitation was found for this address",
        retryable: false,
      };
    }
    // 502/503 and anything else: an upstream refused or did not answer.
    return {
      email,
      reason: "the account could not be created right now",
      retryable: true,
    };
  }

  // A transport failure (the fetch itself). Deliberately NOT including the raw error
  // in the reason: it can carry a URL and internal hostnames, and the operator can act
  // on "try again" either way.
  return {
    email,
    reason: "the account service could not be reached",
    retryable: true,
  };
}

/**
 * Provision several accounts with a BOUNDED concurrency.
 *
 * A plain `Promise.all` over the recipients is the version that breaks in production:
 * a 50-address bulk invite would issue 50 concurrent AdminCreateUser calls against a
 * per-pool rate limit. This is a small worker pool over a shared index instead, no
 * per-address closure retained beyond its own task, and the result array is
 * pre-allocated so nothing accumulates.
 *
 * Every task is awaited (via the workers' own promises), so no provisioning is ever
 * fire-and-forget: a failure is a recorded outcome, never an unobserved rejection.
 */
export async function provisionAccounts(
  emails: readonly string[],
  token: string,
  concurrency: number = PROVISION_CONCURRENCY
): Promise<ProvisionOutcome[]> {
  const outcomes = new Array<ProvisionOutcome>(emails.length);
  let next = 0;

  // Single-writer per slot: each worker owns the index it claimed, so `outcomes` needs
  // no synchronisation beyond JS's single-threaded execution.
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= emails.length) return;
      outcomes[index] = await provisionAccount(emails[index], token);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, emails.length)) },
    () => worker()
  );
  // allSettled, not all: worker() cannot reject (provisionAccount never throws), but
  // if it ever could, one rejection must not discard the other workers' results.
  await Promise.allSettled(workers);

  return outcomes;
}
