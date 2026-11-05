import path, { dirname } from "path";
import os from "os";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "fs";
import { getDb, readSetting } from "./database";
import { activeUserId, activeExperience } from "./active-account";

/**
 * The settings `allowedRoots()` derives the boundary from.
 *
 * ── ⚠ NONE OF THESE MAY EVER BE RENDERER-WRITABLE ──
 *
 * `project_path` used to be on `RENDERER_WRITABLE_SETTINGS`, which inverted this whole
 * module: the confinement boundary was built from a value the confined party could set.
 * `setSetting("project_path", os.homedir())` put `~/.ssh`, `~/.aws` and
 * `~/Library/LaunchAgents` "inside the project" for every handler that calls the asserts
 * below — read, write, trash, move, git, and the agent spawn cwd.
 *
 * The fix is NOT to make `allowedRoots()` read less. It reads persisted state on purpose:
 * the setting and the `projects` rows are what survive a restart, and an in-memory-only
 * boundary would deny every path until the user re-picked their folder. The fix is that
 * everything feeding it is main-authoritative on WRITE — see `recordUserChosenPath` — so
 * persisted state is trustworthy by construction: every value in it was once a native
 * picker result.
 *
 * setting-access.ts enforces the "not renderer-writable" half at module load, so a future
 * edit that re-adds the key stops the app instead of quietly reopening the hole.
 */
export const ALLOWLIST_SOURCE_SETTINGS: ReadonlySet<string> = new Set(["project_path"]);

/**
 * Absolute paths the user chose in a NATIVE DIALOG during this session.
 *
 * In-memory by design. This is provenance for a WRITE, not a persisted grant: it answers
 * "did a human pick this in an OS dialog?" at the moment the renderer asks to record a
 * project, and nothing more. It is empty after a restart, which is correct and harmless —
 * the already-persisted `project_path` and `projects` rows keep working, because they were
 * gated when they were written, and no boot path re-writes them.
 */
const userChosenPaths = new Set<string>();

/**
 * ── ⚠ WHAT MAY BE A PROJECT ROOT — A CONTAINMENT TEST, NOT A DENYLIST ─────────────────────
 *
 * PROVENANCE ALONE IS NOT ENOUGH. The native dialog will happily return the home directory if
 * someone selects it, and "choose your projects folder" → Home is both a plausible mis-click
 * and a plausible social-engineering step. It hands back exactly the `~/.ssh` + `~/.aws` reach
 * the boundary exists to deny, with genuine user consent behind it, so no later check can tell
 * it apart.
 *
 * ⚠ THE FIRST VERSION WAS AN EXACT-MATCH DENYLIST, AND IT LEAKED. Measured on macOS:
 *
 *   /Users/<me>                            REFUSED   (listed)
 *   /System/Volumes/Data/Users/<me>         ALLOWED   ← the same directory, via firmlink;
 *                                                       realpathSync does NOT collapse it
 *   /Users/<me>/Library/LaunchAgents        ALLOWED   ← named three times in these comments as
 *                                                       the thing being prevented
 *   /private/etc, /private/var              ALLOWED   ← what a picker actually returns for /etc
 *   ~/.gnupg, ~/.kube, ~/.docker, ~/.config ALLOWED   ← credential-bearing, simply not listed
 *
 * A denylist can only reject what someone remembered to type. So the question is inverted: a
 * candidate is refused if it CONTAINS anything sensitive, or if it sits inside an area that is
 * never a project. That covers every row above and the ones nobody thought of.
 *
 * ⚠ `/var` IS DELIBERATELY NOT AN EXCLUDED AREA. `os.tmpdir()` resolves under `/private/var`, and
 * a temp directory is a legitimate project root — the test suite uses them. Excluding the area
 * would refuse real work; the ancestor rule below already refuses `/var` itself, because it
 * contains the home directory's sensitive children on no sane system but IS caught as an
 * ancestor of nothing — so it is listed exactly, alongside the volume roots.
 */
const HOME = path.resolve(os.homedir());

/**
 * Directories whose CONTENTS must never fall inside a project root. A candidate at or ABOVE any of
 * these is refused, which is what makes `/`, `/Users`, `$HOME` and every firmlink spelling of them
 * fail without being enumerated.
 */
const SENSITIVE_CONTENTS: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".config",
  ".gitconfig",
  "Library",
  /**
   * ⚠ THE WINDOWS COUNTERPART OF `Library`, and it was missing. `~/AppData` holds every application's
   * state including this app's own database, and the excluded-areas list reached it only through
   * `%APPDATA%`/`%LOCALAPPDATA%` — environment variables that can simply be unset. Naming it here means
   * it is derived from the OS's own profile directory instead, and the containment rules below cover
   * both `Roaming` and `Local` without enumerating them.
   *
   * Inert on macOS and Linux, where no such directory exists.
   */
  "AppData",
].map((d) => path.join(HOME, d));  // nosemgrep: path-join-resolve-traversal

/**
 * Areas that are never a project, at any depth. A candidate at or INSIDE any of these is refused —
 * `~/Library/LaunchAgents` and `~/Library/Application Support` are the ones that matter, and the
 * system areas are here so a picker pointed at `/usr/local/src` is refused too.
 */
