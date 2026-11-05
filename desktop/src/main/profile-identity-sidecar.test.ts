// ── ⚠ THE PROFILE↔IDENTITY BINDING, AGAINST A REAL FILESYSTEM ───────────────────────────────────
//
// There was no reason, and the sidecar is the better home. The binding started as a per-profile SETTINGS row,
// which put it in the one place the PROFILE CHOOSER cannot read: that screen opens no database by design
// (ProfileChooser's header and profile.ts's sidecar note both state the invariant). So the list could show a
// profile's label and team and NOT the address that works in it — and for two profiles of one deployment
// that address is the only thing telling them apart. The reporter's `…-codevibranium` and `…-jarvisdeploy`
// share a pool, a client, an API origin and a portal.
//
// ── ⚠ WHY THIS FILE USES A REAL TEMP DIRECTORY ──
//
// `profile.test.ts` mocks `app.getPath` to a fixed string, which is right for `sanitiseProfileName` and the
// ordering assertions and useless here: whether a merge preserves `label`, whether clearing removes a key
// rather than writing `""`, and whether an unparseable file fails OPEN are all properties of bytes on disk.
// Every previous round of this bug was a wrong assumption about where a record lives and what erases it, so
// this one is measured.
//
// ⚠ AND NOTHING ELSE COVERED IT. Moving the storage out of the database broke no test, because every suite
// that touches this mocks `../accounts` wholesale — so the real read/write path had no coverage at all. That
// silence is the reason this file exists.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * One root for the whole file. `rootDir()` captures `userData` on its FIRST call and keeps it — correct in
 * production, where the path is fixed before anything reads it — so a per-test directory would be captured
 * once and then silently ignored.
 */
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "profile-sidecar-")));

