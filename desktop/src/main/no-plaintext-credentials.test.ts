// ── ⚠ A CREDENTIAL IS NEVER WRITTEN IN CLEARTEXT ──────────────────────────────────────────────
//
// With no usable keychain — a Linux box with no Secret Service, a broken login keyring — a live Cognito ID
// token and a 30-DAY refresh token were written to `praimana.db` as plain text. Invisibly: the app behaved
// normally and nothing said the keychain had not been used.
//
// The refusal is only half a fix, and this file is mostly about the other half. A throw from the
// middle of `adoptSession` or `switchAccount` would leave a HALF-WRITTEN session — `connected: true`
// with no bearer, or worse, the outgoing account already mirrored away — so the checks have to run
// BEFORE the first write, and every boundary has to catch.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

vi.mock("better-sqlite3", () => ({ default: class {} }));

/** The keychain's answer, flipped per test. */
let encryptionAvailable = true;
let encryptThrows = false;
/**
 * ⚠ FAIL THE Nth ENCRYPTION, not all of them. The accounts re-seal writes two columns per row from two
 * `encryptSecret` calls, and the case worth pinning is the one where the FIRST succeeds and the second
 * does not — a half-sealed row is the one state no reader is written for. `encryptThrows` cannot express
 * that, because it fails every call and the row is never touched for a different reason.
 */
let encryptCalls = 0;
let failOnEncryptCall = 0;

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (s: string) => {
      encryptCalls += 1;
      if (encryptThrows) throw new Error("keychain refused");
      if (failOnEncryptCall > 0 && encryptCalls === failOnEncryptCall) {
        throw new Error("keychain refused mid-row");
      }
      return Buffer.from(`CIPHER:${s}`, "utf-8");
    },
    decryptString: (b: Buffer) => b.toString("utf-8").replace(/^CIPHER:/, ""),
  },
}));

import {
  EncryptionUnavailableError,
  assertSecretStorageAvailable,
  encryptSecret,
  encryptSettingValue,
  decryptSettingValue,
  isSecretStorageAvailable,
  retireLegacyPlaintextAccountCredentials,
} from "./database";

beforeEach(() => {
  encryptionAvailable = true;
  encryptThrows = false;
  encryptCalls = 0;
  failOnEncryptCall = 0;
});

describe("with a working keychain, nothing changes", () => {
  it("still encrypts and round-trips", () => {
    const enc = encryptSettingValue("auth_token", "live-token");
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(decryptSettingValue(enc)).toBe("live-token");
  });

  it("reports itself available", () => {
    expect(isSecretStorageAvailable()).toBe(true);
    expect(() => assertSecretStorageAvailable()).not.toThrow();
  });
});

