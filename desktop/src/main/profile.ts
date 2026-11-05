// ── ⚠ MORE THAN ONE DESKTOP AT ONCE, EACH WITH ITS OWN USER AND TEAM ──────────────────────
//
// Today the answer is no, deliberately and for a good reason. `initDeepLinks()` takes
// `app.requestSingleInstanceLock()` and `index.ts` quits when it fails, with this note:
//
//     "⚠ SINGLE INSTANCE, and it must come first. Without the lock, clicking the link while the app is
//      running starts a SECOND process that opens the same SQLite file with its own connection — two
//      writers, one database, and the 'app' the user is looking at is not the one holding their session."
//
// ⚠ THAT REASONING IS CORRECT AND IS NOT WEAKENED HERE. The lock stays. What changes is WHAT IT IS A LOCK ON:
// the danger was never "two processes" — it was "two processes sharing one database". Give each instance its
// own `userData` directory and the hazard is gone at the root, because there is no shared file to race on.
//
// Chromium's process singleton is keyed on the user-data directory (this is how Chrome's `--user-data-dir`
// allows concurrent profiles), so calling `app.setPath("userData", …)` BEFORE `requestSingleInstanceLock()`
// gives each profile an independent lock. One instance per profile, still enforced; several profiles at once,
// now possible.
//
// ⚠ MEASURED, NOT ASSUMED — against real Electron 35.7.5, the version this app ships. A minimal probe that
// did nothing but `setPath` then `requestSingleInstanceLock`, run in concurrent pairs:
//
//     two DIFFERENT profiles   → gotLock=true  AND  gotLock=true    (concurrent instances work)
//     the SAME profile twice   → gotLock=true  AND  gotLock=false   (one DB, still one writer)
//     no profile, twice        → gotLock=true  AND  gotLock=false   (existing behaviour unchanged)
//
// The middle row is the one that matters most: it is the original hazard, and it is still prevented. The unit
// tests beside this file mock Electron and therefore CANNOT establish any of the above — they assert the
// name-sanitising and the call ordering, which is a different claim.
//
// ⚠ ORDERING IS THE WHOLE CORRECTNESS ARGUMENT. `applyProfile()` must run before ANYTHING reads `userData`:
// before the lock, before `initDatabase()` (`praimana.db`), before `setupTelemetry()` (the debug log).
// Called too late it would be worse than not existing — the lock and the database would disagree about which
// profile this process is, and one instance would hold the lock while writing another's data.
//
// ── ⚠ WHAT A PROFILE IS NOT: A SECURITY BOUNDARY ──
//
// Two profiles on one machine are two directories under the SAME OS user. They are for convenience — a
// facilitator demonstrating two teams, or one laptop shared between participants in a workshop — and they are
// explicitly NOT isolation:
//
//   • `safeStorage` encrypts auth tokens with the OS keychain of the LOGGED-IN USER, not of the profile. Any
//     profile can decrypt any other profile's tokens; the encryption stops another OS account and anyone
//     reading the file, which is what it was always for (H-1).
//   • The filesystem permissions are the OS user's, so one profile can read another's SQLite file directly.
//
// Anything needing a real boundary between two people needs two OS accounts. Recorded here because "separate
// profiles" invites the assumption of separation, and a facilitator putting two participants' credentials on
// one laptop should know which of the two they are getting.

import { app } from "electron";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

/** The flag participants and scripts use, e.g. `--profile=team-b`. */
const FLAG = "--profile=";

/** The environment variable equivalent, for launchers that cannot pass argv. */
const ENV_VAR = "PRAIMANA_PROFILE";

/**
 * ⚠ A CEILING ON THE NAME, because it becomes a directory component. Long paths fail differently on each
 * platform (Windows' MAX_PATH being the harshest), and a failure there would surface as a corrupt-looking
 * database rather than as "your profile name is too long".
 */
const MAX_NAME_LENGTH = 64;

/**
 * Reduce a requested profile name to something safe to use as ONE directory component.
 *
 * ⚠ THIS IS THE SECURITY-CRITICAL PART OF THE FILE, and it is an allowlist rather than an escape or a
 * blocklist. The value is joined onto a filesystem path, so a permissive rule is a path traversal:
 * `--profile=../../../../tmp/evil` would put the database — and the auth token in it — somewhere the
 * participant never chose, and `--profile=../Default` would let one profile masquerade as another.
 *
 * Only `[A-Za-z0-9._-]` survive. That admits `.` for readable names like `team.b`, so two further checks are
 * needed on top of the character filter: a name of only dots (`.`, `..`) is a relative path component even
 * though every character in it is allowed, and an empty result must not silently become the default profile.
 *
 * @returns the safe name, or null when nothing usable remains — in which case the caller leaves `userData`
 *          alone and the app behaves exactly as it did before profiles existed.
 */
