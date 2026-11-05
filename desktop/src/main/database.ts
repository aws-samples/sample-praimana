import Database from "better-sqlite3";
import { app, safeStorage } from "electron";
import fs from "fs";
import path from "path";
import { runMigrations } from "./migrations";
import { repairProjectRoots } from "./repair-project-roots";

let db: Database.Database;

/**
 * Owner read/write only. Matches TELEMETRY_FILE_MODE and AUDIT_FILE_MODE — and this file carries more
 * than either of them. See `narrowDatabasePermissions`.
 */
const DB_FILE_MODE = 0o600;

export function getDb(): Database.Database {
  return db;
}

// ── Settings encryption (H-1) ────────────────────────────────────────────────
// Sensitive settings are encrypted at rest with the OS keychain via safeStorage
// so credentials/tokens are never stored in cleartext in the SQLite file.
// Encrypted values are stored as "enc:v1:<base64>"; reads transparently decrypt
// and fall back to plaintext for values written before this change.
const SENSITIVE_KEYS = new Set(["user_password", "auth_token", "cognito_refresh_token"]);
const ENC_PREFIX = "enc:v1:";

export function isSensitiveSetting(key: string): boolean {
  return SENSITIVE_KEYS.has(key);
}

/**
 * ── ⚠ NO SILENT PLAINTEXT FALLBACK ────────────────────────────────────────────────────────────
 *
 * The comment called it a fallback; what it fell back to was the exact outcome the encryption exists to
 * prevent, and it did so invisibly: the file is world-readable to any process running as this user, the app
 * looked normal, and nothing in the UI or the logs said the keychain had not been used.
 *
 * ⚠ AND THE READ SIDE MUST KEEP ACCEPTING PLAINTEXT, which is not a contradiction. A value without
 * the `enc:v1:` prefix predates the encryption (or was written by a build with this hole), and
 * refusing to read it would sign those users out with no way back. Reject on the way IN, tolerate on
 * the way OUT — the asymmetry is deliberate and permanent.
 */
export class EncryptionUnavailableError extends Error {
  constructor(what: string) {
    super(
      `Cannot store ${what} securely: this system's keychain is unavailable, and writing it ` +
        `unencrypted would leave a live credential in cleartext on disk.`
    );
    this.name = "EncryptionUnavailableError";
  }
}

/**
 * Is OS-backed encryption usable right now?
 *
 * ⚠ CALL THIS BEFORE A SEQUENCE OF WRITES, not instead of the checks below. The writers throw as a
 * backstop, but a throw halfway through `adoptSession` would leave a HALF-WRITTEN session — email
 * and `connected` stored, no token — which the app reads as signed-in-but-broken. A precondition
 * check turns that into a clean refusal before anything is persisted.
 */
export function isSecretStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    // A platform where the call itself fails is not a platform that can encrypt.
    return false;
  }
}

/** Refuse to proceed unless secrets can be stored encrypted. @throws EncryptionUnavailableError */
export function assertSecretStorageAvailable(what = "your sign-in"): void {
  if (!isSecretStorageAvailable()) throw new EncryptionUnavailableError(what);
}

export function encryptSettingValue(key: string, value: string): string {
  if (!isSensitiveSetting(key) || value === "") return value;
  /**
   * ⚠ `value === ""` ABOVE IS WHY SIGN-OUT STILL WORKS. Clearing a credential writes an empty
   * string, which is not a secret and needs no keychain — so a machine whose keychain has broken can
   * still sign out, which is the one thing such a user most needs to be able to do.
   */
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(value).toString("base64");
    }
  } catch (err) {
    // Distinguished from "unavailable" in the log only; both outcomes are a refusal.
    console.error("[database] safeStorage.encryptString failed:", err instanceof Error ? err.message : err);
    throw new EncryptionUnavailableError(`the "${key}" credential`);
  }
  throw new EncryptionUnavailableError(`the "${key}" credential`);
}