const EXCLUDED_AREAS: readonly string[] = [
  "/etc",
  "/private/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/opt",
  "/System",
  "/Library",
  "/Applications",
  path.join(HOME, "Library"),
  /**
   * ── ⚠ WINDOWS AREAS, WHICH THIS LIST HAD NONE OF ──────────────────────────────────────────
   *
   * Every entry above is a POSIX path, so on Windows the excluded-areas test excluded NOTHING: a
   * picker aimed at `C:\\Windows\\System32` or `C:\\Program Files` was accepted as a project root, and
   * from that moment every file, git and spawn handler in the app treated those trees as "inside the
   * project".
   *
   * ⚠ READ FROM THE ENVIRONMENT, NOT HARDCODED TO `C:`. Windows can boot from another letter and
   * these variables are how you learn which — a literal "C:\\Windows" would protect the wrong volume
   * on such a machine and, worse, look correct while doing it. The literals are only FALLBACKS for a
   * variable that is somehow unset.
   *
   * ⚠ KEPT ON EVERY PLATFORM rather than added under an `if`. A path beginning `C:\\` cannot match
   * anything on macOS or Linux, so the entries are inert there — and an inert entry is cheaper than a
   * platform branch that someone later has to remember exists. The values are computed at module load
   * exactly like `HOME` above.
   */
  ...windowsExcludedAreas(),
];

/**
 * The Windows trees that are never a project, resolved from the environment.
 *
 * `%SystemRoot%` is Windows itself; the two `Program Files` variables cover 64- and 32-bit installs;
 * `%ProgramData%` holds machine-wide application state, which is the Windows analogue of the
 * `~/Library` entry above.
 */
function windowsExcludedAreas(): string[] {
  const env = process.env;

  /**
   * ── ⚠ THE ENVIRONMENT VALUE **AND** THE LITERAL, NEVER ONE OR THE OTHER ──────────────────────
   *
   * I had only considered unsetting. Setting it is worse:
   *
   *     SystemRoot=C:\\Temp\\decoy   →   the excluded area becomes C:\\Temp\\decoy
   *                                →   C:\\Windows\\System32 matches nothing in any list
   *                                →   isForbiddenProjectRoot() returns FALSE
   *
   * — the precise regression the commit that added these was written to fix. `APPDATA` and
   * `LOCALAPPDATA` were worse still: no literal at all, so UNSETTING one was enough to make
   * `%APPDATA%\\…\\Start Menu\\Programs\\Startup` an acceptable project root, which is user-level
   * persistence granted by an environment variable.
   *
   * ⚠ SO A UNION: an attacker who edits the environment can ADD a protected area, which is harmless,
   * and can no longer REMOVE one. An attacker-editable input is not a sound basis for a boundary, and
   * "env control is already game over" is not true here — a user-level `HKCU\\Environment` write or a
   * poisoned shortcut is a real position short of code execution, and this was a step up from it.
   */
  const both = (value: string | undefined, literal: string): string[] =>
    value && value !== literal ? [value, literal] : [literal];

  const areas = [
    ...both(env.SystemRoot, "C:\\Windows"),
    ...both(env.ProgramFiles, "C:\\Program Files"),
    ...both(env["ProgramFiles(x86)"], "C:\\Program Files (x86)"),
    ...both(env.ProgramData, "C:\\ProgramData"),
    /**
     * The app's own data, and every other app's — the counterpart of `~/Library`.
     *
     * ⚠ DERIVED FROM `HOME` AS WELL, so these cannot be removed by unsetting a variable. `os.homedir()`
     * reads the OS's own notion of the profile directory, and `AppData` is always its child — see also
     * the `SENSITIVE_CONTENTS` entry, which covers everything INSIDE it.
     */
    path.join(HOME, "AppData", "Roaming"),
    path.join(HOME, "AppData", "Local"),
    ...(env.APPDATA ? [env.APPDATA] : []),
    ...(env.LOCALAPPDATA ? [env.LOCALAPPDATA] : []),
  ];
  // De-duplicated: on a 32-bit-free machine the two Program Files variables can be identical.
  return [...new Set(areas.filter(Boolean))];
}

/** Roots that are too broad to be a project even though they contain nothing sensitive directly. */
const TOO_BROAD: readonly string[] = [
  "/",
  "/var",
  "/private/var",
  "/System/Volumes/Data",
  dirname(HOME), // `/Users` on macOS, `/home` on Linux, `C:\\Users` on Windows
  path.join(HOME, "Desktop"),
  path.join(HOME, "Documents"),
  path.join(HOME, "Downloads"),
  /**
   * ⚠ THE DRIVE ROOT. `"/"` above is not a Windows path, and `path.parse("C:\\x").root` is `C:\\` — so
   * without this a participant could pick `C:\\` and hand the whole volume to every path check in the
   * app. Derived from the home directory's own root, so it is the correct letter on any machine, plus
   * the boot volume from `%SystemDrive%` for the case where the profile lives elsewhere.
   *
   * The trailing separator matters and is why these go through `canonicalRoot` like everything else:
   * `C:\\` and `C:` name the same place but only one of them is what `path.resolve` returns.
   */
  ...(process.platform === "win32"
    ? [...new Set([path.parse(HOME).root, `${process.env.SystemDrive || "C:"}\\`])]
    : []),
];