export function sanitiseProfileName(raw: string | undefined | null): string | null {
  if (!raw) return null;

  const filtered = raw.trim().replace(/[^A-Za-z0-9._-]/g, "");
  if (!filtered) return null;

  /**
   * ⚠ REJECTED, NOT REPAIRED. `.` and `..` pass the character filter and are still relative path
   * components; `...` and longer runs are legal directory names on POSIX but are a clear sign of an attempt
   * rather than an intent, and refusing them costs nobody a usable name.
   */
  if (/^\.+$/.test(filtered)) return null;

  /**
   * ⚠ CASE-FOLDED, because macOS and Windows filesystems are case-INSENSITIVE while this comparison would
   * not be. `--profile=TeamB` and `--profile=teamb` would otherwise look like two profiles to the app and
   * resolve to one directory on disk — two instances, two locks, one database, which is precisely the
   * hazard the single-instance lock exists to prevent.
   */
  const name = filtered.slice(0, MAX_NAME_LENGTH).toLowerCase();

  /**
   * ── ⚠ THE RESERVED SENTINEL IS REFUSED HERE, SO EVERY CONSUMER INHERITS IT ─────────────────
   *
   * `createProfile` refused `default` with an explicit rationale — "profileDir would resolve it to the root,
   * meaning a 'new' profile would silently open the existing user's database" — and the LAUNCH path applied
   * no such rule. So `--profile=default` (or the environment variable) produced the exact outcome that
   * comment warns about, by the route that lacked the check:
   *
   *   - `applyProfile` pointed `userData` at `<root>/profiles/default` and the database and
   *     safeStorage-encrypted credentials were created there, while `profileDir("default")` still
   *     resolved to the ROOT — so one id named two directories, and `writeProfileMeta` stamped the
   *     root profile's `profile.json` from inside a profile.
   *   - `writeLastProfile("default")` then read back as the sentinel, so the NEXT ordinary launch went
   *     to the root install: the profile just signed into became unreachable without re-passing the
   *     flag, and its chats and encrypted tokens were orphaned with no error.
   *   - `listProfiles()` showed two entries with `id: "default"`, and picking either opened the root —
   *     so a participant choosing what looked like their own profile landed in whichever account the
   *     root install was signed in as.
   *
   * ⚠ ONE PLACE RATHER THAN THREE. `requestedProfile`, `readLastProfile` and `listProfiles` all run
   * their input through here, so refusing it in the sanitiser closes every entry at once — which is
   * why this is the fix and adding a second check next to `createProfile`'s was not. The explicit
   * `id === DEFAULT_PROFILE_ID` handling in `readLastProfile` and `relaunchInto` stays: there the
   * sentinel legitimately MEANS "the root install", and it is compared before this is called.
   */
  if (name === DEFAULT_PROFILE_ID) return null;

  return name;
}

/**
 * The profile this process was asked to run as, or null for the default.
 *
 * argv wins over the environment: a launcher may export the variable for a whole session, and an explicit
 * flag on one invocation is the more specific instruction.
 *
 * @param argv Injected in tests. Production reads `process.argv`.
 * @param env  Injected in tests. Production reads `process.env`.
 */
export function requestedProfile(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  /**
   * ⚠ THE WHOLE ARGV IS SCANNED, NOT `argv[1]`. In development the app runs as `electron . --profile=x` and
   * in a packaged build as `App --profile=x`, so the flag's index differs — and a deep-link launch appends a
   * URL, moving it again.
   */
  for (const arg of argv) {
    if (arg.startsWith(FLAG)) {
      const name = sanitiseProfileName(arg.slice(FLAG.length));
      if (name) return name;
    }
  }
  return sanitiseProfileName(env[ENV_VAR]);
}

/**
 * Point this process at its profile's own data directory.
 *
 * ⚠ MUST BE CALLED BEFORE THE SINGLE-INSTANCE LOCK AND BEFORE `initDatabase()`. See the ordering note at the
 * top of this file — late is worse than never.
 *
 * ⚠ AND IT IS A NO-OP WITHOUT A PROFILE, which is what keeps every existing install untouched. No flag means
 * the same `userData` path, the same database, the same one-instance behaviour as before. Nobody's data
 * moves, and there is no migration.
 *
 * @returns the profile applied, or null when running as the default.
 */