vi.mock("electron", () => ({
  app: { getPath: () => ROOT, setPath: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const {
  readActiveProfileIdentity,
  writeActiveProfileIdentity,
  clearActiveProfileIdentity,
  writeProfileMeta,
  listProfiles,
  profileDir,
  DEFAULT_PROFILE_ID,
} = await import("./profile");

const META = () => path.join(ROOT, "profile.json");
const readMetaRaw = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(META(), "utf8")) as Record<string, unknown>;

beforeEach(() => {
  fs.rmSync(META(), { force: true });
  fs.rmSync(path.join(ROOT, "profiles"), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, "praimana.db"), { force: true });
});

afterEach(() => {
  fs.rmSync(META(), { force: true });
});

describe("the active profile's identity binding", () => {
  it("is absent before anyone has signed in", () => {
    expect(readActiveProfileIdentity()).toBeNull();
  });

  it("records an address and reads it back lower-cased", () => {
    writeActiveProfileIdentity("Owner@Example.COM");
    expect(readActiveProfileIdentity()).toBe("owner@example.com");
    expect(readMetaRaw().identityEmail).toBe("owner@example.com");
  });

  it("trims surrounding space, so a stray paste is the same identity", () => {
    writeActiveProfileIdentity("  owner@example.com  ");
    expect(readActiveProfileIdentity()).toBe("owner@example.com");
  });

  /**
   * ⚠ FIRST WRITER WINS. A profile belongs to whoever established it, not to the most recent visitor — a
   * binding that followed the latest sign-in would guard nothing, since the wrong sign-in is the event it
   * exists to refuse.
   */
  it("⚠ does not re-bind to a later address", () => {
    writeActiveProfileIdentity("owner@example.com");
    writeActiveProfileIdentity("someone.else@example.com");
    expect(readActiveProfileIdentity()).toBe("owner@example.com");
  });

  it("ignores an empty or non-string address rather than binding to nothing", () => {
    writeActiveProfileIdentity("");
    writeActiveProfileIdentity("   ");
    expect(readActiveProfileIdentity()).toBeNull();
    expect(fs.existsSync(META()), "and writes no file for a no-op").toBe(false);
  });

  /**
   * ⚠ MERGED, NOT CLOBBERED. `label`, `team` and `lastUsedAt` are what the chooser renders, and a binding
   * write that dropped them would blank every row's name — the failure would show up as a cosmetic
   * regression somewhere else entirely.
   */
  it("⚠ preserves the display fields it shares the file with", () => {
    writeProfileMeta(DEFAULT_PROFILE_ID, { label: "Code Vibranium", team: "Team A" });

    writeActiveProfileIdentity("owner@example.com");

    const raw = readMetaRaw();
    expect(raw.label).toBe("Code Vibranium");
    expect(raw.team).toBe("Team A");
    expect(raw.identityEmail).toBe("owner@example.com");
  });

  /**
   * ⚠ CLEARING REMOVES THE KEY, rather than storing `""`. An empty string would read back as "bound to
   * nothing", and every consumer would then need to know that `""` is not an identity — the kind of
   * distinction that holds until one caller forgets it.
   */
  it("⚠ releases by removing the key, keeping the rest of the file", () => {
    writeProfileMeta(DEFAULT_PROFILE_ID, { label: "Code Vibranium" });
    writeActiveProfileIdentity("owner@example.com");

    clearActiveProfileIdentity();

    expect(readActiveProfileIdentity()).toBeNull();
    const raw = readMetaRaw();
    expect("identityEmail" in raw, "absent, not empty").toBe(false);
    expect(raw.label, "and the label is untouched").toBe("Code Vibranium");
  });

  it("can be re-bound after a release, which is what a platform change means", () => {
    writeActiveProfileIdentity("owner@example.com");
    clearActiveProfileIdentity();

    writeActiveProfileIdentity("different-experience@example.com");

    expect(readActiveProfileIdentity()).toBe("different-experience@example.com");
  });
});

describe("⚠ it fails OPEN, because the alternative locks someone out of their own workspace", () => {
  /**
   * The binding gates a sign-in (`isForeignToProfile`), so every unreadable state has to mean "no binding"
   * rather than "refuse". profile.ts's own note says so; these are the cases that prove it.
   */
  it("treats an unparseable file as no binding", () => {
    fs.writeFileSync(META(), "{ this is not json");
    expect(readActiveProfileIdentity()).toBeNull();
  });

  it("treats a file whose identityEmail is the wrong type as no binding", () => {
    fs.writeFileSync(META(), JSON.stringify({ identityEmail: { not: "a string" } }));
    expect(readActiveProfileIdentity()).toBeNull();
  });

  it("treats JSON that is not an object as no binding", () => {
    fs.writeFileSync(META(), JSON.stringify(["owner@example.com"]));
    expect(readActiveProfileIdentity()).toBeNull();
  });
});

describe("⚠ the chooser can see it, which is the whole reason it moved", () => {
  /**
   * `listProfiles` is what `profile:list` returns and what ProfileChooser renders. It reads the sidecar and
   * NO database — so this is the assertion that the binding is reachable from the one screen that has to
   * distinguish two profiles of the same deployment.
   */
  it("surfaces identityEmail for a named profile", () => {
    writeProfileMeta("jarvisdeploy", {
      label: "Jarvis Deploy",
      team: "Jarvis",
      identityEmail: "owner@example.com",
    });

    const listed = listProfiles().find((p) => p.id === "jarvisdeploy");

    expect(listed, "the profile must be listed at all").toBeTruthy();
    expect(listed!.identityEmail).toBe("owner@example.com");
    expect(listed!.team).toBe("Jarvis");
  });

  it("surfaces it for the default profile too, which is a directory-less sentinel", () => {
    // The default entry is listed only when the root install has data — its own documented rule.
    fs.writeFileSync(path.join(ROOT, "praimana.db"), "");
    writeProfileMeta(DEFAULT_PROFILE_ID, { label: "Default", identityEmail: "owner@example.com" });

    const listed = listProfiles().find((p) => p.id === DEFAULT_PROFILE_ID);

    expect(listed?.identityEmail).toBe("owner@example.com");
  });

  it("omits the field entirely for a profile that has never signed in", () => {
    writeProfileMeta("fresh", { label: "Fresh" });

    const listed = listProfiles().find((p) => p.id === "fresh");

    expect(listed).toBeTruthy();
    expect("identityEmail" in listed!, "no key rather than an empty one").toBe(false);
  });

  /** The sidecar is owner-only, like the database beside it — an email is still not for other accounts. */
  it("writes 0600, matching the rest of the store", () => {
    if (process.platform === "win32") return;
    writeActiveProfileIdentity("owner@example.com");
    expect(fs.statSync(META()).mode & 0o077, "no group or world bits").toBe(0);
  });

  it("writes into the profile's own directory, not the root, for a named profile", () => {
    writeProfileMeta("jarvisdeploy", { identityEmail: "owner@example.com" });
    expect(fs.existsSync(path.join(profileDir("jarvisdeploy"), "profile.json"))).toBe(true);
  });
});
