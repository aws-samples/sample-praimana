// ── ⚠ PROFILES, AND THE ONE PLACE A BUG HERE IS A PATH TRAVERSAL ──────────────────────────
//
// The profile name becomes a DIRECTORY COMPONENT under `userData`, and that directory holds the SQLite file
// containing the auth token. So `sanitiseProfileName` is not input tidying — it is the boundary that stops a
// launch argument from deciding where a participant's credentials are written. Most of this file is that one
// function, tested adversarially.
//
// The ordering assertions at the end matter for a different reason: `applyProfile()` is only correct if it
// runs before the single-instance lock and before the database opens. That is a property of `index.ts`, not of
// `profile.ts`, so it is asserted against the source — the same technique `model-list-scope.test.ts` uses for
// the rule that a model list may only come from the assistant it describes.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/Users/someone/Library/Application Support/Praimana",
    setPath: vi.fn(),
  },
}));

const { sanitiseProfileName, requestedProfile, applyProfile, decideLaunch } = await import(
  "./profile"
);
const { app } = await import("electron");

describe("⚠ sanitiseProfileName — the path-traversal boundary", () => {
  it("keeps an ordinary name", () => {
    expect(sanitiseProfileName("team-b")).toBe("team-b");
    expect(sanitiseProfileName("team.b_2")).toBe("team.b_2");
  });

  /**
   * ⚠ THE CASE THIS FUNCTION EXISTS FOR. Joined onto a path, any of these would put the database — and the
   * auth token inside it — somewhere the participant never chose. `../Default` is the nastier one: it is not
   * an escape to `/tmp` but a way for one profile to masquerade as another.
   */
  it.each([
    ["parent traversal", "../../../../tmp/evil"],
    ["masquerade as a sibling", "../default"],
    ["absolute posix path", "/etc/passwd"],
    ["absolute windows path", "C:\\Windows\\Temp"],
    ["windows separators", "..\\..\\evil"],
    ["url-ish", "http://evil.test/x"],
  ])("strips every separator from %s", (_label, raw) => {
    const safe = sanitiseProfileName(raw)!;
    expect(safe, `${raw} must not keep a separator`).not.toMatch(/[/\\]/);
    /**
     * ⚠ AND THE RESULT MUST NOT STILL BE A RELATIVE COMPONENT. Stripping separators alone is not enough —
     * that is what the dots-only check in the implementation is for, and this asserts the composed outcome
     * rather than the individual rule.
     */
    expect(safe).not.toBe("..");
    expect(safe).not.toBe(".");
    expect(join("/root", safe).startsWith("/root/"), "must resolve inside the root").toBe(true);
  });

  /**
   * ⚠ DOTS PASS THE CHARACTER FILTER AND ARE STILL PATHS. `.` is a legal member of `[A-Za-z0-9._-]`, so a
   * character allowlist alone admits `..` — a name that resolves to the PARENT directory. Rejected rather
   * than repaired.
   */
  it.each([[".", ".."], ["..", "..."], ["....", "."]].flat())(
    "refuses the dots-only name %o",
    (raw) => {
      expect(sanitiseProfileName(raw)).toBeNull();
    }
  );

  it("refuses a name with nothing usable in it", () => {
    expect(sanitiseProfileName("///")).toBeNull();
    expect(sanitiseProfileName("   ")).toBeNull();
    expect(sanitiseProfileName("")).toBeNull();
    expect(sanitiseProfileName(undefined)).toBeNull();
    expect(sanitiseProfileName(null)).toBeNull();
  });

  /**
   * ⚠ CASE-FOLDED BECAUSE macOS AND WINDOWS FILESYSTEMS ARE NOT CASE-SENSITIVE. Without this, `TeamB` and
   * `teamb` are two profiles to the app and ONE directory on disk — two instances, two locks, one SQLite
   * file, which is exactly the hazard the single-instance lock exists to prevent.
   */
  it("folds case, so two spellings cannot share one directory", () => {
    expect(sanitiseProfileName("TeamB")).toBe(sanitiseProfileName("teamb"));
  });

  it("caps the length, since this becomes a path component", () => {
    expect(sanitiseProfileName("x".repeat(500))!.length).toBe(64);
  });

  /** A shell-injection shape is not special here, but it must not survive into a path either. */
  it("strips shell and glob metacharacters", () => {
    expect(sanitiseProfileName("a;rm -rf ~/*")).toBe("arm-rf");
  });

  /**
   * ── ⚠ THE RESERVED SENTINEL ────────────────────────────────────────────────────────────────
   *
   * `createProfile` refused it with an explicit rationale and the LAUNCH path did not, so `--profile=default`
   * produced exactly what that comment warned about: `applyProfile` pointed `userData` at
   * `<root>/profiles/default` and opened a database and safeStorage-encrypted credentials there, while
   * `profileDir("default")` still resolved to the ROOT. One id, two directories — so the sidecar was stamped
   * into another profile's folder, the pointer file read back as the sentinel, and the next ordinary launch
   * went to the root install with the profile just signed into orphaned and unreachable. `listProfiles()`
   * then showed two entries with the same id, either of which opened the root — a participant picking "their"
   * profile landing in whichever account the root install was signed in as.
   *
   * Refused HERE rather than at each call site, because `requestedProfile`, `readLastProfile` and
   * `listProfiles` all run their input through this one function.
   */
  it("refuses the reserved `default` id, however it is spelled", () => {
    expect(sanitiseProfileName("default")).toBeNull();
    expect(sanitiseProfileName("DEFAULT")).toBeNull();
    expect(sanitiseProfileName("  Default  ")).toBeNull();
    // Only the exact sentinel — a name that merely contains it is an ordinary profile.
    expect(sanitiseProfileName("default-2")).toBe("default-2");
    expect(sanitiseProfileName("mydefault")).toBe("mydefault");
  });
});