describe("⚠ with NO keychain, the write is refused", () => {
  it("throws instead of returning the token unencrypted", () => {
    encryptionAvailable = false;
    /**
     * The exact regression. Reverting the function to `return value` makes this test fail — and the
     * assertion is written as "does not return the secret" as well as "throws", because a future
     * edit could satisfy one without the other.
     */
    expect(() => encryptSettingValue("auth_token", "live-token")).toThrow(EncryptionUnavailableError);
    let leaked: string | undefined;
    try {
      leaked = encryptSettingValue("cognito_refresh_token", "30-day-refresh");
    } catch {
      /* expected */
    }
    expect(leaked, "the secret must not come back in any form").toBeUndefined();
  });

  it("refuses account secrets too, not just settings", () => {
    // The `accounts` table holds one token PER remembered account, so a fallback here leaves a
    // cleartext credential for every person who has used the machine.
    encryptionAvailable = false;
    expect(() => encryptSecret("live-token")).toThrow(EncryptionUnavailableError);
  });

  it("refuses when the keychain is present but encryptString FAILS", () => {
    // Two distinct conditions, one outcome. The old code caught this and fell through to plaintext.
    encryptionAvailable = true;
    encryptThrows = true;
    expect(() => encryptSettingValue("auth_token", "live-token")).toThrow(EncryptionUnavailableError);
    expect(() => encryptSecret("live-token")).toThrow(EncryptionUnavailableError);
  });

  it("reports itself unavailable rather than throwing from the probe", () => {
    // Callers use this as a precondition, so it must answer rather than explode.
    encryptionAvailable = false;
    expect(isSecretStorageAvailable()).toBe(false);
    expect(() => assertSecretStorageAvailable("your sign-in")).toThrow(/keychain is unavailable/);
  });

  it("⚠ STILL LETS THE USER SIGN OUT", () => {
    /**
     * Sign-out writes `""` to every credential key. An empty string is not a secret and needs no
     * keychain — so the one action a user with a broken keychain most needs is still available. Had
     * the refusal covered empty values, this fix would have trapped them in a signed-in-but-broken
     * app with no way out.
     */
    encryptionAvailable = false;
    for (const key of ["auth_token", "cognito_refresh_token", "user_password"]) {
      expect(encryptSettingValue(key, "")).toBe("");
    }
    expect(encryptSecret("")).toBe("");
  });

  it("⚠ still READS legacy plaintext, which is not a contradiction", () => {
    /**
     * A value with no `enc:v1:` prefix predates the encryption, or was written by a build with this
     * hole. Refusing to read it would sign those users out with no way back. Reject on the way IN,
     * tolerate on the way OUT.
     */
    encryptionAvailable = false;
    expect(decryptSettingValue("legacy-plaintext-token")).toBe("legacy-plaintext-token");
  });

  it("leaves non-sensitive settings alone", () => {
    // A broken keychain must not stop the app remembering a window layout.
    encryptionAvailable = false;
    expect(encryptSettingValue("server_url", "https://example.test")).toBe("https://example.test");
    expect(encryptSettingValue("sidebar_collapsed", "true")).toBe("true");
  });
});

