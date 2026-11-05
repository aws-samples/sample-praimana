// ── ⚠ THE README'S PREREQUISITES MUST NOT GO STALE ────────────────────────────────────────────
//
// A setup list that is wrong is worse than none: it sends somebody to install Node 22 when the
// toolchain has moved to 24, and they lose an afternoon before doubting the document. Dependency bumps
// are exactly when it would silently drift — nobody re-reads a README while upgrading Electron.
//
// So the numbers in that section are checked against what the packages THEMSELVES declare. Every row
// there names its source for a human; these assertions are the machine's copy of the same check.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const README = readFileSync(local("./../../README.md"), "utf8");
const pkg = JSON.parse(readFileSync(local("./../../package.json"), "utf8")) as {
  build: { mac: { minimumSystemVersion: string } };
  scripts: Record<string, string>;
};

/** An installed dependency's declared `engines.node`, which is the authority for this install. */
function declaredNodeEngine(name: string): string {
  const p = JSON.parse(
    readFileSync(local(`./../../node_modules/${name}/package.json`), "utf8")
  ) as { engines?: { node?: string } };
  return p.engines?.node ?? "";
}

describe("the documented Node floor matches what the toolchain requires", () => {
  it("⚠ states the version ELECTRON declares, since that is the binding constraint", () => {
    /**
     * Electron's floor is the highest of the four that matter (electron, better-sqlite3, vitest, vite),
     * so it is the one the README quotes. If a bump raises it, this fails and the sentence gets updated
     * — which is the entire point of asserting a document.
     */
    const engine = declaredNodeEngine("electron"); // e.g. ">= 22.12.0"
    const version = /(\d+\.\d+\.\d+)/.exec(engine)?.[1];
    expect(version, `could not parse electron's engines.node: "${engine}"`).toBeTruthy();

    expect(README, `the README must state Node >= ${version}`).toContain(`≥ ${version}`);
    // And it must quote the constraint verbatim, so the derivation is checkable by hand too.
    expect(README).toContain(`"${engine}"`);
  });

  it("names the other three floors it claims to have compared", () => {
    // The claim "this is the binding one" is only meaningful if the others were actually looked at.
    for (const dep of ["better-sqlite3", "vitest"]) {
      expect(declaredNodeEngine(dep), `${dep} should declare a node engine`).toBeTruthy();
    }
    expect(README).toContain("better-sqlite3@13");
    expect(README).toContain("vitest@4");
  });

  it("states the minimum macOS from the build config, not from memory", () => {
    const min = pkg.build.mac.minimumSystemVersion; // "12.0"
    expect(README).toContain(min);
    expect(README).toMatch(/macOS.{0,40}12 Monterey/);
  });
});

describe("the platform-specific claims still hold", () => {
  it("⚠ `dev` needs a shell and the CI scripts do not — as the Windows row says", () => {
    /**
     * The README tells a Windows developer that Git Bash is needed for `pnpm dev` but NOT for build,
     * test, lint or type-check. That is a factual claim about `package.json` and it would quietly
     * reverse the day someone wraps `build` in a shell script.
     */
    expect(pkg.scripts.dev).toContain("bash");
    for (const script of ["build", "test", "lint", "type-check"]) {
      expect(pkg.scripts[script], `${script} must not need a shell`).not.toContain("bash");
    }
    expect(README).toMatch(/Git Bash/);
  });

  it("⚠ the framework installer no longer bundles download/extract binaries", () => {
    /**
     * Developer setup used to download a repo zip (`curl.exe`) and extract it (`tar.exe`), which set
     * the Windows 10 1803 floor. The installer now spawns the AI assistant CLI with free-text
     * instructions instead — no curl, no tar — so that rationale is gone and the README must not claim
     * it. If a future change reintroduces a bundled download tool, this fails and the floor/row must be
     * revisited.
     */
    const framework = readFileSync(local("./handlers/framework.ts"), "utf8");
    expect(framework).not.toContain('execFileSync("curl"');
    expect(framework).not.toContain('execFileSync("tar"');
    expect(README, "the stale 1803/curl/tar rationale must be gone").not.toContain("1803");
  });

  it("⚠ the no-compiler claim is still true", () => {
    /**
     * The strongest statement in the section — "no Xcode, no Visual Studio Build Tools, no Python" —
     * and it rests entirely on better-sqlite3 shipping prebuilt binaries. A revert to a per-ABI addon
     * would make it false, and the failure mode is somebody's install dying in node-gyp.
     */
    /**
     * ⚠ ASSERTED AGAINST THE BINARIES ON DISK, not against a word in a manifest. My first version
     * looked for "prebuildify" in better-sqlite3's package.json — it is not there, and the test failed
     * for the right reason: I had asserted the evidence I remembered rather than the evidence I had
     * actually checked. What matters is that a binary for each platform EXISTS, because that is what
     * makes "nothing compiles" true.
     */
    const shipped = readdirSync(local("./../../node_modules/better-sqlite3/prebuilds"));
    for (const platform of ["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64"]) {
      expect(shipped, `${platform} must be prebuilt`).toContain(`${platform}.node`);
      expect(README, `${platform} is claimed as prebuilt`).toContain(platform);
    }
  });

  it("keeps the keychain refusal documented, because it is new behaviour", () => {
    // Sign-in now refuses rather than storing a token in cleartext; without the note the refusal is
    // mystifying on a machine whose keyring is simply not running.
    expect(README).toMatch(/refuses.{0,80}cleartext|cleartext.{0,80}refuse/s);
    expect(README).toContain("safeStorage");
  });
});

describe("the quickstart carries no number that rots", () => {
  it("⚠ does not print a test COUNT next to `pnpm test`", () => {
    /**
     * It used to say "1882 tests (7 skipped)" and the suite is now well past that. A figure that
     * changes with every commit cannot be maintained in prose, and a wrong one undermines the document
     * that the prerequisites above are trying to make trustworthy. The historical
     * "verified at extraction time" line keeps its number deliberately — that one is dated, and true.
     */
    const fence = README.indexOf("```bash");
    const quickstart = README.slice(fence, README.indexOf("```", fence + 7));
    expect(quickstart.length, "the quickstart block must be found").toBeGreaterThan(50);
    expect(quickstart).toMatch(/pnpm test/);
    expect(quickstart, "no live test count in the quickstart").not.toMatch(/pnpm test\s+#.*\d{3,}/);
  });
});