describe("requestedProfile — argv beats the environment", () => {
  it("reads --profile from anywhere in argv", () => {
    /* The flag's index differs between `electron . --profile=x` and a packaged `App --profile=x`. */
    expect(requestedProfile(["/path/electron", ".", "--profile=alpha"], {})).toBe("alpha");
    expect(requestedProfile(["/path/App", "--profile=alpha", "praimana://x"], {})).toBe("alpha");
  });

  it("falls back to the environment variable", () => {
    expect(requestedProfile(["/path/App"], { PRAIMANA_PROFILE: "beta" })).toBe("beta");
  });

  /** A launcher may export the variable for a session; an explicit flag is the more specific instruction. */
  it("prefers the flag over the environment", () => {
    expect(
      requestedProfile(["/path/App", "--profile=alpha"], { PRAIMANA_PROFILE: "beta" })
    ).toBe("alpha");
  });

  it("is null when neither is given, which is the default profile", () => {
    expect(requestedProfile(["/path/App"], {})).toBeNull();
  });

  /** A dangerous value is refused rather than falling through to the environment's safe one. */
  it("ignores an unusable flag value and still reads the environment", () => {
    expect(requestedProfile(["/path/App", "--profile=.."], { PRAIMANA_PROFILE: "beta" })).toBe(
      "beta"
    );
  });
});