describe("⚠ no half-written session survives a refusal", () => {
  const AI = strip(readFileSync(local("./handlers/ai.ts"), "utf8"));
  const ACCOUNTS = strip(readFileSync(local("./accounts.ts"), "utf8"));

  it("adoptSession asks BEFORE its first write and before the in-memory bearer", () => {
    /**
     * The ordering fact, and the one that would break silently. `adoptSession` writes eight settings;
     * `auth_token` is the first, but `assertSecretStorageAvailable` sitting anywhere below
     * `authToken = session.idToken` would leave an in-memory bearer with no stored counterpart —
     * the same inconsistency, one process lifetime later.
     */
    const body = AI.slice(AI.indexOf("export function adoptSession"));
    const assertAt = body.indexOf("assertSecretStorageAvailable(");
    const memAt = body.indexOf("authToken = session.idToken");
    const firstWrite = body.indexOf("writeSetting(");
    expect(assertAt).toBeGreaterThan(-1);
    expect(assertAt, "must precede the in-memory assignment").toBeLessThan(memAt);
    expect(assertAt, "must precede every write").toBeLessThan(firstWrite);
  });

  /**
   * ⚠ THE HOSTED-UI PATH NO LONGER HAS ITS OWN CHECK, BECAUSE IT NO LONGER HAS ITS OWN WRITES.
   *
   * It used to persist the bearer, the refresh token and the profile inline, so it needed a duplicate
   * `assertSecretStorageAvailable` — and duplicating that check was the visible symptom of the real
   * problem: the path skipped every other invariant
   * `adoptSession` owns as well (`connected`, the cognito-config reset, the unsynced-turn sweep). It
   * calls `adoptSession` now, which asserts before its first write, so the property holds by
   * construction rather than by a second copy.
   */
  it("the hosted-UI path adopts through adoptSession rather than writing credentials itself", () => {
    const body = AI.slice(AI.indexOf('"ai:login"'));
    expect(body).toContain("adoptSession({");
    expect(body, "no inline credential writes may survive here").not.toMatch(
      /writeSetting\("(auth_token|cognito_refresh_token|user_email)"/
    );
    // And the refusal is still turned into a sentence rather than an IPC rejection.
    expect(body.indexOf("EncryptionUnavailableError")).toBeGreaterThan(body.indexOf("adoptSession({"));
  });

  it("both sign-in handlers turn the refusal into a sentence, not an IPC rejection", () => {
    /**
     * An uncaught throw reaches the renderer as "Error invoking remote method 'auth:completeSignIn'",
     * which tells a participant nothing and reads as a crash.
     */
    expect((AI.match(/EncryptionUnavailableError/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((AI.match(/KEYCHAIN_REFUSAL_MESSAGE/g) ?? []).length).toBe(3); // 1 definition + 2 uses
    expect(AI).toMatch(/keychain is unavailable/i);
  });

  it("says what would fix it", () => {
    // A refusal with no next step gets reported as "the app is broken".
    expect(AI).toMatch(/gnome-keyring|kwallet/i);
  });

  it("a token renewal that cannot be stored becomes an expiry, not a throw", () => {
    /**
     * `renewAuthToken` runs inside `fetchAuthed`, on the background sweep and on a WebSocket 401 —
     * none of which can show a message. Returning null routes into the existing `auth:expired` path.
     */
    /**
     * Asserted as an ORDERING inside the renewal block rather than as one regex: a single pattern
     * with `{0,200}` windows breaks whenever a line is added between the pieces (it did, when the
     * audit call went in), which makes it a test of formatting rather than of behaviour.
     */
    const body = AI.slice(AI.indexOf("const tokens = result.tokens"));
    const block = body.slice(0, body.indexOf("return tokens.idToken"));
    const tryAt = block.indexOf("try {");
    const writeAt = block.indexOf('writeSetting("auth_token"');
    const catchAt = block.indexOf("EncryptionUnavailableError");
    const returnNull = block.indexOf("return null", catchAt);
    expect(tryAt, "the write must be guarded").toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(tryAt);
    expect(catchAt, "the refusal must be caught").toBeGreaterThan(writeAt);
    expect(returnNull, "and become a null return, not a throw").toBeGreaterThan(catchAt);
  });

  it("switchAccount refuses BEFORE it overwrites the live session", () => {
    /**
     * The worst partial-write case in the codebase: `syncActiveAccountFromSettings()` has already
     * mirrored the OUTGOING session away by this point, so a throw mid-sequence leaves neither
     * account usable — exactly what the platform check above it exists to prevent.
     */
    const body = ACCOUNTS.slice(ACCOUNTS.indexOf("export function switchAccount"));
    const guard = body.indexOf("isSecretStorageAvailable()");
    /**
     * ⚠ THE FIRST WRITE IS THE TOKEN NOW, NOT `serverUrl`. That line is gone deliberately: a saved
     * account row must not be able to move the origin every authenticated request goes to, because
     * the platform keys have three documented writers and a switch is not one of them (AWS Security
     * Agent, Medium). So this asserts against whatever the first session write actually is.
     */
    const firstWrite = body.indexOf("writeSetting(SESSION_KEYS.authToken");
    expect(guard).toBeGreaterThan(-1);
    expect(firstWrite, "there must still be a session write to guard").toBeGreaterThan(-1);
    expect(guard, "guard before the first write").toBeLessThan(firstWrite);
    expect(body, "and the platform origin is no longer written from here").not.toContain(
      "writeSetting(SESSION_KEYS.serverUrl"
    );
  });

  it("the account mirror skips rather than taking a background caller down", () => {
    // Best-effort by design; it runs from renewAuthToken and team joins with nobody watching.
    const body = ACCOUNTS.slice(ACCOUNTS.indexOf("export function syncActiveAccountFromSettings"));
    const guard = body.indexOf("isSecretStorageAvailable()");
    expect(guard).toBeGreaterThan(-1);
    expect(body.slice(guard, guard + 300)).toContain("return");
    expect(body.indexOf("db.prepare(", guard)).toBeGreaterThan(guard);
  });
});

describe("the boot check the report asked for", () => {
  const DB = readFileSync(local("./database.ts"), "utf8");

  it("warns at startup when the keychain is unavailable", () => {
    // So the first symptom is a log line naming the cause, not a sign-in that fails for no reason.
    const init = DB.slice(DB.indexOf("export async function initDatabase"));
    expect(init).toContain("isSecretStorageAvailable()");
    expect(init).toMatch(/console\.warn/);
  });

  it("⚠ does NOT refuse to boot", () => {
    /**
     * A user with no keychain can still read their transcripts and sign out — everything except
     * storing a NEW credential. Refusing to start would take all of that away to prevent nothing,
     * since the writers already refuse.
     */
    const init = DB.slice(DB.indexOf("export async function initDatabase"));
    expect(init).not.toMatch(/throw new (Error|EncryptionUnavailableError)/);
  });
});

/**
 * ── ⚠ THE PLAINTEXT TOLERANCE IS NOW BOUNDED IN TIME ──────────────────────────────────────────
 *
 * `decryptSettingValue` accepts a value without the `enc:v1:` prefix, which is correct and permanent — a row
 * written before the encryption existed must stay readable. The gap was that the tolerance had no END:
 * `ENC_PREFIX` is a known literal, so a plaintext `auth_token` planted in the SQLite file is accepted as a
 * valid credential for ever, with nothing to distinguish "written by an old build" from "planted".
 *
 * Not a privilege boundary — writing that row means already running as this user — but after one launch
 * on a machine with a keychain, every sensitive value on disk is sealed, so the plaintext path stops
 * being a standing accepted input.
 */
describe("legacy plaintext credentials are re-sealed at boot", () => {
  const DB = readFileSync(local("./database.ts"), "utf8");
  const code = strip(DB);

  it("runs the migration at startup, after the schema is guaranteed", () => {
    const init = code.slice(code.indexOf("export async function initDatabase"));
    expect(init).toContain("retireLegacyPlaintextCredentials()");
    // After repairProjectRoots, and before any handler is registered — nothing can read the value in
    // the window before it is re-sealed.
    expect(init.indexOf("repairProjectRoots(db)")).toBeLessThan(
      init.indexOf("retireLegacyPlaintextCredentials()")
    );
  });

  it("covers every sensitive key, not a hand-listed subset", () => {
    // A subset would leave whichever key someone forgot tolerated for ever.
    const fn = code.slice(code.indexOf("function retireLegacyPlaintextCredentials"));
    expect(fn).toMatch(/for \(const key of SENSITIVE_KEYS\)/);
  });

  it("⚠ skips values that are already sealed, and empty ones", () => {
    // Every launch after the first must do nothing at all; an empty string is not a secret.
    const fn = code.slice(code.indexOf("function retireLegacyPlaintextCredentials"));
    expect(fn).toMatch(/if \(!stored \|\| stored\.startsWith\(ENC_PREFIX\)\) continue/);
  });

  it("⚠ does NOTHING without a keychain, rather than throwing at boot", () => {
    /**
     * Re-writing a value we cannot encrypt would either throw — taking the app down at startup over a
     * credential the user may not even need — or leave it exactly as it was. So it returns early, and
     * the read path's existing tolerance carries that machine.
     */
    const fn = code.slice(code.indexOf("function retireLegacyPlaintextCredentials"));
    expect(fn).toMatch(/if \(!isSecretStorageAvailable\(\)\) return/);
  });

  it("is best-effort per key, so one failure does not stop the app starting", () => {
    const fn = code.slice(code.indexOf("function retireLegacyPlaintextCredentials"));
    expect(fn).toMatch(/catch \(err\)/);
    expect(fn).toMatch(/could not re-seal/);
  });

  it("⚠ still READS legacy plaintext, which the migration does not change", () => {
    // The asymmetry is permanent: a machine with no keychain, or a value written between launches,
    // must still be readable. The migration bounds the tolerance; it does not remove it.
    expect(code).toMatch(/if \(stored == null \|\| !stored\.startsWith\(ENC_PREFIX\)\) return stored/);
  });
});

/**
 * ── ⚠ AND THE RE-SEAL COVERS THE `accounts` TABLE, NOT ONLY `settings` ────────────────────────
 *
 * The repair above walked `SENSITIVE_KEYS` against `settings`, and the same credentials are also held
 * per remembered account in `accounts.auth_token` / `accounts.cognito_refresh_token`. Nothing ever
 * re-sealed those columns, so the module's own claim — "after one launch on a machine with a working
 * keychain, every sensitive value on disk is sealed" — was false of the store with MORE exposure in it:
 * one live ID token and one 30-DAY REFRESH TOKEN per person who has used the machine.
 *
 * ⚠ DRIVEN AGAINST A FAKE TABLE RATHER THAN SQLITE, for the reason repair-project-roots.test.ts gives:
 * what matters is WHICH rows the repair decides to rewrite and WHAT it writes into them, and
 * `encryptSecret` — the real implementation, deliberately not mocked — is what makes the second half
 * observable.
 */
function fakeAccounts(rows: Array<{ id: string; auth_token: string | null; cognito_refresh_token: string | null }>) {
  const writes: Array<{ id: string; auth_token: unknown; cognito_refresh_token: unknown }> = [];
  return {
    rows,
    writes,
    prepare(sql: string) {
      return {
        all: () => rows,
        run: (...params: unknown[]) => {
          if (!sql.startsWith("UPDATE")) return;
          const [auth_token, cognito_refresh_token, id] = params as [unknown, unknown, string];
          writes.push({ id, auth_token, cognito_refresh_token });
          // Apply it, so a second pass sees what the first one did.
          const row = rows.find((r) => r.id === id);
          if (row) {
            row.auth_token = auth_token as string | null;
            row.cognito_refresh_token = cognito_refresh_token as string | null;
          }
        },
      };
    },
  };
}

describe("⚠ legacy plaintext ACCOUNT credentials are re-sealed too", () => {
  it("seals a row an older build left in cleartext", () => {
    const db = fakeAccounts([
      { id: "acct-1", auth_token: "live-id-token", cognito_refresh_token: "30-day-refresh" },
    ]);

    const resealed = retireLegacyPlaintextAccountCredentials(db);

    expect(resealed, "both columns counted").toBe(2);
    expect(db.rows[0].auth_token).toMatch(/^enc:v1:/);
    expect(db.rows[0].cognito_refresh_token).toMatch(/^enc:v1:/);
    // And the value survives the round trip — a seal that lost the token would sign the user out.
    expect(decryptSettingValue(db.rows[0].auth_token)).toBe("live-id-token");
    expect(decryptSettingValue(db.rows[0].cognito_refresh_token)).toBe("30-day-refresh");
  });

  it("⚠ seals EVERY remembered account, not just the active one", () => {
    /**
     * The reason this finding is worse in this table than in `settings`. `switchAccount` re-seals only
     * by side effect, and only for the account being switched INTO — so a row for somebody who never
     * signs in on this machine again would otherwise stay plaintext for the life of the file.
     */
    const db = fakeAccounts([
      { id: "acct-1", auth_token: "a-token", cognito_refresh_token: "a-refresh" },
      { id: "acct-2", auth_token: "b-token", cognito_refresh_token: "b-refresh" },
      { id: "acct-3", auth_token: "c-token", cognito_refresh_token: "c-refresh" },
    ]);

    expect(retireLegacyPlaintextAccountCredentials(db)).toBe(6);
    for (const row of db.rows) {
      expect(row.auth_token).toMatch(/^enc:v1:/);
      expect(row.cognito_refresh_token).toMatch(/^enc:v1:/);
    }
  });

  it("⚠ is a no-op on the second launch, and on an install that was never affected", () => {
    // Every launch after the first must touch nothing at all.
    const db = fakeAccounts([
      { id: "acct-1", auth_token: "live-id-token", cognito_refresh_token: "30-day-refresh" },
    ]);
    retireLegacyPlaintextAccountCredentials(db);
    const writesAfterFirstPass = db.writes.length;

    expect(retireLegacyPlaintextAccountCredentials(db), "nothing left to seal").toBe(0);
    expect(db.writes.length, "and no statement was run").toBe(writesAfterFirstPass);
  });

  it("leaves empty and NULL columns alone — neither is a secret", () => {
    /**
     * Sign-out writes "" and `removeAccount` NULLs these columns. Sealing an empty string would turn a
     * cleared credential into a value that looks like a live one, and needs a keychain to read back.
     */
    const db = fakeAccounts([
      { id: "signed-out", auth_token: "", cognito_refresh_token: "" },
      { id: "never-had-one", auth_token: null, cognito_refresh_token: null },
    ]);

    expect(retireLegacyPlaintextAccountCredentials(db)).toBe(0);
    expect(db.writes, "no row was touched").toEqual([]);
  });

  it("seals one column without disturbing an already-sealed sibling", () => {
    // A half-sealed row is reachable: `switchAccount` re-seals the settings copy, not this one.
    const sealed = encryptSecret("already-safe");
    const db = fakeAccounts([
      { id: "acct-1", auth_token: sealed, cognito_refresh_token: "still-plain" },
    ]);

    expect(retireLegacyPlaintextAccountCredentials(db)).toBe(1);
    expect(db.rows[0].auth_token, "untouched, not re-encrypted").toBe(sealed);
    expect(decryptSettingValue(db.rows[0].cognito_refresh_token)).toBe("still-plain");
  });

  /**
   * ⚠ THE PARTIAL-WRITE CASE, which is why both ciphertexts are computed before the statement runs.
   * `switchAccount` reads both columns of a row together, so a row with a sealed token and a plaintext
   * refresh token is not a state any reader is written for. If the second encryption fails, the right
   * outcome is a row left exactly as it was — the state the read path already tolerates.
   */
  it("⚠ leaves a row untouched when sealing it only half-succeeds", () => {
    const original = { id: "acct-1", auth_token: "a-token", cognito_refresh_token: "a-refresh" };
    const db = fakeAccounts([{ ...original }]);
    // The first encryption succeeds, the second does not — the state a transaction would be reached for.
    failOnEncryptCall = 2;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const resealed = retireLegacyPlaintextAccountCredentials(db);

    expect(resealed, "a row that did not fully seal is not counted").toBe(0);
    expect(db.writes, "no statement ran at all").toEqual([]);
    expect(db.rows[0], "so the row is byte-for-byte what it was").toEqual(original);
    expect(warn, "and the failure is visible to whoever reads the log").toHaveBeenCalled();
    warn.mockRestore();
  });

  it("carries on to the next account after one row fails", () => {
    // Best-effort PER ROW: one unreadable row must not abandon everybody else's credentials.
    const db = fakeAccounts([
      { id: "acct-1", auth_token: "a-token", cognito_refresh_token: "a-refresh" },
      { id: "acct-2", auth_token: "b-token", cognito_refresh_token: "b-refresh" },
    ]);
    failOnEncryptCall = 1; // fails acct-1's first column only
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(retireLegacyPlaintextAccountCredentials(db)).toBe(2);
    expect(db.rows[0], "the failed row is left alone").toEqual({
      id: "acct-1",
      auth_token: "a-token",
      cognito_refresh_token: "a-refresh",
    });
    expect(db.rows[1].auth_token, "the next row is still sealed").toMatch(/^enc:v1:/);
    warn.mockRestore();
  });

  it("survives a machine with no accounts table at all", () => {
    // A failure here must not stop the app starting.
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = {
      prepare() {
        throw new Error("no such table: accounts");
      },
    };
    expect(() => retireLegacyPlaintextAccountCredentials(broken)).not.toThrow();
    expect(retireLegacyPlaintextAccountCredentials(broken)).toBe(0);
    spy.mockRestore();
  });
});

/** The boot repair calls the accounts pass, not just the settings loop. */
describe("the boot repair covers both stores", () => {
  const code = strip(readFileSync(local("./database.ts"), "utf8"));

  it("runs the accounts pass from retireLegacyPlaintextCredentials", () => {
    const fn = code.slice(
      code.indexOf("function retireLegacyPlaintextCredentials"),
      code.indexOf("export function retireLegacyPlaintextAccountCredentials")
    );
    expect(fn).toContain("retireLegacyPlaintextAccountCredentials(db)");
  });

  it("counts both stores in the one log line, so a reader sees the whole repair", () => {
    const fn = code.slice(code.indexOf("function retireLegacyPlaintextCredentials"));
    const accountsPass = fn.indexOf("retireLegacyPlaintextAccountCredentials(db)");
    const logLine = fn.indexOf("re-encrypted");
    expect(accountsPass).toBeGreaterThan(-1);
    expect(logLine, "the log must come after both passes").toBeGreaterThan(accountsPass);
  });

  it("⚠ never logs the account id", () => {
    // It is a Cognito subject — an identity — and this warning goes to a plaintext console log.
    const fn = code.slice(code.indexOf("export function retireLegacyPlaintextAccountCredentials"));
    expect(fn).not.toMatch(/console\.warn\([^)]*row\.id/);
  });
});
