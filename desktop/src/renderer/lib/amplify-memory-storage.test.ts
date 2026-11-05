// ── TOKENS MUST NOT REACH DISK ───────────────────────────────────
//
// Amplify's default token storage is `localStorage`. In an Electron renderer that is Chromium
// LevelDB under `userData` — unencrypted on macOS, Windows and Linux alike — so the default
// would write a 30-day refresh token to disk in cleartext, next to the `safeStorage`-encrypted
// copy in SQLite. Strictly worse than what the app did before the native form existed.
//
// These tests pin the two things that prevent it:
//
//   1. the storage implementation is memory-only and touches no browser storage API;
//   2. `configureAmplify` actually INSTALLS it, and does so after `Amplify.configure` — which
//      is the ordering that matters, since `configure` installs the default provider.
//
// (2) is a source assertion: this package's vitest is node-only with no jsdom, so the real
// Amplify SDK cannot be driven here. The ordering is the part that silently regresses, and a
// source check catches exactly that.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InMemoryTokenStorage, amplifyTokenStorage } from "./amplify-memory-storage";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("InMemoryTokenStorage", () => {
  let storage: InMemoryTokenStorage;

  beforeEach(() => {
    storage = new InMemoryTokenStorage();
  });

  it("round-trips a value", async () => {
    await storage.setItem("idToken", "a-token");
    expect(await storage.getItem("idToken")).toBe("a-token");
  });

  it("returns null for an absent key, not undefined", async () => {
    // Amplify branches on `null` for "absent"; a stray `undefined` makes it treat a missing
    // key as present-but-empty, which surfaces as a session that exists and does not work.
    expect(await storage.getItem("nope")).toBeNull();
  });

  it("removes and clears", async () => {
    await storage.setItem("a", "1");
    await storage.setItem("b", "2");
    await storage.removeItem("a");
    expect(await storage.getItem("a")).toBeNull();
    expect(await storage.getItem("b")).toBe("2");

    await storage.clear();
    expect(storage.size()).toBe(0);
  });

  /**
   * `clearAll` exists for cleanup paths — an unmount handler, or the line after a handoff to
   * main — where awaiting is impossible or easy to forget. Same effect, no promise.
   */
  it("clearAll drops everything synchronously", async () => {
    await storage.setItem("idToken", "a-token");
    storage.clearAll();
    expect(storage.size()).toBe(0);
    expect(await storage.getItem("idToken")).toBeNull();
  });

  /**
   * ⚠ THE POINT OF THE WHOLE FILE. The implementation must not reach for any persistent
   * browser storage. Asserted against the SOURCE because a runtime test in a node environment
   * would pass trivially — there is no `localStorage` to accidentally use.
   */
  it("touches NO persistent browser storage", () => {
    const src = strip(read("./amplify-memory-storage.ts"));
    for (const api of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
      expect(src, `${api} would put a credential on disk`).not.toContain(api);
    }
  });

  it("holds state in a Map, so it dies with the window", () => {
    const src = strip(read("./amplify-memory-storage.ts"));
    expect(src).toMatch(/new Map</);
  });

  /**
   * A singleton, because `setKeyValueStorage` is global to the Amplify instance. Two stores
   * would mean Amplify reading from one while the cleanup path clears the other — a leak with
   * no symptom.
   */
  it("exports one shared instance", () => {
    expect(amplifyTokenStorage).toBeInstanceOf(InMemoryTokenStorage);
  });

  /**
   * ⚠ KEYS AND A COUNT, BUT NEVER THE VALUES IN BULK.
   *
   * `keys()` exists because Amplify's refresh-token key embeds a generated username
   * (`CognitoIdentityServiceProvider.<clientId>.<username>.refreshToken`) that the caller would
   * otherwise have to reconstruct — so finding it by suffix is the honest way to read one
   * credential deliberately.
   *
   * What must NOT exist is a way to read them all at once. `values()` or `entries()` would let
   * future code drain every credential from this store in a line, which is exactly the shape
   * this whole module exists to prevent.
   */
  it("exposes keys and a count, but no bulk value reader", () => {
    const src = strip(read("./amplify-memory-storage.ts"));
    expect(src).toMatch(/\bkeys\(\)/); // deliberate: one credential, named
    expect(src).not.toMatch(/\bvalues\(\)/);
    expect(src).not.toMatch(/\bentries\(\)/);
  });

  it("keys() returns the keys and NOT the values", () => {
    const s = new InMemoryTokenStorage();
    void s.setItem("CognitoIdentityServiceProvider.abc.user.refreshToken", "a-secret");
    expect(s.keys()).toEqual(["CognitoIdentityServiceProvider.abc.user.refreshToken"]);
    expect(JSON.stringify(s.keys())).not.toContain("a-secret");
  });
});

describe("configureAmplify wiring", () => {
  const src = strip(read("./amplify.ts"));

  /**
   * ⚠ ORDERING IS THE SILENT REGRESSION. `Amplify.configure` installs the DEFAULT token
   * provider, so `setKeyValueStorage` must run after it. Reversed, Amplify quietly persists to
   * localStorage and nothing fails.
   */
  it("installs the in-memory storage AFTER Amplify.configure", () => {
    const configureAt = src.indexOf("Amplify.configure");
    const storageAt = src.indexOf("setKeyValueStorage");
    expect(configureAt, "Amplify.configure must be present").toBeGreaterThan(-1);
    expect(storageAt, "setKeyValueStorage must be present").toBeGreaterThan(-1);
    expect(storageAt).toBeGreaterThan(configureAt);
  });

  it("passes the in-memory store, not a default", () => {
    expect(src).toMatch(/setKeyValueStorage\(\s*amplifyTokenStorage\s*\)/);
    // `defaultStorage` is the portal's choice and is correct there; here it writes tokens to disk.
    expect(src, "defaultStorage is localStorage — unencrypted LevelDB in Electron").not.toContain(
      "defaultStorage"
    );
  });

  /**
   * ⚠ THE POOL MUST NOT BE RENDERER-SUPPLIED. A `configureAmplify(poolId, clientId)` signature
   * would let anything in the bundle point the sign-in form at a pool of its choosing and
   * collect a password against it — the caller-chosen-provider risk the build-time pin originally
   * existed to prevent.
   */
  it("takes NO arguments — the pool comes from main", () => {
    expect(src).toMatch(/export async function configureAmplify\(\)/);
    expect(src).toContain("api.getPlatformConfig()");
  });

  it("declares the pool's real MFA and password policy rather than discovering them", () => {
    // The pool is MfaConfiguration: ON and MinimumLength 12 (both verified live). Declaring
    // them lets the form state the rules before Cognito rejects them.
    expect(src).toMatch(/status:\s*"on"/);
    expect(src).toMatch(/totpEnabled:\s*true/);
    expect(src).toMatch(/minLength:\s*12/);
  });
});