describe("applyProfile", () => {
  it("does nothing at all without a profile — every existing install is untouched", () => {
    vi.mocked(app.setPath).mockClear();
    expect(applyProfile(null)).toBeNull();
    expect(app.setPath, "userData must not move for a default launch").not.toHaveBeenCalled();
  });

  it("nests the profile inside the default userData directory", () => {
    vi.mocked(app.setPath).mockClear();
    expect(applyProfile("team-b")).toBe("team-b");

    expect(app.setPath).toHaveBeenCalledWith(
      "userData",
      join("/Users/someone/Library/Application Support/Praimana", "profiles", "team-b")
    );
  });

  /**
   * ⚠ THE SECOND, INDEPENDENT GUARANTEE FOR THE RESERVED SENTINEL. `sanitiseProfileName` already
   * refuses `default`, so nothing reaches here with it through the launch path — but this function is
   * exported, and the finding was possible precisely because the TWO directory resolvers disagreed
   * about one id: `applyProfile` redirected while `profileDir` did not. They agree now, so a single
   * loosened check cannot recreate the split-brain on its own.
   */
  it("treats the reserved sentinel as no redirect, matching profileDir", () => {
    vi.mocked(app.setPath).mockClear();
    expect(applyProfile("default")).toBeNull();
    expect(app.setPath, "the root install has no profiles/ directory").not.toHaveBeenCalled();
  });
});

/**
 * ── ⚠ THE ORDERING, WHICH IS WHERE THIS FEATURE WOULD SILENTLY BREAK ─────────────────────
 *
 * `applyProfile()` redirects `userData`. Everything that reads `userData` must therefore run after it:
 *
 *   • `initDeepLinks()` takes `requestSingleInstanceLock()`, and Chromium keys the singleton on the
 *     user-data directory — which is the mechanism that lets two profiles run at once.
 *   • `initDatabase()` opens `praimana.db` from that directory.
 *
 * Called too late, this feature is worse than absent: the lock and the database would disagree about which
 * profile the process is, so one instance would hold another's lock while writing its data. No compiler
 * catches a reordering, and no unit test of `profile.ts` alone could — hence a source-order assertion.
 */
