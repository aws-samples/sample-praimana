// Native Cognito Hosted UI login for the desktop app — OAuth2 authorization-code
// flow with PKCE, over a loopback redirect. There is no client secret (the app
// client is public), so PKCE is what proves the token request came from the same
// party that started the flow.
//
// Shape of the flow:
//   1. The endpoints come from `platform-config.ts`, which read them from AWS's own
//      OIDC discovery document for the configured pool. NOT from our own API, and
//      NOT assembled from a domain string — see below.
//   2. Generate a PKCE verifier/challenge and a state nonce.
//   3. Bind a one-shot loopback HTTP server on a FIXED port (must match a
//      registered Cognito callback URL — Cognito only allows http:// for
//      localhost and requires exact matches).
//   4. Open the system browser at the discovered `authorization_endpoint`.
//   5. The browser redirects back to the loopback with ?code=&state=; exchange
//      the code + verifier at the discovered `token_endpoint`.
//
// We forward the ID token as the API bearer (it carries aud + email +
// cognito:groups); the refresh token renews it without re-prompting.
//
// ⚠ THE ENDPOINTS ARE NOW PASSED IN, NOT DERIVED FROM A DOMAIN.
//
// This module used to hold `hostedUiDomain` and build `${domain}/oauth2/authorize`
// and `${domain}/oauth2/token` itself — and it learned that domain from our own
// `GET /v1/auth/config`, i.e. from a server whose address someone had typed. That
// made the login destination a value a hostile server could choose, which is the
// substance of the caller-chosen-provider risk.
//
// Both endpoints are now read from AWS's discovery document for the pool
// (`platform-config.ts`), validated to be AWS-hosted, and handed here as data. This
// module no longer decides where the user's password is typed — it cannot, because it
// no longer knows how to construct the URL.

import http from "http";
import crypto from "crypto";
import { shell } from "electron";
import { debugLog } from "./debug-log";

// Fixed loopback port — registered as a Cognito callback URL
// (http://localhost:8788/callback). Cognito requires exact callback matches, so
// this can't be an ephemeral port.
const LOOPBACK_PORT = 8788;
const REDIRECT_URI = `http://localhost:${LOOPBACK_PORT}/callback`;

// Give the user a generous window to complete Hosted UI (email + MFA) before we
// tear the loopback server down.
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Everything this module needs to run the flow, and nothing it could misuse.
 *
 * `authorizationEndpoint` and `tokenEndpoint` are COMPLETE URLs from AWS discovery,
 * not a domain to append paths to. That is deliberate: a domain plus string
 * concatenation is a URL this module constructs, and therefore a URL a caller can
 * influence by supplying a different domain. A finished endpoint is a value it can
 * only use as given.
 */
export interface CognitoConfig {
  issuer: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes?: string[];
}

export interface CognitoTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE pair: a random verifier and its S256 challenge. */
function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * ⚠ `fetchCognitoConfig` IS DELETED. DO NOT REINTRODUCE IT.
 *
 * It fetched `GET <serverUrl>/v1/auth/config` and trusted the `issuer`, `clientId` and
 * `hostedUiDomain` in the reply — so the server whose address a participant typed chose
 * the identity provider, and with it the page where a password gets typed. That is
 * the caller-chosen-provider risk.
 *
 * The endpoints now come from AWS's OIDC discovery document for the configured pool
 * (`platform-config.ts` → `resolveConnectString`), which is published by AWS, tied back
 * to the pool id via its `issuer`, and validated to be AWS-hosted. Nothing our own API
 * says can influence where the browser is sent.
 *
 * If a future change needs pool config, take it from `readPlatformConfig()`. Adding a
 * function here that reads it from our API would silently undo the control.
 */

/** Exchange an authorization code for tokens at the Cognito token endpoint. */
async function exchangeCodeForTokens(
  cfg: CognitoConfig,
  code: string,
  verifier: string
): Promise<CognitoTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  const res = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const data = (await res.json()) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.id_token || !data.access_token) {
    throw new Error("Token endpoint did not return the expected tokens");
  }
  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    expiresIn: data.expires_in || 1800,
  };
}

/**
 * Renew tokens using a stored refresh token. Cognito does NOT rotate/return a new
 * refresh token on this grant, so the caller keeps reusing the one it has until
 * it expires (30 days) and a full re-login is required.
 */
export async function refreshCognitoTokens(
  cfg: CognitoConfig,
  refreshToken: string
): Promise<CognitoTokens | null> {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: cfg.clientId,
      refresh_token: refreshToken,
    });
    const res = await fetch(cfg.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      id_token?: string;
      access_token?: string;
      expires_in?: number;
    };
    if (!data.id_token || !data.access_token) return null;
    return {
      idToken: data.id_token,
      accessToken: data.access_token,
      refreshToken, // unchanged — Cognito doesn't rotate it on refresh
      expiresIn: data.expires_in || 1800,
    };
  } catch {
    return null;
  }
}