export function applyProfile(
  profile: string | null = requestedProfile()
): string | null {
  if (!profile) return null;

  /**
   * ⚠ THE SENTINEL IS "NO REDIRECT", MATCHING `profileDir`. `sanitiseProfileName` already refuses
   * `default`, so nothing reaches here with it through the launch path — but this function is exported
   * and the two directory resolvers disagreeing about ONE id is what made that finding possible at
   * all (a database opened under `profiles/default` while `profileDir` resolved to the root). Two
   * independent guarantees, and this is the one that holds if the first is ever loosened.
   */
  if (profile === DEFAULT_PROFILE_ID) return null;

  /**
   * Nested under the DEFAULT `userData` rather than beside it, so everything the app owns stays inside the
   * one directory the OS gave it — uninstalling still removes it all, and a profile cannot be mistaken for
   * another application's data.
   *
   * `path.join` on a name already reduced to `[A-Za-z0-9._-]` cannot escape this directory.
   */
  const root = rootDir();
  app.setPath("userData", path.join(root, "profiles", profile));  // nosemgrep: path-join-resolve-traversal
  return profile;
}

/**
 * ── ⚠ THE ROOT `userData`, CAPTURED BEFORE IT IS REDIRECTED ────────────────────────────────
 *
 * `applyProfile` REPLACES what `app.getPath("userData")` returns, so after it has run there is no way to ask
 * Electron where the root was — and the root is where the profile list and the last-profile pointer live. A
 * later reader that called `getPath("userData")` would look for `profiles/` INSIDE a profile.
 *
 * Captured lazily on first use, which is safe because `applyProfile` itself is the first caller and
 * `index.ts` calls it before anything else. Recorded rather than left implicit because the ordering is the
 * whole correctness argument.
 *
 * ── ⚠ THE RENAME MOVED THIS DIRECTORY, DELIBERATELY AND WITHOUT A MIGRATION ────────────────
 *
 * Electron derives `userData` from the app name, so renaming the product to Praimana moved the root from
 * `<appData>/<the previous product name>` to `<appData>/Praimana`. Note what does NOT rescue it:
 * `app.setName("Praimana")` in `index.ts` runs inside `whenReady`, long after this capture happens at module
 * load — the name in `package.json` is what decides the path, and that is why the move is invisible in the
 * diff that caused it. The old name is recoverable from git history if a migration ever needs it.
 *
 * ⚠ SO EVERY INSTALL THAT PREDATES THE RENAME KEEPS ITS PROFILES, DATABASES AND POINTER UNDER THE OLD PATH,
 * AND THIS BUILD WILL NOT FIND THEM. That is an accepted loss, not an oversight: the decision was a clean
 * break over a migration, taken while the install base was small enough to absorb it. The old directory is
 * left in place rather than deleted — it is the only copy of that data, and a rename is not a licence to
 * remove it.
 *
 * If an upgrade path is ever needed, it belongs HERE, before the first capture: move the old root across
 * only when the new one does not yet exist, so a user who has already started fresh is never overwritten.
 */
let capturedRoot: string | null = null;

export function rootDir(): string {
  if (capturedRoot === null) capturedRoot = app.getPath("userData");
  return capturedRoot;
}

/** Where per-profile directories live. */
export function profilesDir(): string {
  return path.join(rootDir(), "profiles");
}

/**
 * ── ⚠ THE EXISTING INSTALL IS A PROFILE TOO, AND IT HAS NO DIRECTORY ──────────────────────
 *
 * Every install that predates profiles keeps its database in the ROOT `userData`, not under `profiles/`. It
 * is therefore a real, selectable profile with data in it — but it is NOT a directory in the list, and
 * launching it means passing NO `--profile` flag at all.
 *
 * ⚠ THIS SENTINEL IS WHY UPGRADING DOES NOT ORPHAN ANYONE. Without it the chooser would list only
 * `profiles/*`, an existing user would launch into an empty database, and would reasonably conclude their
 * chats and sign-in had been deleted. It is a reserved id, not a name anybody can create — `sanitiseProfileName`
 * would happily produce "default", so `createProfile` refuses it.
 */
export const DEFAULT_PROFILE_ID = "default";

/** Display and ordering data for one profile, as the chooser needs it. */
export interface ProfileSummary {
  /** `DEFAULT_PROFILE_ID` for the root install, otherwise the directory name. */
  id: string;
  /** What to show. Falls back to the id when the profile has never been signed into. */
  label: string;
  /** The team this profile last worked in, when known. */
  team?: string;
  /** ISO timestamp of the last launch, for ordering. */
  lastUsedAt?: string;
  /**
   * The identity this profile belongs to, so the chooser can say which of your accounts it is.
   *
   * ⚠ THE POINT OF PUTTING IT IN THE SIDECAR. It lived in the per-profile DATABASE first, which the chooser
   * cannot read — "the chooser touches no database" is the invariant this file's header exists to serve — so
   * the list could name a profile's team and not the address that works in it, which is the one thing that
   * distinguishes two profiles of the same deployment.
   */
  identityEmail?: string;
}

