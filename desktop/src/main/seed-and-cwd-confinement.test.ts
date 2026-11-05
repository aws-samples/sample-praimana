// ── ⚠ THREE PLACES THE BOUNDARY DID NOT HOLD ──────────────────────────────────────────────────
//
// Three cases, each the same shape: a
// value that decides where the app reads, writes or sends a token, checked less strictly than its
// siblings.
//
//   1. the profile SEED's `apiBaseUrl` — validated only for being a non-empty string
//   2. the ACP session's `cwd` — `cwd || process.cwd()`, unconfined and wrongly defaulted
//   3. five git READ handlers — lexical `assertWithinProject`, which follows no symlinks
//
// (1) is the most serious: the deep link's protection for `apiBaseUrl` is the confirmation screen,
// and a seed exists precisely to skip it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

vi.mock("better-sqlite3", () => ({ default: class {} }));
vi.mock("electron", () => ({ app: { getPath: () => "/tmp" }, safeStorage: { isEncryptionAvailable: () => true } }));

/**
 * ⚠ `vi.hoisted`, BECAUSE THE SPY HAS TO EXIST BEFORE THE FACTORY RUNS. The factory is evaluated when
 * `./platform-config` is first imported — which a static import does before any module-level `const`
 * is initialised. Declared here it is observable, so a test can assert WHAT the seed persisted rather
 * than only that it was accepted.
 */
const { writeSetting } = vi.hoisted(() => ({ writeSetting: vi.fn() }));
vi.mock("./database", () => ({
  readSetting: () => null,
  writeSetting,
  getDb: () => ({
    prepare: () => ({ run: () => {}, get: () => undefined, all: () => [] }),
    /* `savePlatformConfig` wraps its eight writes in one transaction — run it straight through. */
    transaction: (fn: () => void) => fn,
  }),
}));

import {
  assertSafeApiOrigin,
  PlatformConfigError,
  consumePlatformSeed,
  configFingerprint,
} from "./platform-config";

describe("⚠ the seed's API origin — where every bearer token goes", () => {
  it("accepts https", () => {
    for (const ok of [
      "https://api.example.com",
      "https://api.example.com/",
      "https://api.example.com:8443",
      "https://sub.domain.example.co.uk/base",
    ]) {
      expect(() => assertSafeApiOrigin(ok), ok).not.toThrow();
    }
  });

  it("REFUSES plain http to a remote host — the attack from this file's own header", () => {
    /**
     * seed { cognito: <the real pool>, apiBaseUrl: "http://attacker.example" } → the participant
     * signs in at genuine AWS, gets a genuine token, and every request thereafter sends that bearer
     * to the attacker. The Cognito checks cannot catch it: sign-in is supposed to succeed.
     */
    for (const bad of ["http://attacker.example", "http://api.example.com", "http://192.168.1.10:4000"]) {
      expect(() => assertSafeApiOrigin(bad), bad).toThrow(PlatformConfigError);
    }
  });

  it("ALLOWS loopback http, because the dev gateway serves it", () => {
    // The local dev gateway serves it. Loopback is not interceptable off-machine, which is what makes this
    // an exception rather than a hole.
    for (const dev of ["http://localhost:4000", "http://127.0.0.1:4000", "http://[::1]:4000"]) {
      expect(() => assertSafeApiOrigin(dev), dev).not.toThrow();
    }
  });

  it("refuses a hostname that merely RESOLVES to loopback", () => {
    // `localtest.me` and friends resolve to 127.0.0.1 but are DNS-controlled by someone else, and
    // over plain http the traffic is interceptable before it ever reaches the resolver's answer.
    for (const bad of ["http://localtest.me:4000", "http://127.0.0.1.evil.test", "http://localhost.evil.test"]) {
      expect(() => assertSafeApiOrigin(bad), bad).toThrow(PlatformConfigError);
    }
  });

  it("refuses non-http schemes outright", () => {
    // `file:` and `data:` would be read by fetch; `javascript:` is nonsense that must not pass.
    for (const bad of ["file:///etc/passwd", "data:text/plain,x", "javascript:alert(1)", "ftp://example.com"]) {
      expect(() => assertSafeApiOrigin(bad), bad).toThrow(PlatformConfigError);
    }
  });

  it("refuses junk that is not a URL at all", () => {
    for (const bad of ["", "   ", "not a url", "//example.com", "example.com"]) {
      expect(() => assertSafeApiOrigin(bad), JSON.stringify(bad)).toThrow(PlatformConfigError);
    }
  });

  it("is actually WIRED INTO the seed check, not merely defined", () => {
    // The failure mode that matters: a validator nobody calls.
    const src = strip(readFileSync(local("./platform-config.ts"), "utf8"));
    const seedCheck = src.slice(src.indexOf("function assertSeededConfig"));
    const body = seedCheck.slice(0, seedCheck.indexOf("\n}"));
    expect(body).toContain("assertSafeApiOrigin(config.apiBaseUrl)");
    // And the Cognito hosts are still checked — this adds to that, it does not replace it.
    expect(body).toContain("assertAwsDiscoveryHost(config.cognito.issuer");
  });
});

