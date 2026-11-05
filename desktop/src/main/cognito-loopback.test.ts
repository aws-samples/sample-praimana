// ── ⚠ AN UNRELATED REQUEST MUST NOT BE ABLE TO END A SIGN-IN ──────────────────────────────────
//
// `finish()` sets `settled`, clears the timeout, closes the server and REJECTS the promise. The `error`
// and missing-`code` branches both called it, and the `state` comparison sat BELOW them — so a bare
// parameterless `GET http://localhost:8788/callback` killed an in-flight Hosted-UI login. The genuine
// Cognito redirect arriving a moment later was discarded by `if (settled) return`, and the rejection
// surfaced to the participant as the app's own sign-in error. Any unprivileged local process could do
// it, and so could any page the user had open — an `<img src>` is enough, because the response being
// opaque to the attacker does not undo the side effect.
//
// ⚠ DRIVEN THROUGH THE REAL LISTENER, WITH REAL HTTP REQUESTS. This is a server that binds a port and
// answers requests, so the property worth pinning is observable directly: does the promise settle, and
// can the real redirect still complete afterwards? A source-text assertion about statement order would
// pass on code that had been reordered and broken in some other way.
//
// ⚠ AND EVERY "MUST NOT SETTLE" CASE THEN COMPLETES THE LOGIN FOR REAL. That is not just cleanup — it
// IS the assertion. "The hostile request did not settle it" and "the genuine redirect still works
// afterwards" are the same claim, and testing only the first would pass on a handler that had wedged
// the listener some other way.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** The authorize URL the flow opens, so a test can read the `state` out of it. */
let openedUrl = "";
vi.mock("electron", () => ({
  shell: {
    openExternal: async (url: string) => {
      openedUrl = url;
    },
  },
  app: { isPackaged: false },
}));
vi.mock("./debug-log", () => ({ debugLog: () => {} }));

const { loginWithHostedUi } = await import("./cognito-oauth");

const CALLBACK = "http://127.0.0.1:8788/callback";
const CFG = {
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE01",
  clientId: "client-abc",
  authorizationEndpoint: "https://example.auth.us-east-1.amazoncognito.com/oauth2/authorize",
  tokenEndpoint: "https://example.auth.us-east-1.amazoncognito.com/oauth2/token",
  scopes: ["openid", "email"],
};

/** The token endpoint, stubbed — no test here should reach the network. */
let tokenExchangeCalls = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  openedUrl = "";
  tokenExchangeCalls = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? "");
    if (url === CFG.tokenEndpoint) {
      tokenExchangeCalls += 1;
      return new Response(
        JSON.stringify({
          id_token: "id-token",
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 1800,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    // Requests AT the loopback listener are real HTTP and must not be intercepted.
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await portFree();
});

/**
 * ── ⚠ A RAW HTTP CLIENT, NOT `fetch`, AND THE REASON IS THE POINT OF TWO OF THESE TESTS ────────
 *
 * `fetch` (undici) treats `Host` as a FORBIDDEN HEADER and silently drops it, and it manages
 * `Sec-Fetch-*` itself. So the two header cases below passed a request the handler saw as a perfectly
 * ordinary loopback callback — they went green against code with no header check at all, which is worse
 * than having no test. `http.request` sends exactly what it is given.
 *
 * ⚠ `Connection: close` ON EVERY REQUEST, and it is not politeness. `server.close()` stops the listener
 * ACCEPTING but waits for open connections to drain, so a kept-alive socket holds port 8788 past the
 * end of a test and the next bind fails with EADDRINUSE. The port is fixed (Cognito requires an exact
 * callback match), so there is no ephemeral-port escape hatch. This is a property of the test client:
 * a browser closes its tab's connection itself, and the production process does not wait on
 * `server.close()`.
 */
async function hit(url: string, headers: Record<string, string> = {}): Promise<{ status: number }> {
  const http = await import("node:http");
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: 8788,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers: { connection: "close", ...headers },
        // Without this, a `host` header in `headers` is overwritten by the computed one.
        setHost: !("host" in headers),
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve({ status: res.statusCode ?? 0 }));
      }
    );
    req.once("error", reject);
    req.end();
  });
}