// Extracted out of the markup template so the CSS's own `{}` braces are not read by a
// linter as a missing `${…}` interpolation, and so the template below interpolates only the
// two caller-supplied strings.
const RESULT_PAGE_STYLE =
  "body{font-family:-apple-system,system-ui,sans-serif;background:#f9fafb;color:#111827;" +
  "display:flex;align-items:center;justify-content:center;height:100vh;margin:0}" +
  ".card{max-width:360px;text-align:center;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}" +
  "p{color:#6b7280;font-size:.9rem}";

/**
 * Escapes the five characters that matter for HTML text-node/attribute content. `resultPage`'s
 * two parameters are hardcoded literals at every call site today (see below), so this is
 * defence in depth rather than a fix for a live injection — but the function is one call away
 * from surfacing an OAuth provider's `error_description` here, and this is a five-line guarantee
 * against that becoming reflected HTML injection into a page served on the loopback callback.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Minimal HTML shown in the browser tab after the redirect, so the user knows to
// return to the app rather than staring at a blank loopback page.
function resultPage(title: string, message: string): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  // nosemgrep: html-in-template-string  -- reviewed; the construct is not the vulnerability this rule describes
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>${RESULT_PAGE_STYLE}</style></head>
<body><div class="card"><h1>${safeTitle}</h1><p>${safeMessage}</p></div></body></html>`;
}

/**
 * Run the full Hosted UI login. Resolves with tokens on success. Rejects on
 * timeout, user cancel (server torn down), state mismatch, or token-exchange
 * failure. `loginHint` prefills the email on the Hosted UI form.
 */