/**
 * Reduce a path to the form comparisons can trust.
 *
 * ⚠ THE FIRMLINK STRIP IS THE POINT. On macOS the data volume is reachable as
 * `/System/Volumes/Data/Users/<me>`, `realpathSync` returns that path UNCHANGED (verified), and it
 * IS the home directory. Comparing without stripping it means the renderer gets `$HOME` by prefixing
 * every path with 20 characters.
 */
function canonicalRoot(target: string): string {
  let resolved = path.resolve(target);  // nosemgrep: path-join-resolve-traversal
  const FIRMLINK = "/System/Volumes/Data";
  if (resolved === FIRMLINK) {
    resolved = "/";
  } else if (resolved.startsWith(FIRMLINK + path.sep)) {
    resolved = resolved.slice(FIRMLINK.length);
  }
  try {
    // Also folds `/etc` -> `/private/etc` and a symlinked spelling of any candidate.
    resolved = realpathSync(resolved);
  } catch {
    /* may not exist yet; the lexical form is the best available answer */
  }
  return resolved;
}

/**
 * ── ⚠ WINDOWS PATHS ARE CASE-INSENSITIVE, AND EVERY COMPARISON HERE WAS NOT ───────────────────
 *
 * `C:\\Users\\me\\Downloads` and `c:\\users\\me\\downloads` are THE SAME DIRECTORY on Windows, and
 * NTFS records whichever casing created it. So a case-sensitive `startsWith` gets two different
 * answers about one directory depending on how the string was spelled — and the two directions fail
 * in opposite ways:
 *
 *   containment (`isWithinProject`)     fails CLOSED — a valid file under the project is refused
 *                                       because the picker returned "C:\\Proj" and the renderer sent
 *                                       "c:\\Proj". Annoying, visible, not dangerous.
 *   the DENYLIST (`isForbiddenProjectRoot`)
 *                                       fails OPEN — `c:\\users\\me\\downloads` does not match the
 *                                       `C:\\Users\\me\\Downloads` entry, so a root this module exists
 *                                       to refuse is ACCEPTED. That is the bug worth fixing.
 *
 * ⚠ FOLDED ONLY FOR THE COMPARISON, never for the value. Every function still returns and stores the
 * path as given: lower-casing a path that is then handed to `fs` would be wrong on the case-sensitive
 * volumes that also exist on Windows, and unreadable to a user on any platform.
 *
 * ⚠ AND NOT APPLIED ON macOS, where HFS+/APFS are case-INSENSITIVE by default but can be formatted
 * case-sensitive, and Linux, where paths are case-sensitive. Folding there would MERGE two genuinely
 * distinct directories — turning a fail-closed check into a fail-open one on the platforms this app
 * mostly runs on. The trade is only correct where the filesystem's own rule is insensitivity, which
 * on Windows it always is for the paths that matter here.
 */
const FOLD_CASE = process.platform === "win32";

/** The form two paths may be compared in. Never the form a path is used in. */
function comparable(p: string): string {
  return FOLD_CASE ? p.toLowerCase() : p;
}

/** True if two paths name the same place, per the platform's own casing rule. */
function samePath(a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}

/** True if `candidate` is `other` or an ancestor of it. */
function isAtOrAbove(candidate: string, other: string): boolean {
  const a = comparable(candidate);
  const b = comparable(other);
  return a === b || b.startsWith(a + path.sep);
}

/** True if `candidate` is `area` or sits inside it. */
function isAtOrInside(candidate: string, area: string): boolean {
  const a = comparable(candidate);
  const b = comparable(area);
  return a === b || a.startsWith(b + path.sep);
}

/**
 * True if `target` is too sensitive or too broad to be a project root.
 *
 * Exported for the migration that re-validates roots persisted by an earlier build — see
 * `allowedRoots`, which applies the same test on READ so the boundary can never BE one of these
 * however it came to be written.
 */
export function isForbiddenProjectRoot(target: string): boolean {
  if (typeof target !== "string" || target.length === 0) return true;
  const candidate = canonicalRoot(target);

  /**
   * ⚠ `samePath`, NOT `===`. This was the one comparison in this function that did not go through a
   * helper, so it stayed case-SENSITIVE when the others were folded — and a test caught it: on Windows
   * a re-cased `~\\Downloads` missed every entry and the function returned false, accepting a root it
   * exists to refuse. An exact-match test looks like the safest kind and was the only fail-open one.
   */
  if (TOO_BROAD.some((broad) => samePath(candidate, canonicalRoot(broad)))) return true;
  /**
   * ── ⚠ BOTH DIRECTIONS, AND ONLY ONE WAS TESTED ────────────────────────────────────────────────
   *
   * `isAtOrAbove` refuses a candidate that CONTAINS something sensitive — `~` and `~/.ssh` itself. It says
   * nothing about a candidate INSIDE one, and these seven entries appear in no other list, so:
   *
   *     isForbiddenProjectRoot("~/.ssh")            true    (at-or-above)
   *     isForbiddenProjectRoot("~/.config/gh")      FALSE   ← a live GitHub OAuth token
   *     isForbiddenProjectRoot("~/.aws/sso/cache")  FALSE   ← live SSO access tokens
   *
   * Those then read out through the ordinary file handlers with every check passing. `Library` was
   * deliberately put in BOTH lists, which is what makes this an oversight rather than a decision —
   * the one entry someone thought about is covered in both directions and the rest were not.
   *
   * It needs the user to pick that folder in the native picker, so it is social engineering rather
   * than a silent bypass — but "point the app at your ~/.aws folder" is a plausible instruction, and
   * this module's own header lists `~/.config` and `~/.gnupg` as exactly the leak the containment test
   * exists to close.
   */
  if (
    SENSITIVE_CONTENTS.some((s) => {
      const sensitive = canonicalRoot(s);
      return isAtOrAbove(candidate, sensitive) || isAtOrInside(candidate, sensitive);
    })
  ) {
    return true;
  }
  // Sits in an area that is never a project.
  if (EXCLUDED_AREAS.some((area) => isAtOrInside(candidate, canonicalRoot(area)))) return true;
  return false;
}