/** Wait for 8788 to be releasable, so one test's listener cannot fail the next one's bind. */
async function portFree(): Promise<void> {
  const net = await import("node:net");
  for (let i = 0; i < 100; i++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(8788, "127.0.0.1");
    });
    if (free) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The `state` the flow generated, read out of the URL it opened in the browser. */
function pendingState(): string {
  const value = new URL(openedUrl).searchParams.get("state");
  expect(value, "the authorize URL must carry a state").toBeTruthy();
  return value as string;
}

/** Wait until the listener is up and the authorize URL has been opened. */
async function started(): Promise<void> {
  for (let i = 0; i < 200 && !openedUrl; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(openedUrl, "the flow must have opened the Hosted UI").toBeTruthy();
}

/** True when `promise` has not settled within `ms`. */
async function stillPending(promise: Promise<unknown>, ms = 60): Promise<boolean> {
  const marker = Symbol("pending");
  const result = await Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected"
    ),
    new Promise((r) => setTimeout(() => r(marker), ms)),
  ]);
  return result === marker;
}

/**
 * The Error a login settles with — with the rejection handler attached AT CALL TIME.
 *
 * ⚠ CALL THIS BEFORE THE REQUEST THAT CAUSES THE REJECTION, NOT AFTER. `hit()` awaits a real HTTP
 * round trip, and that request is what makes the server handler call `finish({ error })` and reject
 * the login. So a test that only reaches `expect(login).rejects` on the line AFTER `hit()` has
 * already let the rejection escape with nothing attached: Node reports an unhandled rejection, and
 * vitest fails the whole FILE with `Errors 2` while every assertion in it passes — which is exactly
 * how this file used to fail, and it takes the desktop pipeline's Validate gate down with it.
 *
 * `stillPending` above sidesteps the same trap by the same means: it attaches both handlers with
 * `.then(onOk, onErr)` before it waits on anything.
 *
 * Rejecting when the login RESOLVES is deliberate — it keeps the "it must fail" half of the
 * assertion that `expect(...).rejects` used to carry, so this is not a weaker check.
 *
 * Not a production concern: `handlers/ai.ts` does `await loginWithHostedUi(...)`, which attaches a
 * handler synchronously at the call. The gap exists only when a test holds the promise unawaited.
 */
function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected the sign-in to fail, but it resolved");
    },
    (e: Error) => e
  );
}

/** Send the genuine redirect, so the login completes and the listener closes. */
async function completeLogin(state: string): Promise<void> {
  await hit(`${CALLBACK}?code=real-code&state=${encodeURIComponent(state)}`);
}