export function decryptSettingValue(stored: string | null): string | null {
  if (stored == null || !stored.startsWith(ENC_PREFIX)) return stored; // legacy plaintext
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), "base64"));
  } catch {
    return null;
  }
}

/**
 * Encrypt an arbitrary secret (e.g. an account's auth token stored outside the
 * `settings` table). Mirrors the settings encryption but not keyed by setting name.
 *
 * ⚠ REFUSES rather than falling back to plaintext — same reasoning as `encryptSettingValue`, and it
 * matters just as much here: the `accounts` table holds a stored token PER remembered account, so a
 * plaintext fallback leaves one cleartext credential for every person who has used this machine.
 *
 * @throws EncryptionUnavailableError
 */
export function encryptSecret(value: string): string {
  if (value === "") return value;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(value).toString("base64");
    }
  } catch (err) {
    console.error("[database] safeStorage.encryptString failed:", err instanceof Error ? err.message : err);
    throw new EncryptionUnavailableError("a stored account credential");
  }
  throw new EncryptionUnavailableError("a stored account credential");
}

/** Decrypt a secret written by {@link encryptSecret}; passes through plaintext. */
export function decryptSecret(stored: string | null): string | null {
  return decryptSettingValue(stored);
}

/** Read a setting, transparently decrypting sensitive values. */
export function readSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return decryptSettingValue(row?.value ?? null);
}

/** Write a setting, transparently encrypting sensitive values. */
export function writeSetting(key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    key,
    encryptSettingValue(key, value)
  );
}

/**
 * ── ⚠ RE-SEAL ANY CREDENTIAL LEFT IN CLEARTEXT BY AN OLDER BUILD ──────────────────────────────
 *
 * `decryptSettingValue` returns a value without the `enc:v1:` prefix verbatim — deliberately, because a row
 * written before the encryption existed must still be readable, and refusing it would sign those users out
 * with no way back. The gap is that the tolerance had no end: `ENC_PREFIX` is a known literal, so a plaintext
 * `auth_token` planted in the SQLite file is accepted as a valid credential for ever, and nothing
 * distinguishes "written by an old build" from "planted".
 *
 * ⚠ THIS IS NOT A PRIVILEGE BOUNDARY AND IS NOT CLAIMED AS ONE. Writing that row requires already
 * running as this user. What the migration does is bound the tolerance in TIME: after one launch on a
 * machine with a working keychain, every sensitive value on disk is sealed, so the plaintext path stops
 * being a standing accepted input and becomes a one-launch upgrade step.
 *
 * ⚠ "EVERY SENSITIVE VALUE" MEANS BOTH STORES, AND FOR A WHILE IT ONLY MEANT ONE. A security
 * finding (Medium): this walked `settings` alone, while the same credentials are also held per
 * remembered account in `accounts.auth_token` / `accounts.cognito_refresh_token`. So the sentence above
 * was false of the store with MORE exposure in it — one token per person who has used the machine —
 * and it stayed false for ever, because nothing else ever re-seals those columns. Both stores now, and
 * the claim is worth only as much as the second pass below.
 *
 * ⚠ SILENT WHEN THERE IS NOTHING TO DO, which is every launch after the first. And it does nothing at
 * all without a keychain: re-writing a value we cannot encrypt would either throw (taking the app down
 * at boot over a credential the user may not even need) or leave it exactly as it was.
 */