/**
 * Record that the user chose `target` in a native dialog, and return it resolved.
 *
 * Called ONLY from a handler that has just received a path back from `dialog.showOpenDialog`
 * (see `files:selectDirectory`). Throws for a forbidden root so the refusal happens once, at
 * the picker, rather than as a confusing "access denied" three screens later.
 */
export function recordUserChosenPath(target: string): string {
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("No folder selected");
  }
  const resolved = path.resolve(target);  // nosemgrep: path-join-resolve-traversal
  if (isForbiddenProjectRoot(resolved)) {
    throw new Error(
      "That folder cannot be used as a project. It is your home folder or a system " +
        "directory, so opening it would put your credentials and system files inside the " +
        "project. Choose the specific folder you want to work in."
    );
  }
  userChosenPaths.add(resolved);
  return resolved;
}

/** True if `target` came back from a native picker in this session. */
export function wasUserChosen(target: string): boolean {
  if (typeof target !== "string" || target.length === 0) return false;
  return userChosenPaths.has(path.resolve(target));  // nosemgrep: path-join-resolve-traversal
}

/**
 * Throw unless `target` came from a native picker; returns the resolved path.
 *
 * The gate on every write that feeds `allowedRoots()`. The message deliberately does not
 * distinguish "not picked" from "forbidden root" — a renderer probing this channel learns
 * nothing about the filesystem either way.
 */
export function assertUserChosen(target: string): string {
  if (!wasUserChosen(target)) {
    throw new Error(
      "Access denied: a project folder must be chosen in the native folder picker"
    );
  }
  return path.resolve(target);  // nosemgrep: path-join-resolve-traversal
}

// Confine filesystem operations to directories the user actually opened as
// projects — the renderer must never drive reads/writes/spawns into arbitrary
// paths like ~/.ssh, ~/.aws, or ~/Library/LaunchAgents.
// Roots = the `project_path` setting + all rows in the `projects` table.
//
// ⚠ Both inputs are written ONLY by a main-process handler that verified picker provenance
// (`assertUserChosen`). See ALLOWLIST_SOURCE_SETTINGS above for why that matters more than
// anything this function does.
export function allowedRoots(): string[] {
  const roots = new Set<string>();
  const pp = readSetting("project_path");
  if (pp) roots.add(path.resolve(pp));
  try {
    /**
     * ── ⚠ SCOPED TO THE ACTIVE LOCAL ACCOUNT ──────────────────────────────────────────────────
     *
     * This was `SELECT path FROM projects` with no predicate, while EVERY other read of that table binds the
     * active account (`db:getProjects`, the `db:addProject` upsert match, `db:removeProject`) — and db.ts's
     * own comment says a projects row is a BOUNDARY GRANT, not merely a record.
     *
     * The consequence was a stale grant that outlived the account that made it: after
     * `auth:switchAccount`, account B's filesystem boundary still contained every folder account A
     * had ever opened. B could read, write, rename, trash and run agents inside them, while
     * `db:getProjects` listed none of them and `db:removeProject` would not let B revoke the row.
     *
     * ⚠ `user_id IS ?` RATHER THAN `= ?`, and the difference decides what happens to legacy rows.
     * A project added before the column existed carries NULL, and `NULL = NULL` is never true in
     * SQL. With `=` those rows would drop out of the boundary the moment this shipped — every
     * pre-existing project becoming "outside the project" and the app refusing to read its own
     * files. `IS` keeps them granted while nobody is signed in (`activeUserId()` is null, matching
     * NULL rows) and once somebody is, only their own rows plus the unowned legacy ones.
     */
    /**
     * ── ⚠ AND SCOPED TO THE ACTIVE EXPERIENCE, SO THE BOUNDARY CANNOT EXCEED WHAT THE UI LISTS ──
     *
     * Three queries over this table disagreed: `db:getProjects` filtered `workshop_id IS NULL OR workshop_id
     * = ?`, this function applied NO workshop predicate at all, and `db:removeProject` deleted by id alone.
     * So a row tagged with any other experience stayed granted for ever while being absent from every list —
     * and the UI can only revoke ids `db:getProjects` returned.
     *
     * ⚠ THIS COSTS NOBODY ACCESS THEY CAN CURRENTLY SEE, which is what makes it safe to tighten:
     * such a row is ALREADY hidden by `db:getProjects`, so the folder is already absent from the
     * project list and the switcher. All that changes is that it stops granting silently. Re-picking
     * the folder restores it through the gate, with a correct tag.
     *
     * ⚠ THE SAME `IS NULL` ESCAPE HATCH AS ITS SIBLING, for the same reason: rows written before
     * experience scoping existed carry NULL, and a bare equality would drop every one of them out of
     * the boundary — the app refusing to read its own files. And when no experience is configured
     * there is nothing to scope by, so every owned row stands.
     */
    const experience = activeExperience();
    const rows = (
      experience
        ? getDb()
            .prepare(
              "SELECT path FROM projects WHERE (user_id IS ? OR user_id IS NULL) " +
                "AND (workshop_id IS NULL OR workshop_id = ?)"
            )
            .all(activeUserId(), experience)
        : getDb()
            .prepare("SELECT path FROM projects WHERE user_id IS ? OR user_id IS NULL")
            .all(activeUserId())
    ) as { path: string }[];
    for (const r of rows) if (r.path) roots.add(path.resolve(r.path));
  } catch {
    /* projects table may be empty */
  }

  /**
   * ── ⚠ VALIDATED ON READ, NOT ONLY ON WRITE ──────────────────────────────────────────────
   *
   * The picker gate makes new writes trustworthy, and that is not the same as making the STORED
   * state trustworthy. Any install that ran a build where the renderer could
   * `setSetting("project_path", os.homedir())` still has `$HOME` in this table, and upgrading does
   * not undo it — so the original hole survived the fix for exactly the users who had already been
   * exposed to it.
   *
   * A migration clears those rows once (see migrations.ts). This is the standing invariant behind
   * it: the boundary refuses to BE a forbidden root however the value came to be written — a stale
   * row, a hand-edited settings table, a future code path that forgets the gate.
   *
   * Filtering here rather than throwing keeps a legitimate second root usable when only one row is
   * bad: the answer to "which directories may I touch" is the good ones, not none of them.
   */
  const safe = [...roots].filter((root) => !isForbiddenProjectRoot(root));
  if (safe.length !== roots.size) {
    console.warn(
      `[project-paths] ignoring ${roots.size - safe.length} stored project root(s) that are too ` +
        `broad or contain credentials — re-pick the folder to restore access`
    );
  }
  return safe;
}