/**
 * ── ⚠ WHY A SIDECAR FILE RATHER THAN READING EACH PROFILE'S DATABASE ──────────────────────
 *
 * The chooser has to render "Xavier — Team Alpha" for five profiles before any of them is open. Reading that
 * from SQLite would mean opening five databases from a process that has deliberately opened none — each with
 * its own migrations, its own lock, and its own encrypted settings. That is a great deal of machinery to draw
 * a list, and it would defeat the invariant that no database is touched until a profile is chosen.
 *
 * ⚠ DISPLAY STRINGS ONLY. No tokens, nothing `safeStorage` is protecting — this file is plaintext by design,
 * because the process that reads it has no business decrypting anything.
 *
 * ── ⚠ AND ONE FIELD THAT IS NO LONGER PURELY COSMETIC ──────────────────────────────────────────
 *
 * `identityEmail` is read by `isForeignToProfile` (accounts.ts) to refuse a SECOND identity signing into a
 * profile that already has one. So this file is now an input to a decision, not only to a label, and two
 * things follow that the rest of this module's "a cosmetic label is not worth failing for" posture does not
 * imply on its own:
 *
 *   - IT IS STILL NOT A SECURITY BOUNDARY. profile.ts and index.ts both record that a profile is "not a
 *     security boundary between two people on one machine", and anything running as this user can edit this
 *     file. What it prevents is an ACCIDENT — the wrong identity added to a workspace that already has one.
 *   - IT FAILS OPEN, deliberately. `writeProfileMeta` swallows write errors and `readMeta` returns `{}` for
 *     an unreadable file, so a disk problem means "no binding" and sign-in proceeds. The alternative locks
 *     somebody out of their own workspace because a JSON file could not be parsed.
 *
 * ⚠ AN EMAIL IS THE SAME CLASS OF STRING AS `team`, which has always been here — this is the deployment's
 * own tenant name beside the address that works in it, and the model is that one person uses this
 * machine with different email addresses for different experiences or teams. It is what makes the chooser able
 * to say WHICH of your accounts a profile is, which is the question that list exists to answer.
 */
interface ProfileMeta {
  label?: string;
  team?: string;
  lastUsedAt?: string;
  /** Lower-cased. The identity this profile belongs to — see the note above. */
  identityEmail?: string;
}

const META_FILE = "profile.json";
const POINTER_FILE = "last-profile.json";

/**
 * Owner-only, matching the database and the two logs. The directory mode is the one that bounds the
 * SQLite store sitting inside it as well — see `writeProfileMeta`.
 */
const PROFILE_META_MODE = 0o600;
const PROFILE_DIR_MODE = 0o700;

/** The directory for a profile id, or the root for the default sentinel. */
export function profileDir(id: string): string {
  return id === DEFAULT_PROFILE_ID ? rootDir() : path.join(profilesDir(), id);  // nosemgrep: path-join-resolve-traversal
}

function readMeta(id: string): ProfileMeta {
  try {
    const raw = fs.readFileSync(path.join(profileDir(id), META_FILE), "utf8");  // nosemgrep: detect-non-literal-fs-filename,path-join-resolve-traversal
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ProfileMeta) : {};
  } catch {
    /* Absent or unreadable: a profile nobody has signed into yet. Not an error. */
    return {};
  }
}

/**
 * Record what a profile should be called, so the chooser can name it after its person rather than its
 * directory. Called once the app knows who is signed in.
 *
 * Never throws: failing to write a display label must not fail a sign-in.
 *
 * ── ⚠ 0600, AND THE DIRECTORY 0700 ────────────────────────────────────────────────────────────
 *
 * The contents are not a cosmetic label alone. `ProfileMeta` carries `label` and `team`, and the label is set
 * from the signed-in person's name or email, so this file answers "who uses this machine, and which team are
 * they on" to any other local account.
 *
 * ⚠ THE DIRECTORY MODE IS THE ONE THAT ACTUALLY BOUNDS THE PROBLEM, because the profile directory is
 * what the SQLite store for that profile sits in. 0700 means a reader who is not this OS user cannot
 * traverse it whatever the modes inside say — the containing directory is exactly the mitigation the
 * finding could not verify, since it depends on the install. Setting it here means it does not depend
 * on the install.
 *
 * ⚠ `mkdirSync` MODE APPLIES ONLY ON CREATE, hence the chmod as well — the same upgrade path the
 * database and the two logs need, for a directory an earlier build made at 0755.
 *
 * ⚠ AND EVERY PART STAYS BEST-EFFORT. Windows has no POSIX mode, and the whole function already refuses
 * to let a display label fail a sign-in; narrowing permissions must not become the thing that does.
 */
