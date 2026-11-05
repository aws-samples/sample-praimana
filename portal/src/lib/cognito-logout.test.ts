import { describe, it, expect } from "vitest";
import {
  cognitoLogoutUrl,
  FEDERATED_LOGOUT_PATH,
  POST_LOGOUT_PATH,
} from "./cognito-logout";

/**
 * These tests pin the two things that silently break federated sign-out.
 *
 * 1. The URL SHAPE. Cognito rejects /logout with `redirect_mismatch` unless
 *    `logout_uri` decodes to an exact entry in the app client's LogoutURLs. That
 *    failure only ever shows up in a browser, so the shape is pinned here.
 * 2. The NULL contract. An incomplete env must yield null (→ caller falls back to
 *    a local sign-out), never a half-built URL that strands a user who has
 *    already lost their local session.
 */

const CONFIG = {
  hostedUiDomain: "https://praimana-123456789012.auth.us-east-1.amazoncognito.com",
  clientId: "clientaaaaaaaaaaaaaaaaaaaa",
  appUrl: "https://ai.example.test",
};

describe("cognitoLogoutUrl", () => {
  it("builds the Hosted UI logout URL with client_id and logout_uri", () => {
    const url = new URL(cognitoLogoutUrl(CONFIG)!);
    expect(url.origin).toBe(CONFIG.hostedUiDomain);
    expect(url.pathname).toBe("/logout");
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(url.searchParams.get("logout_uri")).toBe(
      `${CONFIG.appUrl}${POST_LOGOUT_PATH}`
    );
  });

  it("returns a logout_uri that matches the registered LogoutURLs entry exactly", () => {
    // The live app client registers "<origin>/login" for prod and localhost. An
    // extra path segment, a trailing slash, or a stray query param here means
    // Cognito refuses the whole request, so assert the exact decoded string.
    const local = cognitoLogoutUrl({ ...CONFIG, appUrl: "http://localhost:3001" })!;
    expect(new URL(local).searchParams.get("logout_uri")).toBe(
      "http://localhost:3001/login"
    );
  });

  it("does not double up the slash when appUrl or domain has a trailing slash", () => {
    const url = new URL(
      cognitoLogoutUrl({
        ...CONFIG,
        hostedUiDomain: `${CONFIG.hostedUiDomain}/`,
        appUrl: `${CONFIG.appUrl}/`,
      })!
    );
    expect(url.pathname).toBe("/logout");
    expect(url.searchParams.get("logout_uri")).toBe(
      `${CONFIG.appUrl}${POST_LOGOUT_PATH}`
    );
  });

  it("percent-encodes the logout_uri in the raw query string", () => {
    // Cognito compares the DECODED value, but the raw query must still be a
    // well-formed URL, an unencoded "https://" would break parsing downstream.
    const raw = cognitoLogoutUrl(CONFIG)!;
    expect(raw).toContain("logout_uri=https%3A%2F%2F");
  });

  it("returns null when any required piece of Cognito env is missing", () => {
    expect(cognitoLogoutUrl({ ...CONFIG, hostedUiDomain: "" })).toBeNull();
    expect(cognitoLogoutUrl({ ...CONFIG, clientId: "" })).toBeNull();
    expect(cognitoLogoutUrl({ ...CONFIG, appUrl: "" })).toBeNull();
  });
});

describe("sign-out paths", () => {
  it("keeps the federated hop under /api/auth so middleware treats it as public", () => {
    // middleware.ts lists "/api/auth" in PUBLIC_PATHS. The local session is
    // already gone when the browser arrives here, so if this path fell outside
    // that prefix it would 302 to /login and skip Cognito's /logout entirely -
    // reintroducing the original bug.
    expect(FEDERATED_LOGOUT_PATH.startsWith("/api/auth/")).toBe(true);
  });

  it("returns the user to a page reachable without a session", () => {
    expect(POST_LOGOUT_PATH).toBe("/login");
  });
});