/**
 * True if `target` IS one of the open project roots — not merely inside one.
 *
 * ── ⚠ WHY THIS EXISTS RATHER THAN `isWithinProject` ───────────────────────────────────────────
 *
 * That handler had hand-rolled its own root set from `SELECT path FROM projects` with no predicate, so it was
 * the one remaining consultation of that table that honoured NEITHER invariant this module documents: it
 * would trust a row belonging to another local account, and it would trust a stored row that is itself a
 * forbidden root — the case `allowedRoots()` filters on READ precisely because a stale or hand-edited row can
 * be one.
 *
 * ⚠ AND `isWithinProject` WAS THE WRONG REPAIR, though it fixes both of those. It answers "is this path
 * inside a project", which would newly permit `<project>/node_modules/x` to be trusted — a WIDENING of
 * a handler whose comment says "folders the user actually opened as projects". The defect was the source
 * of the root set, not the strictness of the comparison, so only the source changes here.
 *
 * Case-folded on Windows through `samePath`, which the hand-rolled `Set.has()` also was not: two
 * spellings of one directory differ only in case there, and an exact-match test that misses is a test
 * that fails OPEN for a denylist and CLOSED for this one — refusing a folder the user really did open.
 */
export function isOpenProjectRoot(target: string): boolean {
  if (typeof target !== "string" || target.length === 0) return false;
  const resolved = path.resolve(target);  // nosemgrep: path-join-resolve-traversal
  return allowedRoots().some((root) => samePath(root, resolved));
}

/** True if `target` is one of the project roots or nested inside one. */
export function isWithinProject(target: string): boolean {
  if (typeof target !== "string" || target.length === 0) return false;
  const resolved = path.resolve(target);  // nosemgrep: path-join-resolve-traversal
  // `isAtOrInside`, not a raw startsWith: on Windows the two spellings of one directory differ only
  // in case, and this check would refuse a legitimate file under the project.
  return allowedRoots().some((root) => isAtOrInside(resolved, root));
}

/**
 * Non-throwing `assertRealPathWithinProject` — true if `target` is inside a project root once
 * SYMLINKS are resolved.
 *
 * Exists for the callers that need a QUESTION rather than an assertion: the framework handlers return
 * a `{ skipped }` / `{ error }` object the UI renders, and `confineCwd` builds its own refusal message
 * (it does NOT fall back to `$HOME` — see spawn-confined.ts for why that was the wrong default).
 * Without a predicate those callers were stuck on the LEXICAL check, which a symlink inside the
 * project defeats.
 */
export function isRealPathWithinProject(
  target: string,
  opts: { mustExist?: boolean } = {}
): boolean {
  try {
    assertRealPathWithinProject(target, opts);
    return true;
  } catch {
    // Every rejection is the same answer to the caller: not usable. The distinction between
    // "outside", "missing" and "symlinked out" matters for a thrown message, not for a boolean.
    return false;
  }
}