function retireLegacyPlaintextCredentials(): void {
  if (!isSecretStorageAvailable()) return;

  let resealed = 0;
  for (const key of SENSITIVE_KEYS) {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      const stored = row?.value;
      // Absent, empty, or already sealed — nothing to do. Empty is not a secret (see the write path).
      if (!stored || stored.startsWith(ENC_PREFIX)) continue;

      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
        key,
        encryptSettingValue(key, stored)
      );
      resealed++;
    } catch (err) {
      /**
       * Best-effort, per key. A failure here must not stop the app from starting — the value is left as
       * it was, which is exactly the state the read path already tolerates.
       */
      console.warn(
        `[database] could not re-seal the legacy "${key}" value:`,  // nosemgrep: unsafe-formatstring
        err instanceof Error ? err.message : err
      );
    }
  }

  resealed += retireLegacyPlaintextAccountCredentials(db);

  if (resealed > 0) {
    // Logged unconditionally: it happens once per machine and explains a changed file to anyone looking.
    console.warn(`[database] re-encrypted ${resealed} credential(s) left in cleartext by an older build`);
  }
}

/**
 * ── ⚠ THE SAME REPAIR FOR THE `accounts` TABLE, WHICH THE SETTINGS LOOP CANNOT REACH ──────────
 *
 * The loop above walks `SENSITIVE_KEYS` against `settings`, and the same credentials are ALSO stored
 * per remembered account in `accounts.auth_token` / `accounts.cognito_refresh_token` (accounts.ts).
 * Nothing re-sealed those columns, so the claim written 40 lines up — "after one launch on a machine
 * with a working keychain, every sensitive value on disk is sealed" — was simply not true of this
 * store. `decryptSecret` returns any value without the `enc:v1:` prefix verbatim, by design, so those
 * rows stayed usable credentials for ever.
 *
 * ⚠ AND THE EXPOSURE IS PER PERSON, WHICH IS WHAT MAKES IT WORSE HERE THAN IN `settings`. The note on
 * `encryptSecret` already says why: this table holds one stored token PER remembered account, so an
 * install that ran the plaintext-fallback build keeps a live ID token and a 30-DAY REFRESH TOKEN in
 * cleartext for every person who has used that machine. `switchAccount` reads them back and installs
 * them as the live session without re-sealing the row, so a row for an account nobody switches into
 * again would otherwise stay plaintext for the rest of the file's life.
 *
 * ⚠ BOTH COLUMNS IN ONE STATEMENT, AND NO TRANSACTION WRAPPER, because the statement IS the atom. A
 * partial pass is the one outcome worth avoiding — `switchAccount` reads both columns of a row together
 * (accounts.ts), so a row whose token was rewritten while its refresh token was not is a state no
 * reader is written for. Both ciphertexts are therefore computed BEFORE the write: if the second
 * `encryptSecret` throws, `run` is never reached and the row is left exactly as it was, which is the
 * state the read path already tolerates. Wrapping one statement in a transaction would add nothing.
 *
 * ⚠ PER-ROW ERROR HANDLING, matching the per-key handling above: one unreadable row must not abandon
 * the others, and no failure here may stop the app starting.
 *
 * ⚠ IT DOES NOT TOUCH A ROW IT CANNOT IMPROVE. Empty and already-sealed values are skipped for the same
 * reasons as above, so this is a no-op on every launch after the first and on every install that never
 * ran an affected build.
 *
 * ⚠ TAKES THE DATABASE RATHER THAN READING THE MODULE-LEVEL HANDLE, and is exported, for the reason
 * `repairProjectRoots` does: this is a boot repair whose whole value is in WHICH rows it decides to
 * rewrite, and that decision is worth testing directly rather than through `initDatabase`.
 */
interface ResealableDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

interface AccountCredentialRow {
  id: string;
  auth_token: string | null;
  cognito_refresh_token: string | null;
}