export function loginWithHostedUi(
  cfg: CognitoConfig,
  loginHint?: string
): Promise<CognitoTokens> {
  const { verifier, challenge } = createPkcePair();
  const state = base64UrlEncode(crypto.randomBytes(16));

  return new Promise<CognitoTokens>((resolve, reject) => {
    let settled = false;
    // Assigned once, below, after the server is listening. Declared up here
    // because the request callbacks close over it to cancel the timeout, and
    // they can only run after that assignment has happened.
    // eslint-disable-next-line prefer-const
    let timer: NodeJS.Timeout | undefined;

    const server = http.createServer((req, res) => {
      // Only the callback path matters; ignore favicon and stray requests.
      const url = new URL(req.url || "/", REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      /**
       * ── ⚠ THE REQUEST MUST LOOK LIKE A LOOPBACK NAVIGATION, NOT A CROSS-SITE FETCH ────────────
       *
       * There was no inspection of `host`, `origin` or `sec-fetch-*` anywhere in this handler, so any page
       * the user had open could reach this listener for the five minutes it is up.
       *
       * ⚠ THIS IS NOT THE PRIMARY FIX AND MUST NOT BE READ AS ONE. Neither header is a security
       * boundary: both are attacker-controlled from a non-browser client, and a local process can
       * send whatever it likes. The primary fix is the ordering below — `state` decides before
       * anything can settle the promise. This narrows the BROWSER-driven case, which is the one that
       * needs no local code execution at all.
       *
       * ⚠ `Host` IS CHECKED AGAINST THE TWO SPELLINGS OF THE LISTENER, not against a single literal.
       * The redirect URI is `127.0.0.1:8788`, browsers may send either that or `localhost:8788`, and
       * refusing one of them would break sign-in on whichever platform resolves it the other way.
       *
       * ⚠ AND A MISSING HEADER IS ACCEPTED. HTTP/1.0 clients omit `Host`, and `sec-fetch-site` is
       * absent from every non-browser request — including, potentially, a future embedded browser.
       * Refusing on absence would turn a hardening measure into a sign-in outage; only a header that
       * POSITIVELY contradicts a loopback navigation is refused.
       */
      const host = (req.headers.host || "").toLowerCase();
      const hostOk = !host || host === "127.0.0.1:8788" || host === "localhost:8788";
      const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
      const siteOk = fetchSite !== "cross-site";
      if (!hostOk || !siteOk) {
        /**
         * ⚠ REFUSED WITHOUT SETTLING, exactly like a `state` mismatch below. An unrelated request must
         * never be able to end a login — that is the whole of this finding.
         */
        debugLog(
          `[auth] ignored a callback request that is not a loopback navigation ` +
            `(host=${hostOk ? "ok" : "bad"} sec-fetch-site=${fetchSite || "absent"})`
        );
        res.writeHead(400);
        res.end();
        return;
      }

      const finish = (o: { tokens?: CognitoTokens; error?: Error }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Close the socket keep-alive so the server actually stops.
        server.close();
        if (o.error) reject(o.error);
        else if (o.tokens) resolve(o.tokens);
      };

      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");

      /**
       * ── ⚠ `state` DECIDES FIRST, BEFORE ANY BRANCH CAN SETTLE THE PROMISE ─────────────────────
       *
       * This check used to sit BELOW the `error` and missing-`code` branches, and both of those call
       * `finish()` — which sets `settled`, clears the timeout, closes the server and REJECTS. So a bare
       * parameterless `GET http://localhost:8788/callback` killed an in-flight Hosted-UI login, the
       * genuine Cognito redirect arriving a moment later was silently discarded by `if (settled)
       * return`, and the rejection surfaced to the participant as the app's own sign-in error. Any
       * unprivileged local process could do it, and so could any web page the user had open — an
       * `<img src>` is enough, since the response being opaque to the attacker does not undo the
       * side effect.
       *
       * ⚠ SO THE ORDER IS THE FIX, NOT AN EXTRA CHECK. `state` is the only secret binding this
       * listener has: it is 128 bits of `crypto.randomBytes`, it went out in the authorize URL, and
       * nothing that did not receive that URL can produce it. Requiring it FIRST means no request
       * except the real redirect can reach a branch that ends the login, whatever else it carries.
       *
       * ⚠ AND A MISMATCH DOES NOT CALL `finish()`. This is the part that matters and it is easy to get
       * wrong while reordering: rejecting on a bad `state` would leave exactly the denial-of-service
       * this fixes, just behind one more condition. A wrong or absent `state` is answered 400 and
       * IGNORED — the listener stays up, the timeout keeps running, and the real redirect can still
       * complete. The login now ends only on the real redirect or the 5-minute timeout.
       *
       * ⚠ THE PAGE STILL SAYS SOMETHING, because a human may be looking at this tab. It says the same
       * thing for every rejected request, and says nothing about why.
       */
      if (returnedState !== state) {
        debugLog("[auth] ignored a callback request whose state did not match the pending sign-in");
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(resultPage("Sign-in failed", "Security check failed. Please try again."));
        return;
      }

      if (err) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(resultPage("Sign-in failed", "You can close this tab and try again."));
        /**
         * ── ⚠ A FIXED MESSAGE, NOT THE SERVER'S `error_description` ─────────────────────────────
         *
         * This was `new Error(url.searchParams.get("error_description") || err)`, and `ai:login` returns that
         * message verbatim to the renderer, where `SignInView` renders it AS THE APP'S OWN SIGN-IN ERROR. It
         * is escaped React text, so this was never markup injection — it was a channel for putting an
         * attacker's sentence inside the application's chrome, on the sign-in screen, which is the
         * highest-trust surface the app has. "Your session was revoked — call IT on 555-0100" reads as though
         * the product said it.
         *
         * Now that `state` is required first, only the real Cognito redirect reaches this line — so the
         * text would be Cognito's own. It is still not shown: an OAuth `error_description` is written
         * for a developer, names no action a participant can take, and the operator who needs it gets
         * it from `debugLog`. One less string that reaches a UI from off-machine.
         */
        debugLog(
          `[auth] hosted-UI sign-in returned an error: ${err}` +
            ` — ${url.searchParams.get("error_description") || "no description"}`
        );
        finish({ error: new Error("Sign-in could not be completed. Please try again.") });
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(resultPage("Sign-in failed", "No authorization code was returned."));
        finish({ error: new Error("No authorization code returned") });
        return;
      }

      exchangeCodeForTokens(cfg, code, verifier)
        .then((tokens) => {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(resultPage("Signed in", "You're all set — return to the Praimana app."));
          finish({ tokens });
        })
        .catch((error) => {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(resultPage("Sign-in failed", "Could not complete sign-in. Please try again."));
          finish({ error });
        });
    });

    server.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // EADDRINUSE most likely means a stale login is still bound to the port.
      reject(new Error(`Could not start local sign-in listener on port ${LOOPBACK_PORT}: ${e.message}`));
    });

    server.listen(LOOPBACK_PORT, "127.0.0.1", () => {
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        response_type: "code",
        scope: (cfg.scopes || ["openid", "email", "profile"]).join(" "),
        redirect_uri: REDIRECT_URI,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      if (loginHint) params.set("login_hint", loginHint);
      // Open the system browser at the Hosted UI. Using /oauth2/authorize (not
      // /login) lets Cognito route already-signed-in sessions straight through.
      void shell.openExternal(`${cfg.authorizationEndpoint}?${params.toString()}`);
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      reject(new Error("Sign-in timed out. Please try again."));
    }, LOGIN_TIMEOUT_MS);
  });
}