/**
 * ── ⚠ REPOSITORY METADATA IS NOT ORDINARY PROJECT CONTENT ─────────────────────────────────────
 *
 * Confinement to the project root is the WRONG boundary for `.git`, because `.git` is inside the project and
 * git EXECUTES several values it finds there. Measured on git 2.55, with the values in a repo-local
 * `.git/config`:
 *
 *   [core] fsmonitor = "<cmd>"        -> ran on `git status`   (git:status, unattended)
 *   [diff] external  = "<cmd>"        -> ran on `git diff`
 *   [diff "d"] textconv = "<cmd>"     -> ran on `git diff`, with a `.gitattributes` entry
 *   [core] hooksPath = <dir>          -> ran <dir>/pre-commit on `git commit`
 *   .git/hooks/pre-commit             -> ran on `git commit`
 *   [filter "f"] clean = "<cmd>"      -> ran on `git add -A`
 *
 * `safe.directory` and the CVE-2022-24765 hardening do not apply: the repository is owned by the
 * same user running the app. So the control is that no renderer-driven channel may put content
 * into `.git`, and the git-side `-c` overrides in handlers/git.ts are the second layer, not this one.
 *
 * ⚠ CASE-FOLDED, BECAUSE THE FILESYSTEM IS. Verified on macOS: `.GIT/probe` lands in `.git/probe`,
 * so a `=== ".git"` comparison is not a check — it is a spelling suggestion. Trailing dots and
 * spaces are stripped per component for the Windows reason `validateName` already documents: the
 * OS silently trims them, so `.git.` names `.git` on disk.
 *
 * ⚠ MUTATION ONLY, AND DELIBERATELY NOT WIRED INTO `assertRealPathWithinProject`. Reading `.git`
 * is how the file tree renders it and is not an execution primitive; refusing reads here would be a
 * visible regression bought for nothing. The cost of an explicit call per site is that a site can be
 * missed — which is exactly how `files.ts` came to keep the lexical guard after its siblings moved —
 * so git-metadata-writes.test.ts enumerates the mutating channels and asserts every one refuses.
 */
export function assertNotRepositoryMetadata(target: string): void {
  if (typeof target !== "string" || target.length === 0) return;
  const components = path.resolve(target).split(/[\\/]+/);  // nosemgrep: path-join-resolve-traversal
  for (const component of components) {
    // Windows trims a trailing dot or space, so the name on disk is the trimmed one.
    if (component.replace(/[. ]+$/, "").toLowerCase() === ".git") {
      throw new Error(
        "Access denied: the .git folder holds the repository's own settings, which git runs as " +
          "commands. Choose a path outside it."
      );
    }
  }
}

/** Throw unless `target` is within an open project root; returns the resolved path. */
export function assertWithinProject(target: string): string {
  if (!isWithinProject(target)) {
    throw new Error("Access denied: path is outside an open project folder");
  }
  return path.resolve(target);  // nosemgrep: path-join-resolve-traversal
}

/**
 * True if `p` names an entry, EVEN a dangling symlink.
 *
 * `existsSync` answers "can this be followed to something", which is a different question and the
 * wrong one for a guard: a link pointing nowhere is very much present, and skipping it is what let a
 * write escape the project.
 */
function entryExists(p: string): boolean {
  try {
    lstatSync(p);  // nosemgrep: detect-non-literal-fs-filename
    return true;
  } catch {
    return false;
  }
}

/**
 * ── ⚠ ONE BUDGET FOR A WHOLE RESOLUTION, SHARED AND MUTABLE ────────────────────────────────
 *
 * `resolveLinkChain` and `resolvePhysically` call each other, and the budget MUST accumulate
 * across every branch rather than being handed down by value. The first version of the `..` fix
 * passed `hops + 1` into the per-segment call, which caps DEPTH but leaves BREADTH free — so a
 * link whose target names a sibling link twice costs twice as much at each level, and the total
 * is exponential. Measured on this machine, with `d/M{i} -> "M{i+1}/M{i+1}"`:
 *
 *      8 links     58 ms
 *     12 links    627 ms
 *     16 links      9.7 s
 *     18 links     39 s
 *     20 links    158 s          ← 21 links in a cloned repo freezes the app
 *
 * ⚠ AND THAT FREEZE IS THE WHOLE PROCESS. These functions are synchronous and run on the Electron
 * MAIN process, so there is no timeout and no other work proceeds: the window stops responding
 * until the walk finishes, which for 25 links is hours. A guard that hangs is a worse outcome than
 * a guard that refuses, and this is reachable from exactly the same place the `..` bypass was —
 * symlinks carried in by a cloned repository or written by an agent in the workspace.
 *
 * Two counters, because they bound different things:
 *   `follows` — symlinks actually FOLLOWED. Preserves the original semantics (and message); a
 *               legitimate path follows one or two, never thirty.
 *   `steps`   — path segments EXAMINED, across the entire resolution. This is the one that bounds
 *               a fan-out graph, because such a graph is cheap per follow and expensive in total.
 */
type LinkBudget = { follows: number; steps: number };

/** A legitimate path follows one or two links. Thirty-two is already absurd; it is a backstop. */
const MAX_LINK_FOLLOWS = 32;

/**
 * Segments examined per resolution. Generous — a deep monorepo path is tens — but finite, so no
 * arrangement of links on disk can make one containment check unbounded work.
 */
const MAX_RESOLUTION_STEPS = 4096;

/**
 * Follow a symlink chain to the path it ultimately NAMES, without requiring the end to exist.
 *
 * Returns `p` unchanged when it is not a link (or does not exist), so callers can compare identity to
 * learn whether anything was followed. Bounded: a symlink loop is a real filesystem state, and an
 * unbounded walk over one is a hang rather than a refusal.
 */