export function retireLegacyPlaintextAccountCredentials(target: ResealableDb): number {
  let resealed = 0;
  try {
    const rows = target
      .prepare("SELECT id, auth_token, cognito_refresh_token FROM accounts")
      .all() as AccountCredentialRow[];

    // Empty is not a secret, and an `enc:v1:` value is already sealed — the same two skips as above.
    const needsSealing = (v: string | null): v is string => !!v && !v.startsWith(ENC_PREFIX);

    const update = target.prepare(
      "UPDATE accounts SET auth_token = ?, cognito_refresh_token = ? WHERE id = ?"
    );

    for (const row of rows) {
      const tokenPlain = needsSealing(row.auth_token);
      const refreshPlain = needsSealing(row.cognito_refresh_token);
      if (!tokenPlain && !refreshPlain) continue;

      try {
        // Both computed first — see the note above on why this is the atomicity guarantee.
        const sealedToken = tokenPlain ? encryptSecret(row.auth_token as string) : row.auth_token;
        const sealedRefresh = refreshPlain
          ? encryptSecret(row.cognito_refresh_token as string)
          : row.cognito_refresh_token;

        update.run(sealedToken, sealedRefresh, row.id);
        resealed += (tokenPlain ? 1 : 0) + (refreshPlain ? 1 : 0);
      } catch (err) {
        /**
         * ⚠ THE ACCOUNT ID IS NOT LOGGED. It is a Cognito subject, i.e. an identity, and this warning
         * goes to a plaintext console log. The count in the caller's line is all a reader needs to
         * understand why the file changed.
         */
        console.warn(
          "[database] could not re-seal a stored account credential:",
          err instanceof Error ? err.message : err
        );
      }
    }
  } catch (err) {
    // A missing or unreadable `accounts` table must not stop the app starting.
    console.warn(
      "[database] could not scan the accounts table for legacy plaintext credentials:",
      err instanceof Error ? err.message : err
    );
  }
  return resealed;
}

/**
 * ── ⚠ 0600, THE STANDARD THE TWO LOG FILES ALREADY MEET ───────────────────────────────────────
 *
 * `new Database(path)` applies no mode, so the file is created 0666 masked by the umask — commonly 0644,
 * readable by every other local account.
 *
 * ⚠ AND THIS FILE CARRIES STRICTLY MORE THAN EITHER LOG. telemetry.ts and security-audit.ts both set
 * 0600 and both write out the 0644 rationale for doing it; what they hold is crash stacks and a list of
 * who signed in. This holds `chat_messages.content` — the participant's full prompts and the assistant's
 * replies, i.e. their code and their design discussion — plus chat titles, absolute project paths,
 * account email/name/user id, and the team invite code. Only three settings keys are sealed with
 * safeStorage (`SENSITIVE_KEYS`); everything else here is cleartext TEXT. The less sensitive files were
 * held to a standard this one was not.
 *
 * ⚠ THE WAL SIDECARS TOO, WHICH ARE THE EASY ONES TO FORGET. `journal_mode = WAL` above creates
 * `-wal` and `-shm` beside the database with the same default permissions, and the `-wal` holds recently
 * written pages — i.e. the most recent transcript content. Narrowing only the main file would leave the
 * newest data at 0644.
 *
 * ⚠ RE-APPLIED ON EVERY OPEN, NOT ONLY ON CREATE, for the reason telemetry.ts gives: a mode applies when
 * a file is created, so a database an earlier build wrote at 0644 would keep those bits for ever. This
 * is the upgrade path, and it is the whole reason this is a chmod rather than an option.
 *
 * ⚠ BEST-EFFORT, AND IT MUST NOT THROW. Windows has no POSIX mode, the sidecars may not exist yet on a
 * fresh database, and a machine whose permissions cannot be changed still needs an app that starts.
 * Failing to narrow a file is not a reason to deny somebody their transcripts.
 *
 * ⚠ WHAT THIS DOES NOT DO: encrypt the contents. The finding names that too, and it is a larger change —
 * extending the safeStorage sealing to `chat_messages.content` costs every read and write on the hot
 * path and would want SQLCipher rather than per-column sealing. This closes the part that is a
 * three-line omission against a standard the codebase already set for itself; the encryption question
 * is left open deliberately rather than silently.
 */
function narrowDatabasePermissions(dbPath: string): void {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.chmodSync(file, DB_FILE_MODE);  // nosemgrep: detect-non-literal-fs-filename
    } catch {
      /* Not POSIX, or not created yet. Neither is worth failing a boot over. */
    }
  }
}