// ── ⚠ THE OTHER TWO CHECKS THE SEED PATH SKIPPED ──────────────────────────────────────────────
//
// The origin above was the first of three. The other two are
// the pool IDENTITY and the drift fingerprint, and neither is caught by a host check:
//
//   - `poolId` was validated only for being a non-empty string, and the issuer↔pool tie that
//     `validateDiscovery` applies was not applied at all. So the seed could name an ATTACKER'S OWN
//     Cognito pool — a real pool on a real AWS host — and that pool and client id are handed to
//     Amplify in the renderer, where THIS APP'S OWN SRP FORM collects email, password and TOTP.
//     `assertAwsDiscoveryHost` cannot see it: signing in against the attacker's pool is *supposed*
//     to succeed.
//   - `savePlatformConfig(parsed)` persisted the seed's OWN `fingerprint`, so `checkPlatformDrift`
//     compared the attacker's value against itself and reported no drift — the hostile seed
//     suppressing the detector that exists to notice it.
describe("⚠ the seed's pool identity and its drift fingerprint", () => {
  const POOL = "eu-west-1_AbCdEf123";
  const ISSUER = `https://cognito-idp.eu-west-1.amazonaws.com/${POOL}`;

  /** A seed that passes every check, as a base for the cases that break one thing. */
  const goodSeed = () => ({
    poolId: POOL,
    region: "eu-west-1",
    apiBaseUrl: "https://api.example.com",
    cognito: {
      issuer: ISSUER,
      clientId: "client-123",
      authorizationEndpoint: "https://example.auth.eu-west-1.amazoncognito.com/oauth2/authorize",
      tokenEndpoint: "https://example.auth.eu-west-1.amazoncognito.com/oauth2/token",
      scopes: ["openid", "email", "profile"],
    },
    fingerprint: "whatever-the-file-says",
  });

  let dir = "";
  beforeEach(() => {
    writeSetting.mockClear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const seed = (value: unknown) => {
    fs.writeFileSync(path.join(dir, "platform-seed.json"), JSON.stringify(value));
    return consumePlatformSeed(dir);
  };

  /** What `writeSetting` was asked to store for one platform key. */
  const stored = (key: string) =>
    writeSetting.mock.calls.filter((c) => c[0] === key).map((c) => c[1])[0];

  it("adopts a seed that passes every check", () => {
    expect(seed(goodSeed())).toBe(true);
    expect(stored("cognito_pool_id")).toBe(POOL);
  });

  it("REFUSES a malformed pool id", () => {
    expect(seed({ ...goodSeed(), poolId: "x/../evil" })).toBe(false);
    expect(writeSetting, "nothing may be persisted").not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE ATTACK THE HOST CHECKS CANNOT SEE. Both values below are legitimate AWS Cognito strings;
   * they simply describe a DIFFERENT pool from the one the seed claims to be for.
   */
  it("REFUSES an issuer that names a different pool", () => {
    expect(
      seed({
        ...goodSeed(),
        cognito: {
          ...goodSeed().cognito,
          issuer: "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_AttackerXX",
        },
      })
    ).toBe(false);
    expect(writeSetting).not.toHaveBeenCalled();
  });

  /**
   * ⚠ AND THE FINGERPRINT IS DERIVED, NOT BELIEVED. It is a statement ABOUT the other fields, so a
   * seed that supplies its own turns the drift check into a comparison of one value with itself.
   */
  it("recomputes the fingerprint instead of storing the one the file supplied", () => {
    expect(seed(goodSeed())).toBe(true);

    const expected = configFingerprint({
      poolId: POOL,
      apiBaseUrl: "https://api.example.com",
      issuer: ISSUER,
      clientId: "client-123",
      authorizationEndpoint: goodSeed().cognito.authorizationEndpoint,
    });
    expect(stored("platform_config_fingerprint")).toBe(expected);
    expect(stored("platform_config_fingerprint")).not.toBe("whatever-the-file-says");
  });
});

describe("⚠ the ACP session's working directory", () => {
  const ACP = strip(readFileSync(local("./handlers/kiro-acp.ts"), "utf8"));

  it("no longer defaults to process.cwd()", () => {
    /**
     * In a packaged app `process.cwd()` is wherever the app was launched from — `/` when opened from
     * Finder. Not a project, and not usable; the old expression was wrong even before the security
     * question.
     */
    expect(ACP).not.toContain("cwd: cwd || process.cwd()");
    expect(ACP).not.toContain("process.cwd()");
  });

  it("confines both session/new and session/load through one resolver", () => {
    expect((ACP.match(/cwd: this\.confinedSessionCwd\(cwd\)/g) ?? []).length).toBe(2);
    expect(ACP).toMatch(/private confinedSessionCwd\(requested\?: string\): string \{/);
  });

  it("falls back to the configured project rather than throwing on an absent cwd", () => {
    /**
     * `kiroAcp:newSession` passes `params?.cwd`, which is normally undefined — so `confineCwd`'s
     * throw-on-unusable behaviour (right for a process spawn) would break starting a session at all.
     * The fallback is read from settings in MAIN, and still goes through confinement.
     */
    const fn = ACP.slice(ACP.indexOf("private confinedSessionCwd"));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    expect(body).toContain('getSetting("project_path")');
    expect(body).toMatch(/return confineCwd\(projectPath\)/);
    expect(body).toMatch(/if \(requested\) return confineCwd\(requested\)/);
  });
});

describe("⚠ the git READ handlers follow symlinks now", () => {
  const GIT = strip(readFileSync(local("./handlers/git.ts"), "utf8"));

  it("uses the real-path check everywhere, with the lexical one gone", () => {
    /**
     * `assertWithinProject` resolves `..` but follows no symlinks, so `<project>/link-to-elsewhere`
     * passed it while naming a repo outside the project — and a repo's log, diff and branch names
     * are exactly the content this boundary keeps in. The write side was hardened earlier; these
     * five reads were left behind.
     */
    expect(GIT, "no lexical checks left").not.toContain("assertWithinProject(");
    const guarded = GIT.match(/assertRealPathWithinProject\(repoPath, \{ mustExist: true \}\)/g) ?? [];
    // 5 reads (isRepo, log, status, diff, branches) + listUploadable + the pre-existing writers.
    expect(guarded.length).toBeGreaterThanOrEqual(6);
  });

  it("guards every git handler, not most of them", () => {
    // Counted against the handlers themselves, so a NEW unguarded handler fails this.
    const handlers = GIT.match(/ipcMain\.handle\("git:[a-zA-Z]+"/g) ?? [];
    const guards = GIT.match(/assertRealPathWithinProject\(/g) ?? [];
    expect(handlers.length).toBeGreaterThan(5);
    expect(guards.length).toBeGreaterThanOrEqual(handlers.length);
  });
});

/**
 * ── ⚠ AND THE SYMLINK ESCAPE, RUN FOR REAL ────────────────────────────────────────────────────
 *
 * The source assertions above say which function is called; this proves the function actually
 * refuses the thing. Real directories, a real symlink, no mocks — because "does the guard follow a
 * symlink?" is a filesystem question and every previous attempt to reason about it in this codebase
 * got it wrong at least once.
 */
describe("the real-path guard, against a real symlink", () => {
  let tmp = "";
  let project = "";
  let outside = "";

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gitguard-"));
    project = path.join(tmp, "project");
    outside = path.join(tmp, "elsewhere");
    fs.mkdirSync(project);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(project, "escape"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("a lexical check passes the escape, and the real-path check does not", async () => {
    vi.resetModules();
    vi.doMock("./database", () => ({
      // The project root, as `allowedRoots()` derives it.
      readSetting: (key: string) => (key === "project_path" ? project : null),
      writeSetting: vi.fn(),
      getDb: () => ({ prepare: () => ({ run: () => {}, get: () => undefined, all: () => [] }) }),
    }));
    const { isWithinProject, isRealPathWithinProject } = await import("./project-paths");

    const escape = path.join(project, "escape");
    // Lexically it is inside the project — this is exactly why the weaker check was not enough.
    expect(isWithinProject(escape), "lexically inside").toBe(true);
    // Following the link lands outside it.
    expect(isRealPathWithinProject(escape), "really outside").toBe(false);
  });
});