export function writeProfileMeta(id: string, meta: ProfileMeta): void {
  try {
    const dir = profileDir(id);
    fs.mkdirSync(dir, { recursive: true, mode: PROFILE_DIR_MODE });  // nosemgrep: detect-non-literal-fs-filename
    try {
      fs.chmodSync(dir, PROFILE_DIR_MODE);  // nosemgrep: detect-non-literal-fs-filename
    } catch {
      /* Not POSIX. */
    }
    const merged = { ...readMeta(id), ...meta };
    const file = path.join(dir, META_FILE);  // nosemgrep: path-join-resolve-traversal
    fs.writeFileSync(file, JSON.stringify(merged, null, 2), { mode: PROFILE_META_MODE });  // nosemgrep: detect-non-literal-fs-filename
    try {
      fs.chmodSync(file, PROFILE_META_MODE);  // nosemgrep: detect-non-literal-fs-filename
    } catch {
      /* Not POSIX. */
    }
  } catch {
    /* A cosmetic label is not worth surfacing a failure for. */
  }
}

/**
 * ── ⚠ THE ACTIVE PROFILE'S OWN SIDECAR, ADDRESSED WITHOUT ITS ID ──────────────────────────────
 *
 * `applyProfile` redirects `userData` at startup, so the running process's `userData` IS the active
 * profile's directory — for the default sentinel too, where it is the root. Reading and writing there means
 * `accounts.ts` does not have to be told which profile it is in, and cannot be told wrongly.
 *
 * ⚠ NOT `profileDir(activeProfile)`: that id lives in index.ts's module state and threading it through every
 * caller is one more thing to get out of step with the directory actually in use.
 */
function activeMetaFile(): string {
  return path.join(app.getPath("userData"), META_FILE);
}

/** The active profile's recorded identity, lower-cased, or null when it has none. */
export function readActiveProfileIdentity(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(activeMetaFile(), "utf8")) as ProfileMeta;
    const email = typeof parsed?.identityEmail === "string" ? parsed.identityEmail.trim() : "";
    return email ? email.toLowerCase() : null;
  } catch {
    /* Absent, unreadable, or not JSON: no binding. Fails open — see the note on `ProfileMeta`. */
    return null;
  }
}

/**
 * Record the identity this profile belongs to. FIRST WRITER WINS.
 *
 * ⚠ A PROFILE BELONGS TO WHOEVER ESTABLISHED IT, not to the most recent visitor — re-binding on every
 * sign-in would make the record follow whoever last got in and guard nothing.
 */
export function writeActiveProfileIdentity(email: string): void {
  const clean = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!clean) return;
  if (readActiveProfileIdentity()) return;
  writeActiveProfileMeta({ identityEmail: clean });
}

/** Forget it, because this profile is being repointed at a different experience. */
export function clearActiveProfileIdentity(): void {
  writeActiveProfileMeta({ identityEmail: "" });
}

/**
 * Merge into the ACTIVE profile's sidecar. Same never-throw contract as `writeProfileMeta`, and the same
 * 0600/0700 modes, because it is the same file.
 */
function writeActiveProfileMeta(meta: ProfileMeta): void {
  try {
    const dir = app.getPath("userData");
    fs.mkdirSync(dir, { recursive: true, mode: PROFILE_DIR_MODE });
    let existing: ProfileMeta = {};
    try {
      existing = JSON.parse(fs.readFileSync(activeMetaFile(), "utf8")) as ProfileMeta;
    } catch {
      /* Nothing there yet. */
    }
    const merged = { ...existing, ...meta };
    // An empty string is how `clearActiveProfileIdentity` says "no binding"; do not persist the key at all.
    if (!merged.identityEmail) delete merged.identityEmail;
    fs.writeFileSync(activeMetaFile(), JSON.stringify(merged, null, 2), { mode: PROFILE_META_MODE });
    try {
      fs.chmodSync(activeMetaFile(), PROFILE_META_MODE);
    } catch {
      /* Not POSIX. */
    }
  } catch {
    /* Fails open, as the note on `ProfileMeta` explains. */
  }
}