export async function initDatabase() {
  const dbPath = path.join(app.getPath("userData"), "praimana.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  /**
   * ── ⚠ `foreign_keys` IS DELIBERATELY LEFT OFF, AND THIS IS THE RECORD OF WHY ──────────────────
   *
   * A `db:addMessage` finding asked for `PRAGMA foreign_keys = ON`
   * beside this line, so the `REFERENCES chat_sessions(id)` declaration in the schema would be
   * enforced and a row could not be inserted against a session that does not exist.
   *
   * ⚠ THE AUTHORIZATION HALF WAS FIXED WITHOUT IT, and subsumes that case. `db:addMessage` now looks
   * the session up with `id = ? AND user_id IS ?` before inserting (session-ownership.ts), and a
   * non-existent session cannot match that lookup any more than a foreign one can. So the FK would add
   * nothing to the finding it was suggested for.
   *
   * ⚠ AND TURNING IT ON WOULD DELETE PEOPLE'S TRANSCRIPTS, which is why it is not a free hardening.
   * Both declarations carry `ON DELETE CASCADE`, and enforcement applies to statements rather than to
   * data already on disk, so flipping this changes what two existing deletes DO:
   *
   *   repair-project-roots.ts — runs `DELETE FROM projects WHERE path = ?` at BOOT, for a root an
   *     earlier build should never have accepted. With CASCADE that silently destroys every chat in
   *     that project, at startup, with no prompt. Its own comment promises the user "one honest
   *     re-pick your folder"; this would make it a data-loss event instead, and a security change that
   *     deletes transcripts on upgrade is a bad trade at any severity.
   *
   *   db:removeProject — "remove this project from the list" would become "and delete its chat
   *     history". Those turns include `pending` rows the sweep would otherwise still push, so the
   *     transcripts would be dropped locally AND never reach the team.
   *
   * Both of those are product decisions about what removing a project means, not consistency
   * hardening, and neither is this change's to make. Written down rather than silently skipped so the
   * next reader knows the pragma was considered, and what it costs.
   */
  narrowDatabasePermissions(dbPath);

  // Versioned schema migrations (EA-H5) — see migrations.ts.
  runMigrations(db);

  /**
   * ⚠ AFTER the migrations, because it reads the tables they guarantee, and BEFORE any handler is
   * registered, so no read of `allowedRoots()` can observe a root that an earlier build let the
   * renderer choose. See repair-project-roots.ts for why this is JS rather than a SQL migration.
   */
  repairProjectRoots(db);

  /**
   * ⚠ AFTER `repairProjectRoots`, same reasoning: the tables exist by now, and no handler is registered
   * yet, so nothing can read a credential in the window before it is re-sealed.
   */
  retireLegacyPlaintextCredentials();

  /**
   * ── ⚠ SAY SO AT BOOT, NOT AT THE MOMENT SOMEONE TRIES TO SIGN IN ──
   *
   * The report asked for a startup check, and the reason is diagnosis rather than protection: the
   * writers already refuse. Without this line the first symptom of a broken keychain is a sign-in
   * that fails for no visible reason, on one machine, which reads as "the app is broken" and gets
   * reported as such.
   *
   * ⚠ IT DOES NOT THROW. A user with no keychain can still open the app, read their existing
   * transcripts and sign out — everything except storing a NEW credential — and refusing to boot
   * would take all of that away to prevent nothing.
   *
   * Logged unconditionally when unavailable (not via debugLog): a packaged build with no keychain is
   * exactly the case where someone will be reading a log to find out why sign-in fails.
   */
  if (!isSecretStorageAvailable()) {
    console.warn(
      "[database] OS keychain unavailable — credentials CANNOT be stored encrypted, so sign-in will " +
        "be refused rather than write tokens in cleartext. On Linux this usually means no Secret " +
        "Service (gnome-keyring / kwallet) is running."
    );
  }
}