function resolveLinkChain(p: string, budget: LinkBudget = { follows: 0, steps: 0 }): string {
  let stat;
  try {
    stat = lstatSync(p);  // nosemgrep: detect-non-literal-fs-filename
  } catch {
    return p; // absent: it names itself
  }
  if (!stat.isSymbolicLink()) return p;
  // Counted only when a link is actually followed, so a long path of ordinary directories costs
  // nothing against this budget — `steps` in resolvePhysically is what bounds that.
  if (++budget.follows > MAX_LINK_FOLLOWS) {
    throw new Error("Access denied: too many symbolic links to resolve");
  }
  const target = readlinkSync(p);  // nosemgrep: detect-non-literal-fs-filename
  const next = path.isAbsolute(target)
    ? target
    : // ⚠ NOT `path.resolve(dirname(p), target)`, AND THE DIFFERENCE IS A CONFINEMENT BYPASS.
      // `path.resolve` and `path.join` both collapse `..` TEXTUALLY, which is the very mistake
      // the caller-string rule at the top of assertRealPathWithinProject exists to refuse — and
      // this line made it again, on the link's own target, where that rule cannot see it:
      //
      //     <root>/esc  -> /outside            (a directory outside the project)
      //     <root>/pwn  -> "esc/../outside/evil.plist"
      //
      //     path.resolve("<root>", "esc/../outside/evil.plist")  ->  <root>/outside/evil.plist
      //
      // which isWithinProject accepts, so the refusal below never fired and the caller was
      // handed <root>/pwn. The KERNEL then resolves `esc` first, applies `..` to `/`, and writes
      // /outside/evil.plist — code execution on the participant's machine (~/.zshenv,
      // ~/Library/LaunchAgents/*.plist) from two symlinks placed inside the project.
      //
      // ⚠ AND THE FIX IS NOT "REFUSE `..` IN A LINK TARGET", the obvious mirror of the
      // caller-string rule. Relative parent targets are ORDINARY: every pnpm/npm `.bin` entry is
      // one (`node_modules/.bin/vite -> ../vite/bin/vite.js`), as is every workspace link in a
      // monorepo. Refusing them would break reading node_modules across the whole app to close a
      // hole that proper resolution closes without collateral damage.
      resolvePhysically(dirname(p), target, budget);
  return resolveLinkChain(next, budget);
}

/**
 * Resolve `relTarget` against `startDir` the way the KERNEL does: one segment at a time, following
 * any symlink as it is met, and applying `..` to whatever the path has physically become rather
 * than to the text.
 *
 * That ordering is the whole point. `path.resolve` answers "what does this string reduce to";
 * this answers "what does the filesystem arrive at", and for a `..` that follows a symlinked
 * component the two differ — see the caller.
 *
 * Missing components are fine and are simply appended: the guard's job is to decide where a path
 * WOULD land, and the common case is a destination that does not exist yet.
 */
function resolvePhysically(startDir: string, relTarget: string, budget: LinkBudget): string {
  let current = startDir;
  for (const segment of relTarget.split(/[\\/]+/)) {
    // ⚠ COUNTED PER SEGMENT, ON THE SHARED BUDGET. This is the counter that bounds a fan-out
    // graph: such a graph is cheap per link followed and ruinous in total, so a `follows` cap
    // alone does not see it. See the LinkBudget comment for the measurements.
    if (++budget.steps > MAX_RESOLUTION_STEPS) {
      throw new Error("Access denied: path is too complex to resolve safely");
    }
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // Applied to the path as resolved SO FAR, which is what makes this correct.
      current = dirname(current);
      continue;
    }
    current = path.join(current, segment);  // nosemgrep: path-join-resolve-traversal
    // Follow an intermediate link before the next segment — including the next `..` — is applied.
    // The budget is the SAME OBJECT throughout, so work spent here is not available to another
    // branch; passing a copy is what made the first version of this exponential.
    current = resolveLinkChain(current, budget);
  }
  return current;
}

/**
 * Like `assertWithinProject`, but resolves SYMLINKS before deciding — and refuses to follow one
 * out of the project.
 *
 * ── WHY THE LEXICAL CHECK IS NOT ENOUGH FOR A MUTATION ──
 *
 * `isWithinProject` compares `path.resolve(target)` against the roots, which is purely textual. A
 * symlink INSIDE an open project defeats it, verified rather than assumed:
 *
 *     ln -s /etc  <project>/escape
 *     path.resolve("<project>/escape/passwd")  ->  "<project>/escape/passwd"   ✔ passes
 *     fs.realpathSync(same)                    ->  "/private/etc/passwd"       ✘ outside
 *
 * For RENAME, MOVE, DELETE and OVERWRITE the stakes are obvious — following that link would let the
 * renderer destroy `~/.ssh/id_rsa` or `~/Library/LaunchAgents` while every path it passed looked
 * project-relative.
 *
 * ⚠ AND THE "READS ARE BOUNDED" EXEMPTION THAT USED TO BE WRITTEN HERE IS GONE, because it was wrong.
 * It said the worst case for a read was "showing the user a file they could already open in any
 * editor". The reader is not the user: it is the RENDERER, and its CSP is `connect-src *`, so a read
 * is an EXFILTRATION primitive rather than a display one. handlers/files.ts retracted the same
 * sentence when `files:readFile` moved to this function, and that later surfaced the
 * three handlers that exemption had left behind — `files:readDirectory` (a walkable enumeration of the
 * entire filesystem), `files:getProjectInfo` and `fileOps:revealInFolder`.
 *
 * Every entry point on this boundary resolves symlinks now, reads included. The paragraph is kept as a
 * warning rather than deleted: an exemption for reads is an easy thing to re-introduce, and this is the
 * record of it being tried and withdrawn.
 *
 * ── WHAT IT CHECKS, AND WHY THE PARENT ──
 *
 * `fs.realpathSync` throws on a path that does not exist yet, which every CREATE and the
 * DESTINATION of every rename legitimately is. So the check walks up to the nearest EXISTING
 * ancestor and resolves that: a new file inside a real directory is fine, and a new file inside a
 * symlinked-out directory is not.
 *
 * `mustExist` distinguishes the two cases the callers actually have — a source that has to be
 * there, and a destination that must not be.
 */