/**
 * Every profile that exists, newest-used first.
 *
 * ⚠ THE DEFAULT ENTRY IS INCLUDED ONLY IF IT HAS DATA. A fresh install has no root database, and listing an
 * empty "Default" there would offer a profile that is indistinguishable from a new one while being the single
 * directory a future uninstall is least likely to remove. On an upgraded install it has the user's entire
 * history and must be first-class. `praimana.db` is the test because it is what `initDatabase` creates.
 */
export function listProfiles(): ProfileSummary[] {
  const summaries: ProfileSummary[] = [];

  if (fs.existsSync(path.join(rootDir(), "praimana.db"))) {
    const meta = readMeta(DEFAULT_PROFILE_ID);
    summaries.push({
      id: DEFAULT_PROFILE_ID,
      label: meta.label || "Default",
      ...(meta.team ? { team: meta.team } : {}),
      ...(meta.identityEmail ? { identityEmail: meta.identityEmail } : {}),
      ...(meta.lastUsedAt ? { lastUsedAt: meta.lastUsedAt } : {}),
    });
  }

  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(profilesDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    /* No profiles directory yet. */
  }

  for (const id of entries) {
    /* Re-sanitised on the way OUT as well as in: a directory created by hand must not become a launch arg. */
    if (sanitiseProfileName(id) !== id) continue;
    const meta = readMeta(id);
    summaries.push({
      id,
      label: meta.label || id,
      ...(meta.team ? { team: meta.team } : {}),
      ...(meta.identityEmail ? { identityEmail: meta.identityEmail } : {}),
      ...(meta.lastUsedAt ? { lastUsedAt: meta.lastUsedAt } : {}),
    });
  }

  /* Most recently used first; never-used ones after, alphabetically, so the order is stable. */
  return summaries.sort((a, b) => {
    if (a.lastUsedAt && b.lastUsedAt) return b.lastUsedAt.localeCompare(a.lastUsedAt);
    if (a.lastUsedAt) return -1;
    if (b.lastUsedAt) return 1;
    return a.label.localeCompare(b.label);
  });
}

/** Whether a profile id names something that exists and can be launched. */
export function profileExists(id: string): boolean {
  if (id === DEFAULT_PROFILE_ID) {
    return fs.existsSync(path.join(rootDir(), "praimana.db"));
  }
  try {
    return fs.statSync(path.join(profilesDir(), id)).isDirectory();  // nosemgrep: detect-non-literal-fs-filename,path-join-resolve-traversal
  } catch {
    return false;
  }
}

/**
 * Create a profile's directory and label it.
 *
 * @returns the sanitised id, or null when the name is unusable or already taken.
 */
export function createProfile(rawName: string): string | null {
  const id = sanitiseProfileName(rawName);
  /**
   * ⚠ `default` IS RESERVED. It is the sentinel for the root install, so a directory of that name would
   * create two different things answering to one id — and `profileDir` would resolve it to the root, meaning
   * a "new" profile would silently open the existing user's database.
   */
  if (!id || id === DEFAULT_PROFILE_ID) return null;
  if (profileExists(id)) return null;

  try {
    fs.mkdirSync(path.join(profilesDir(), id), { recursive: true });  // nosemgrep: detect-non-literal-fs-filename,path-join-resolve-traversal
  } catch {
    return null;
  }
  /* The raw name is kept as the LABEL, so "Team Alpha" survives being folded to `teamalpha` on disk. */
  writeProfileMeta(id, { label: rawName.trim() || id });
  return id;
}

/**
 * ── ⚠ THE LAST-PROFILE POINTER LIVES AT THE ROOT, NOT IN A PROFILE ────────────────────────
 *
 * "Which profile did I use last?" is a question about the MACHINE, not about a profile, so it cannot live in
 * a profile's own settings — the process that needs the answer has not chosen a profile yet and therefore
 * cannot open any profile's database. A small root-level file is the only thing readable at that moment.
 */
export function readLastProfile(): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(rootDir(), POINTER_FILE), "utf8"));
    const id = raw?.profile;
    if (typeof id !== "string") return null;
    /* Sanitised on read: this file is on disk and a hand-edit must not become a path or a launch arg. */
    return id === DEFAULT_PROFILE_ID ? id : sanitiseProfileName(id);
  } catch {
    return null;
  }
}

/** Remember the profile now in use. Never throws: this is a convenience, not a correctness requirement. */
export function writeLastProfile(id: string): void {
  try {
    fs.writeFileSync(
      path.join(rootDir(), POINTER_FILE),
      JSON.stringify({ profile: id }, null, 2)
    );
  } catch {
    /* Next launch shows the chooser instead. Not worth failing a startup over. */
  }
}


