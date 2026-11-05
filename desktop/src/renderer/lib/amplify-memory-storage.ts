// ── IN-MEMORY TOKEN STORAGE FOR AMPLIFY, IN THE RENDERER ────────────────────────
//
// Amplify keeps Cognito tokens in a `KeyValueStorageInterface`. This is that interface,
// backed by a plain Map that dies with the window.
//
// ── ⚠ WHY THE DEFAULT IS UNACCEPTABLE HERE ──
//
// Amplify defaults to `defaultStorage`, i.e. `localStorage`. That is a considered choice in
// the PORTAL (a browser refresh mid-journey
// must not lose the flow, and the app's real session is an httpOnly NextAuth cookie minted
// from a server-verified token).
//
// In an ELECTRON RENDERER the same default is a regression. `localStorage` there is Chromium
// LevelDB under `userData` — **unencrypted on macOS, Windows and Linux alike**. So the
// desktop would write a 30-day refresh token to disk in cleartext, while the SQLite copy of
// the same credential sits next to it encrypted by `safeStorage`. That is strictly worse
// than what the app does today, and it is a recorded blocking concern.
//
// ⚠ SO THIS MODULE IS A CONDITION OF THE NATIVE FORM SHIPPING AT ALL, not a refinement.
// If `configureAmplify` ever stops calling `setKeyValueStorage` with this, the desktop
// silently starts persisting credentials in cleartext and nothing fails.
//
// ── WHAT THE RENDERER IS ALLOWED TO HOLD, AND FOR HOW LONG ──
//
// Only for the seconds between "Cognito returned tokens" and "main has stored them". The
// renderer is the hostile-adjacent surface — a malicious transitive dependency in the Vite
// bundle runs here — so the window in which a token is reachable is the thing to minimise.
// `clearAll()` is called immediately after handoff (see the sign-in form) and again on
// unmount; it is not left to garbage collection.
//
// ⚠ THE RENDERER IS NOT THE SESSION AUTHORITY. Main owns the bearer and the only refresh
// path. Two refresh authorities against a non-rotating refresh
// token is a race that yields spurious `auth:expired`, so nothing here is durable by design:
// losing it is CORRECT, because main already has what matters.

/**
 * Amplify's storage contract, declared structurally rather than imported.
 *
 * `KeyValueStorageInterface` lives in `aws-amplify/utils`, and importing a type from the SDK
 * here would pull the SDK into this module's test — which then could not run in the
 * package's node-only vitest. The four methods are the whole interface; a mismatch is caught
 * at the `setKeyValueStorage` call site, which does import the real type.
 */
export interface KeyValueStorageLike {
  setItem(key: string, value: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * A `KeyValueStorageInterface` that never touches disk.
 *
 * Async to match Amplify's interface, which awaits every call — the operations themselves
 * are synchronous, and pretending otherwise would be the only way to get this wrong.
 */
export class InMemoryTokenStorage implements KeyValueStorageLike {
  private store = new Map<string, string>();

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async getItem(key: string): Promise<string | null> {
    // `?? null`, not `undefined`: Amplify branches on `null` for "absent", and a stray
    // `undefined` makes it treat a missing key as a present-but-empty value.
    return this.store.get(key) ?? null;
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  /**
   * Drop everything, synchronously.
   *
   * Separate from `clear()` because the caller that matters most is a cleanup path — an
   * unmount handler, or the line right after a successful handoff to main — where awaiting a
   * promise is either impossible or an invitation to forget. Same effect, no `await`.
   */
  clearAll(): void {
    this.store.clear();
  }

  /**
   * The keys held, so a caller can find one by suffix.
   *
   * ⚠ KEYS ONLY, NEVER THE VALUES. Amplify's refresh-token key is
   * `CognitoIdentityServiceProvider.<clientId>.<username>.refreshToken`, and the username is a
   * generated UUID we would otherwise have to reconstruct. A `values()` or `entries()` helper
   * would be a convenient way for future code to read every credential out of this store at
   * once, which is the opposite of the point — a caller that wants one must name it.
   */
  keys(): string[] {
    return [...this.store.keys()];
  }

  /**
   * How many entries are held. FOR TESTS ONLY.
   *
   * Deliberately a count and not the values: a helper that returned the tokens would be a
   * convenient way for future code to read a credential out of this store, which is the
   * opposite of the point.
   */
  size(): number {
    return this.store.size;
  }
}

/**
 * The single instance Amplify is configured with.
 *
 * A module-level singleton because `setKeyValueStorage` is global to the Amplify instance —
 * two stores would mean Amplify reading from one and the cleanup path clearing the other,
 * and the leak would be invisible.
 */
export const amplifyTokenStorage = new InMemoryTokenStorage();