export function assertRealPathWithinProject(
  target: string,
  opts: { mustExist?: boolean } = {}
): string {
  /**
   * ── ⚠ A LITERAL `..` SEGMENT IS REFUSED, IN THE CALLER'S OWN STRING ───────────────────────
   *
   * Everything below decides on `path.resolve(target)`, which collapses `..` LEXICALLY, whereas the
   * kernel applies `..` AFTER following a symlink. So `<root>/link/..` is judged as `<root>` and
   * acted on as wherever `link` points — the one divergence the realpath walk cannot see, because
   * `resolve` has already erased the `link` component from the string it inspects.
   *
   * No legitimate caller needs `..`: the renderer builds paths from `path.join` output and from
   * absolute paths the picker returned, both already normalised.
   */
  if (typeof target === "string" && target.split(/[\\/]+/).includes("..")) {
    throw new Error("Access denied: path is outside an open project folder");
  }

  const resolved = assertWithinProject(target);

  /**
   * ── ⚠ THE DANGLING SYMLINK, WHICH `existsSync` CANNOT SEE ──────────────────────────────
   *
   * `fs.existsSync` FOLLOWS symlinks, so a link whose target does not exist yet reports
   * `false` — indistinguishable from "no such entry". The ancestor walk below therefore
   * stepped straight PAST the link, settled on the project root, passed, and the caller's
   * `writeFileSync` then followed the link and created the file at its target. Verified:
   *
   *     ln -s /outside/newfile  <project>/evil     # target does not exist
   *     existsSync(<project>/evil)  ->  false      # walk skips the link entirely
   *     writeFileSync(<project>/evil, …)           # /outside/newfile created
   *
   * Overwriting an existing file outside was already blocked (the target exists, so realpath
   * catches it). Creating a NEW one was not, and that is enough for
   * `~/Library/LaunchAgents/*.plist`, `~/.zshenv`, or `~/.ssh/authorized_keys` when absent.
   *
   * So the leaf is resolved through the link chain FIRST, with `lstat`, which sees the entry
   * itself rather than what it points at. The path actually being named is then subject to the
   * same containment rule — preserving this module's stated semantics: the rule is about where
   * a link POINTS, not that it is a link, so a link to a file inside the project still works.
   */
  const named = resolveLinkChain(resolved);
  if (named !== resolved && !isWithinProject(named)) {
    /**
     * The leaf is a link and what it names is outside: refuse.
     *
     * ⚠ THE SYMLINK-FLAVOURED MESSAGE, NOT THE GENERIC ONE. An existing test in file-ops.test.ts
     * asserts `/symlink/i` here, and it is right to: "outside an open project folder" sends the
     * reader looking at the path they typed, which looks perfectly project-relative. Naming the
     * mechanism is the difference between a confusing refusal and an actionable one.
     */
    throw new Error("Access denied: path resolves outside an open project folder (symlink?)");
  }

  // Nearest existing ancestor. A destination is normally absent; its PARENT must still be inside.
  //
  // ⚠ `entryExists`, NOT `existsSync` — for the reason above. A dangling link must register as
  // PRESENT here, or the walk skips the very entry whose target it needs to judge.
  let probe = named;
  let hops = 0;
  while (!entryExists(probe)) {
    if (probe === named && opts.mustExist) {
      throw new Error("Not found: no such file or folder");
    }
    const parent = dirname(probe);
    // `dirname("/")` is `"/"`, so this is the loop's real terminator; the hop cap is a belt on a
    // pathological path rather than the mechanism.
    if (parent === probe || ++hops > 64) {
      throw new Error("Access denied: path is outside an open project folder");
    }
    probe = parent;
  }

  // `probe` is a real, existing entry by now, but it may itself be a link INTO the project — the
  // walk stopped at the first present entry, not the first non-link one.
  const real = realpathSync(probe);
  const withinRealRoot = allowedRoots().some((root) => {
    // Roots are resolved through symlinks too: on macOS `/tmp` IS a symlink, so comparing a
    // real target against a lexical root would refuse every legitimate path under it.
    const realRoot = existsSync(root) ? realpathSync(root) : path.resolve(root);  // nosemgrep: detect-non-literal-fs-filename,path-join-resolve-traversal
    // Case-folded on Windows — `realpathSync` there returns the on-disk casing, which need not match
    // the casing the root was stored with.
    return isAtOrInside(real, realRoot);
  });
  if (!withinRealRoot) {
    throw new Error(
      "Access denied: path resolves outside an open project folder (symlink?)"
    );
  }
  return resolved;
}