/**
 * ── ⚠ WHICH PROFILE THIS LAUNCH IS FOR, AND WHETHER TO ASK ────────────────────────────────
 *
 * Four inputs, four outcomes, and the ORDER of the rules is the design:
 *
 *   1. An explicit `--profile` always wins. It is how `File → New Window with Profile` works, and a launcher
 *      that states a profile must never be second-guessed by a remembered one.
 *   2. The remembered profile, if it still exists. This is what "remember last profile" buys: a facilitator
 *      opening the app mid-workshop goes straight where they were, with no click.
 *   3. An UPGRADED INSTALL goes straight in as the default. ⚠ THIS RULE EXISTS SO NOBODY IS ORPHANED. An
 *      existing user has their database in the root `userData` and no pointer file; confronting them with a
 *      "create a profile" screen would launch them into an empty database and read as data loss. They are
 *      already in a profile — it just has no directory.
 *   4. Otherwise ask. On a genuinely fresh install there is nothing to remember and nothing to lose, and the
 *      request is explicit that creating one is required to proceed.
 *
 * ⚠ A REMEMBERED PROFILE THAT NO LONGER EXISTS FALLS THROUGH rather than failing. A deleted directory would
 * otherwise launch a profile whose data is gone, silently creating it afresh — the chooser is the honest
 * answer to "the thing you used last is not there any more".
 *
 * Pure, and injected in tests: this is the decision that can actually be WRONG, and reaching it otherwise
 * needs a real Electron app, a filesystem and a relaunch.
 */
export interface LaunchDecision {
  /** The profile to apply, or null to run as the root/default install. */
  profile: string | null;
  /** Show the chooser instead of the app, and open no database. */
  showChooser: boolean;
  /** Whether the chooser must refuse to proceed without creating a profile. */
  mustCreate: boolean;
}

export function decideLaunch(input: {
  /** From `--profile` or the environment. */
  explicit: string | null;
  /** From the root pointer file. */
  remembered: string | null;
  /** Ids that exist right now, including `default` when the root install has data. */
  existing: readonly string[];
}): LaunchDecision {
  const exists = (id: string) => input.existing.includes(id);

  /* 1. Explicit wins, even if it does not exist yet — `New Profile…` creates the directory then launches. */
  if (input.explicit) {
    return { profile: input.explicit, showChooser: false, mustCreate: false };
  }

  /* 2. The remembered one, only if it is still there. */
  if (input.remembered && exists(input.remembered)) {  // nosemgrep: detect-non-literal-fs-filename
    return {
      profile: input.remembered === DEFAULT_PROFILE_ID ? null : input.remembered,
      showChooser: false,
      mustCreate: false,
    };
  }

  /**
   * 3. An upgraded install: root data exists, nothing was ever remembered, and no profiles have been made.
   *
   * ⚠ NARROW ON PURPOSE. Once the user HAS other profiles, an unremembered launch is ambiguous and asking is
   * right; it is only the never-seen-profiles case that must bypass the chooser, because that user has not
   * opted into the feature at all.
   */
  if (!input.remembered && exists(DEFAULT_PROFILE_ID) && input.existing.length === 1) {
    return { profile: null, showChooser: false, mustCreate: false };
  }

  /* 4. Ask. With nothing to choose from, creating one is the only way forward. */
  return {
    profile: null,
    showChooser: true,
    mustCreate: input.existing.length === 0,
  };
}

/** The production wrapper: read the filesystem, then decide. */
export function resolveLaunch(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): LaunchDecision {
  return decideLaunch({
    explicit: requestedProfile(argv, env),
    remembered: readLastProfile(),
    existing: listProfiles().map((p) => p.id),
  });
}

/**
 * ── ⚠ TWO WAYS TO OPEN A PROFILE, AND THEY ARE NOT INTERCHANGEABLE ────────────────────────
 *
 * `userData` is fixed once the database is open, so "switching profile" is always a new PROCESS. Which
 * mechanism depends on whether this window is going away:
 *
 *   relaunchInto — REPLACES this process. `app.relaunch` queues the new instance and it starts only after
 *                  this one exits, which is what releases the single-instance lock in time. Used by the
 *                  chooser and by `Switch Profile`.
 *
 *   openProfileWindow — a SECOND, concurrent instance, for `New Window with Profile`.
 *
 * ⚠ GETTING THIS BACKWARDS IS A REAL BUG, NOT A STYLE CHOICE. If the chooser SPAWNED the profile it already
 * holds the lock for, the child would fail the lock and quit, this process would receive `second-instance`
 * and merely focus itself — the picker would appear to do nothing at all.
 */