describe("⚠ the loopback callback", () => {
  it("completes a genuine redirect", async () => {
    const login = loginWithHostedUi(CFG);
    await started();

    await completeLogin(pendingState());

    await expect(login).resolves.toMatchObject({ idToken: "id-token" });
    expect(tokenExchangeCalls).toBe(1);
  });

  /**
   * ⚠ THE FINDING. A request carrying nothing at all used to reject the promise outright.
   */
  it("⚠ a bare parameterless request does NOT kill the login", async () => {
    const login = loginWithHostedUi(CFG);
    await started();
    const state = pendingState();

    await hit(CALLBACK);

    expect(await stillPending(login), "the sign-in must survive it").toBe(true);
    // And the real redirect still works — the other half of the same claim.
    await completeLogin(state);
    await expect(login).resolves.toMatchObject({ idToken: "id-token" });
  });

  it("⚠ an error response with the WRONG state does not kill the login", async () => {
    const login = loginWithHostedUi(CFG);
    await started();
    const state = pendingState();

    await hit(`${CALLBACK}?error=access_denied&state=not-the-real-state`);

    expect(await stillPending(login)).toBe(true);
    await completeLogin(state);
    await expect(login).resolves.toMatchObject({ idToken: "id-token" });
  });

  it("⚠ a code with the wrong state does not kill the login, and exchanges nothing", async () => {
    const login = loginWithHostedUi(CFG);
    await started();
    const state = pendingState();

    await hit(`${CALLBACK}?code=attacker-code&state=wrong`);

    expect(await stillPending(login)).toBe(true);
    expect(tokenExchangeCalls, "no code may be exchanged on a bad state").toBe(0);
    await completeLogin(state);
    await expect(login).resolves.toMatchObject({ idToken: "id-token" });
  });

  /**
   * ⚠ A CROSS-SITE FETCH IS REFUSED, and this is the browser-driven case that needs no local code
   * execution at all. Not the primary control — the header is attacker-controlled from a non-browser
   * client — which is exactly why the ordering above is what the login actually relies on.
   */
  it("ignores a request that declares itself cross-site", async () => {
    const login = loginWithHostedUi(CFG);
    await started();
    const state = pendingState();

    await hit(`${CALLBACK}?code=x&state=${encodeURIComponent(state)}`, {
      "sec-fetch-site": "cross-site",
    });

    expect(await stillPending(login)).toBe(true);
    expect(tokenExchangeCalls).toBe(0);
    await completeLogin(state);
    await expect(login).resolves.toMatchObject({ idToken: "id-token" });
  });

  it("ignores a request whose Host is not the loopback listener", async () => {
    const login = loginWithHostedUi(CFG);
    await started();
    const state = pendingState();

    await hit(`${CALLBACK}?code=x&state=${encodeURIComponent(state)}`, {
      host: "evil.example.com",
    });

    expect(await stillPending(login)).toBe(true);
    await completeLogin(state);
    await expect(login).resolves.toMatchObject({ idToken: "id-token" });
  });

  /**
   * ⚠ BOTH SPELLINGS OF THE LISTENER ARE ACCEPTED. The redirect URI names `localhost`, browsers may
   * send either, and refusing one would break sign-in on whichever platform resolves it the other way.
   */
  it("accepts both localhost and 127.0.0.1 as the Host", async () => {
    for (const host of ["localhost:8788", "127.0.0.1:8788"]) {
      const login = loginWithHostedUi(CFG);
      await started();
      const state = pendingState();

      await hit(`${CALLBACK}?code=real-code&state=${encodeURIComponent(state)}`, { host });

      await expect(login, `Host: ${host} must be accepted`).resolves.toMatchObject({
        idToken: "id-token",
      });
      openedUrl = "";
    }
  });

  /**
   * ── ⚠ NO ATTACKER-AUTHORED SENTENCE REACHES THE APP'S OWN ERROR ─────────────────────────────
   *
   * `ai:login` returns this rejection's `message` verbatim to the renderer, where `SignInView` renders
   * it as the sign-in error. Escaped React text, so never markup injection — a channel for putting
   * someone else's sentence inside the product's chrome on its highest-trust screen.
   */
  it("⚠ does not surface a server-supplied error_description", async () => {
    const login = loginWithHostedUi(CFG);
    const failed = rejectionOf(login);
    await started();
    const state = pendingState();
    const phish = "Your session was revoked - call IT on 555-0100";

    await hit(
      `${CALLBACK}?error=invalid_request&error_description=${encodeURIComponent(phish)}` +
        `&state=${encodeURIComponent(state)}`
    );

    const message = (await failed).message;
    expect(message, "the attacker's prose must not become the app's error").not.toContain("555-0100");
    expect(message).not.toContain("revoked");
  });

  it("still reports a genuine error as a failure the user can act on", async () => {
    // Refusing to echo the server's text must not mean saying nothing.
    const login = loginWithHostedUi(CFG);
    const failed = rejectionOf(login);
    await started();
    const state = pendingState();

    await hit(`${CALLBACK}?error=access_denied&state=${encodeURIComponent(state)}`);

    expect((await failed).message).toMatch(/sign-in could not be completed/i);
  });

  it("ignores a path that is not the callback", async () => {
    const login = loginWithHostedUi(CFG);
    await started();
    const state = pendingState();

    const res = await hit("http://127.0.0.1:8788/favicon.ico");

    expect(res.status).toBe(404);
    expect(await stillPending(login)).toBe(true);
    await completeLogin(state);
    await expect(login).resolves.toBeTruthy();
  });
});