describe("⚠ index.ts applies the profile before anything reads userData", () => {
  const index = readFileSync(join(__dirname, "index.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("calls applyProfile before taking the single-instance lock", () => {
    const applied = index.indexOf("applyProfile(");
    const lock = index.indexOf("initDeepLinks()");

    expect(applied, "applyProfile must be called at all").toBeGreaterThan(-1);
    expect(lock, "initDeepLinks must still be called").toBeGreaterThan(-1);
    expect(applied, "the lock is keyed on userData — the profile must be set first").toBeLessThan(lock);
  });

  it("calls applyProfile before opening the database", () => {
    const applied = index.indexOf("applyProfile(");
    const db = index.indexOf("initDatabase()");

    expect(db).toBeGreaterThan(-1);
    expect(applied, "the database lives in userData").toBeLessThan(db);
  });

  /**
   * ⚠ AND THE LOCK IS STILL TAKEN. The temptation when asked for multiple instances is to delete the lock,
   * which would allow two copies of the SAME profile — two writers on one SQLite file, the original hazard.
   * Profiles re-scope the lock; they do not remove it.
   */
  it("still quits when the lock is held, so one profile cannot run twice", () => {
    expect(index).toMatch(/if \(!initDeepLinks\(\)\)/);
    expect(index).toMatch(/app\.quit\(\)/);
  });

  /**
   * ── ⚠ BOTH PROFILE CHANNELS VALIDATE THEIR ID ────────────────────────────────────────────
   *
   * They took the id after only `typeof id === "string" && id !== ""`, while the sibling `profile:create`
   * routes through `createProfile` and therefore through the sanitiser and the reserved-id and collision
   * checks.
   *
   * `profile:open` KILLS THIS PROCESS and rewrites the machine-level launch pointer, and
   * `decideLaunch` rule 1 accepts an explicit profile that does not exist yet — so one
   * `electronAPI.profileOpen("zzz")` from renderer-bundle code exited the app, created an empty
   * profile, and sent every later launch there. The participant sees no projects, no chats, signed
   * out, with their data intact but reachable only through the chooser.
   *
   * ⚠ ASSERTED AGAINST THE SOURCE, like the ordering above, and for the same reason: reaching these
   * handlers needs a real `ipcMain`, a real `BrowserWindow` and a database, and the property is a
   * one-line omission that no unit of `profile.ts` can see.
   */
  it("validates the profile id on profile:open and profile:openWindow", () => {
    // The helper exists and does both halves: shape, and existence.
    expect(index).toMatch(/function requireExistingProfile\(/);
    expect(index).toMatch(/sanitiseProfileName\(/);
    expect(index).toMatch(/profileExists\(/);

    for (const channel of ["profile:open", "profile:openWindow"]) {
      const at = index.indexOf(`"${channel}"`);
      expect(at, `${channel} must still be registered`).toBeGreaterThan(-1);
      const body = index.slice(at, at + 400);
      expect(body, `${channel} must validate the id`).toMatch(/requireExistingProfile\(/);
      // ⚠ AND THE BARE CHECK MUST BE GONE, not merely accompanied: the whole defect was that the
      // typeof test looked like validation.
      expect(body, `${channel} must not accept a bare string`).not.toMatch(
        /typeof params\?\.id === "string" \? params\.id : ""/
      );
    }
  });
});

/**
 * ── ⚠ WHICH PROFILE A LAUNCH IS FOR ───────────────────────────────────────────────────────
 *
 * Four rules whose ORDER is the design. Pure, so the cases below reach it without an Electron app, a
 * filesystem or a relaunch — which is the only way the upgrade case can be tested at all, since it depends on
 * the absence of a file rather than on anything observable in a running app.
 */
describe("⚠ decideLaunch — remembered, explicit, upgraded, or ask", () => {
  it("obeys an explicit --profile above everything else", () => {
    expect(
      decideLaunch({ explicit: "team-b", remembered: "team-a", existing: ["default", "team-a"] })
    ).toEqual({ profile: "team-b", showChooser: false, mustCreate: false });
  });

  /**
   * ⚠ AN EXPLICIT PROFILE NEED NOT EXIST YET. `New Profile…` creates the directory and launches in one go, and
   * `--profile=fresh` on the command line is a reasonable way to make one. Refusing an unknown name here would
   * mean the flag only worked for profiles you already had.
   */
  it("accepts an explicit profile that does not exist yet", () => {
    expect(decideLaunch({ explicit: "brand-new", remembered: null, existing: [] })).toEqual({
      profile: "brand-new",
      showChooser: false,
      mustCreate: false,
    });
  });

  it("goes straight into the remembered profile — no click", () => {
    expect(
      decideLaunch({ explicit: null, remembered: "team-a", existing: ["team-a", "team-b"] })
    ).toEqual({ profile: "team-a", showChooser: false, mustCreate: false });
  });

  /** The remembered DEFAULT means the root install, which is expressed as "no profile". */
  it("maps a remembered default onto the root install", () => {
    expect(
      decideLaunch({ explicit: null, remembered: "default", existing: ["default", "team-a"] })
    ).toEqual({ profile: null, showChooser: false, mustCreate: false });
  });

  /**
   * ⚠ A REMEMBERED PROFILE THAT IS GONE MUST NOT BE LAUNCHED. Applying it would create the directory afresh
   * and present an empty database as the profile the user was last in — data loss that looks like the app
   * forgetting. Asking is the honest answer.
   */
  it("falls through to the chooser when the remembered profile has been deleted", () => {
    const d = decideLaunch({ explicit: null, remembered: "deleted", existing: ["team-a"] });
    expect(d.showChooser).toBe(true);
    expect(d.profile).toBeNull();
  });

  /**
   * ⚠ THE UPGRADE CASE, AND THE REASON IT EXISTS. An existing install keeps its database in the ROOT
   * userData and has no pointer file. Showing it a "create a profile to continue" screen would launch that
   * user into an empty database — every chat and their sign-in apparently gone. They are already in a
   * profile; it simply has no directory.
   */
  it("sends an UPGRADED install straight in, never to the chooser", () => {
    expect(decideLaunch({ explicit: null, remembered: null, existing: ["default"] })).toEqual({
      profile: null,
      showChooser: false,
      mustCreate: false,
    });
  });

  /**
   * ⚠ AND THAT BYPASS IS DELIBERATELY NARROW. Once other profiles exist, the user has opted into the feature
   * and an unremembered launch is genuinely ambiguous — so asking is right. Without this boundary the bypass
   * would mean anyone with root data never saw the chooser again.
   */
  it("DOES ask when root data exists alongside other profiles", () => {
    const d = decideLaunch({ explicit: null, remembered: null, existing: ["default", "team-a"] });
    expect(d.showChooser).toBe(true);
    expect(d.mustCreate, "there is something to choose, so creating is optional").toBe(false);
  });

  /** A fresh install: nothing to remember, nothing to lose, and the request is that creating is required. */
  it("requires creating a profile when none exist", () => {
    expect(decideLaunch({ explicit: null, remembered: null, existing: [] })).toEqual({
      profile: null,
      showChooser: true,
      mustCreate: true,
    });
  });

  /**
   * ⚠ `mustCreate` IS NOT "the chooser is showing". It is the stronger claim that there is no way forward
   * except creating one, and conflating them would either strand a user with no options or let a fresh
   * install slip past the screen with no profile at all.
   */
  it("never demands creation while a profile is available to pick", () => {
    for (const existing of [["default"], ["team-a"], ["default", "team-a", "team-b"]]) {
      const d = decideLaunch({ explicit: null, remembered: "gone", existing });
      expect(d.mustCreate, `existing: ${existing.join()}`).toBe(false);
    }
  });
});

/**
 * ── ⚠ THE SECOND ORDERING RULE, ADDED WITH THE CHOOSER ────────────────────────────────────
 *
 * `resolveLaunch()` reads the ROOT `userData` — the last-profile pointer and the `profiles/` directory both
 * live there — and `applyProfile()` is the call that redirects that path away. So resolve must come FIRST.
 *
 * Reversed, the symptom would be baffling rather than obvious: inside a profile it would look for
 * `profiles/` and `last-profile.json` INSIDE that profile, find neither, and show the chooser on every single
 * launch while the remembered profile sat unread one directory up.
 */
describe("⚠ index.ts resolves the launch BEFORE redirecting userData", () => {
  const index = readFileSync(join(__dirname, "index.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("calls resolveLaunch before applyProfile", () => {
    const resolved = index.indexOf("resolveLaunch()");
    const applied = index.indexOf("applyProfile(");

    expect(resolved, "resolveLaunch must be called").toBeGreaterThan(-1);
    expect(resolved, "it reads the ROOT userData, which applyProfile replaces").toBeLessThan(applied);
  });

  /**
   * ⚠ AND THE CHOOSER MUST RETURN BEFORE `initDatabase()`. That is the invariant: no profile chosen, no
   * database opened. Without the early return the picker would create and migrate a database for a profile
   * the user has not selected — which is the "default profile as junk drawer" outcome the design rejects.
   */
  it("returns before opening a database when the chooser is showing", () => {
    const guard = index.indexOf("if (launch.showChooser)");
    const db = index.indexOf("initDatabase()");

    expect(guard, "the chooser must be gated explicitly").toBeGreaterThan(-1);
    expect(guard, "and it must come before the database is opened").toBeLessThan(db);
    /* The gate has to RETURN, not merely branch — a fallthrough would open the database anyway. */
    const body = index.slice(guard, db);
    expect(body, "the chooser branch must return").toMatch(/return;/);
  });

  /**
   * ⚠ THE POINTER IS WRITTEN AFTER THE LAUNCH SUCCEEDS, never when the choice is made. Written in the
   * chooser, a profile that fails to start would become the one every later launch returns to — a broken
   * profile with no way out except deleting a file by hand.
   */
  it("remembers the profile only after the chooser gate has passed", () => {
    const guard = index.indexOf("if (launch.showChooser)");
    const remembered = index.indexOf("writeLastProfile(");

    expect(remembered).toBeGreaterThan(-1);
    expect(remembered, "must not be reached in chooser mode").toBeGreaterThan(guard);
  });
});