/**
 * Move this window to another profile.
 *
 * @returns `true` when this process is being REPLACED (packaged), `false` when a second instance was
 *          spawned alongside it (development — see below). The caller needs the difference: a UI that
 *          assumes replacement leaves its chooser on screen forever when the process survives, which is
 *          exactly the bug where a new window opened and the old window with profile options stayed
 *          there.
 */
export function relaunchInto(id: string): boolean {
  /**
   * ⚠ RE-SANITISED HERE AS WELL AS AT THE IPC BOUNDARY. This function writes the machine-level pointer
   * file and then exits the process, so the value it is handed outlives every window — and a pointer
   * file is read by a process that has no database and no way to ask anybody what it should contain.
   * `profile:open` validates (see index.ts), and this is the guarantee that holds if a future caller
   * does not. The sentinel is compared FIRST because it legitimately means "the root install", which
   * the sanitiser refuses by design.
   */
  const safe = id === DEFAULT_PROFILE_ID ? DEFAULT_PROFILE_ID : sanitiseProfileName(id);
  if (!safe) {
    console.warn("[profile] refusing to relaunch into an unusable profile id");
    return false;
  }
  id = safe;

  writeLastProfile(id);

  /**
   * ── ⚠ IN DEVELOPMENT THIS MUST NOT EXIT ───────────────────────────────────────────────────
   *
   * Both halves, from one line. `app.exit(0)` below ends the process that `vite-plugin-electron` spawned,
   * and the plugin wires that exit straight to its own:
   *
   *     process.electronApp.on("exit", process.exit)     // vite-plugin-electron/dist/base-*.mjs:90
   *
   * So vite dies with it — "the desktop server stopped". The relaunched instance then inherits
   * `NODE_ENV=development`, takes the dev branch, and calls `loadURL("http://localhost:5173")` against a
   * server that no longer exists — "a new blank window opened". Nothing was wrong with the profile or the
   * sign-out; the relaunch simply cannot work while the dev server is a child of the process being
   * replaced.
   *
   * ⚠ SO DEV SPAWNS INSTEAD OF REPLACING, and the divergence is deliberate. The new instance is detached
   * with its own `--profile`, gets its own `userData`, and loads the dev server successfully BECAUSE this
   * process is still alive to keep vite serving. The cost is that the old window stays open — a second
   * window rather than a switched one. That is a visible difference, and it is strictly better than a
   * dead dev server plus a blank window.
   *
   * A packaged build has no such coupling: the executable is the app, nothing else depends on the
   * process, and `relaunch` + `exit` is the correct, seamless behaviour. `app.isPackaged` is the right
   * test here and not `NODE_ENV` — it is the packaging fact, and no environment variable can flip it.
   */
  if (!app.isPackaged) {
    console.warn(
      `[profile] dev build: opening "${id}" in a NEW window instead of replacing this one. ` +
        `Relaunching would exit the process vite-plugin-electron owns, which stops the dev server and ` +
        `leaves the new window with nothing to load. Close this window when you are done with it.`
    );
    openProfileWindow(id);
    return false;
  }

  /* The default install takes NO flag — that is what makes it the root userData. */
  const args = id === DEFAULT_PROFILE_ID ? [] : [`${FLAG}${id}`];
  app.relaunch({ args: [...relaunchBaseArgs(), ...args] });
  app.exit(0);
  return true;
}

/**
 * Open a profile in a concurrent instance.
 *
 * ⚠ DETACHED AND `unref`ed, so the child outlives this process. Without both, quitting the window that
 * launched it would take the new one with it.
 */
export function openProfileWindow(id: string): void {
  /* Re-sanitised for the same reason as `relaunchInto` — this value becomes an argv element. */
  const safe = id === DEFAULT_PROFILE_ID ? DEFAULT_PROFILE_ID : sanitiseProfileName(id);
  if (!safe) {
    console.warn("[profile] refusing to open a window for an unusable profile id");
    return;
  }
  const args = safe === DEFAULT_PROFILE_ID ? [] : [`${FLAG}${safe}`];
  const child = spawn(process.execPath, [...relaunchBaseArgs(), ...args], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * The arguments needed to start THIS app again, before any profile flag.
 *
 * ⚠ DEV AND PACKAGED DIFFER, and the same distinction is already made in `deep-link.ts` when registering the
 * URL scheme. In development the executable is Electron itself and it needs the app directory as its first
 * argument; in a packaged build the app IS the executable and passing a path would be wrong.
 */
function relaunchBaseArgs(): string[] {
  return process.defaultApp && process.argv.length >= 2 ? [path.resolve(process.argv[1])] : [];
}
