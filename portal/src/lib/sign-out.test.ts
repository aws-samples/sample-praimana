import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Sign-out is now the coordination of three independent pieces of session state, and
 * the failure modes are all invisible in a happy-path click-through:
 *
 *   - Skip Amplify's tokens and the user is "signed out" but /login resumes them
 *     straight back in, the button silently does nothing.
 *   - Clear them AFTER handing off to NextAuth and the navigation may cancel the
 *     call, which is the same bug with a race attached.
 *   - Let an Amplify failure propagate and the local session survives too, so a
 *     network blip means the user cannot sign out of a shared machine.
 *
 * These pin the ORDER and the swallowing, which is what no manual test would catch.
 */

const amplifySignOut = vi.fn();
const nextAuthSignOut = vi.fn();
const configureAmplify = vi.fn();
// Mutable so a test can exercise the unconfigured (local dev) branch.
let amplifyConfigured = true;

vi.mock("aws-amplify/auth", () => ({
  signOut: (...args: unknown[]) => amplifySignOut(...args),
}));

vi.mock("next-auth/react", () => ({
  signOut: (...args: unknown[]) => nextAuthSignOut(...args),
}));

vi.mock("./amplify", () => ({
  configureAmplify: () => configureAmplify(),
  get isAmplifyConfigured() {
    return amplifyConfigured;
  },
}));

const { signOutEverywhere } = await import("./sign-out");
const { FEDERATED_LOGOUT_PATH } = await import("./cognito-logout");

describe("signOutEverywhere", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    amplifyConfigured = true;
    amplifySignOut.mockResolvedValue(undefined);
    nextAuthSignOut.mockResolvedValue(undefined);
  });

  it("clears the Cognito tokens BEFORE handing off to NextAuth", async () => {
    // Order is the whole point: NextAuth's signOut triggers a navigation, and
    // anything queued after it may never run, leaving live Cognito tokens behind,
    // which /login's resume path would use to sign the user straight back in.
    const calls: string[] = [];
    amplifySignOut.mockImplementation(async () => {
      calls.push("amplify");
    });
    nextAuthSignOut.mockImplementation(async () => {
      calls.push("nextauth");
    });

    await signOutEverywhere();

    expect(calls).toEqual(["amplify", "nextauth"]);
  });

  it("revokes globally, not just locally", async () => {
    // global:true revokes the REFRESH token server-side. Without it the refresh
    // token stays valid until it expires, so "sign out" wouldn't remove the ability
    // to mint new tokens as that user.
    await signOutEverywhere();
    expect(amplifySignOut).toHaveBeenCalledWith({ global: true });
  });

  it("still clears the local session when Cognito sign-out fails", async () => {
    // A network failure must not strand the user signed in to this app. The part
    // they can see has to go away.
    amplifySignOut.mockRejectedValue(new Error("network down"));

    await expect(signOutEverywhere()).resolves.toBeUndefined();
    expect(nextAuthSignOut).toHaveBeenCalled();
  });

  it("hands off to the federated logout route so the IdP session ends too", async () => {
    await signOutEverywhere();
    expect(nextAuthSignOut).toHaveBeenCalledWith({
      callbackUrl: FEDERATED_LOGOUT_PATH,
    });
  });

  it("configures Amplify first, since signOut on an unconfigured Amplify throws", async () => {
    // A user who loads a page on an existing session hasn't passed through an auth
    // screen this page-load, so nothing has configured Amplify yet.
    await signOutEverywhere();
    expect(configureAmplify).toHaveBeenCalled();
  });

  it("skips Cognito entirely when no user pool is configured", async () => {
    // Local dev without a pool: there are no Amplify tokens to clear, and calling
    // signOut would throw.
    amplifyConfigured = false;

    await signOutEverywhere();

    expect(amplifySignOut).not.toHaveBeenCalled();
    expect(nextAuthSignOut).toHaveBeenCalled();
  });
});
