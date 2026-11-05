// ── ⚠ THE WINDOWS BUILD VERIFIES ITS TOOLCHAIN BEFORE IT RUNS IT ──────────────────────────────
//
// The install phase fetched a zip from nodejs.org and expanded it straight into C:\node22, with only
// Test-Path on node.exe and a Node-major assertion afterwards — both of which a tampered-but-extractable
// archive passes. That directory is then first on $env:PATH in every later phase and runs pnpm install,
// rebuild-native, build and electron-builder, so whatever is in the zip has arbitrary code execution on
// the host that produces the customer-facing installer.
//
// ⚠ WHY THIS IS A TEST. The buildspec is not executed by any suite — it runs on a Windows CodeBuild
// image nothing here can reach — so the ONLY guard against somebody bumping the version pin and
// dropping the digest, or reordering the block, is an assertion that reads the file.
//
// ⚠ IT ASSERTS ON COMMANDS, NEVER ON COMMENTS. Every check below runs against the buildspecs with
// comment lines removed, so editing or deleting a buildspec's comments can neither break this suite
// nor satisfy it by accident — only a change to what the build actually executes can.
//
// ⚠ WHAT THIS DOES NOT ESTABLISH: that the PowerShell is correct. There is no PowerShell in this
// environment, so the block was reviewed and YAML-validated rather than run. What IS independently
// established is the pinned digest itself: it was taken from nodejs.org's SHASUMS256.txt and then
// confirmed against a fresh download of the archive.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Read a buildspec next to package.json. */
const readBuildspec = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), "utf8");

/**
 * The buildspec with every comment line removed: YAML comments and the `#` comments inside the
 * embedded bash/PowerShell scripts alike. What is left is exactly what the build executes.
 */
const commandsOnly = (src: string) =>
  src
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

const WIN = commandsOnly(readBuildspec("buildspec-win.yml"));
const MAC = commandsOnly(readBuildspec("buildspec-mac.yml"));

/** The install block that fetches and unpacks the toolchain. */
const toolchainBlock = (() => {
  const start = WIN.indexOf('$ver = "v');
  expect(start, "the version-pinned install block must exist").toBeGreaterThan(-1);
  return WIN.slice(start, WIN.indexOf("& \"$dest\\node.exe\" --version", start));
})();

describe("⚠ the Node toolchain is checksum-verified", () => {
  it("hashes the downloaded archive", () => {
    expect(toolchainBlock).toMatch(/Get-FileHash\s+-Algorithm\s+SHA256/);
  });

  it("pins a real-looking sha256 beside the version", () => {
    const pin = toolchainBlock.match(/\$sha256\s*=\s*"([0-9a-f]{64})"/);
    expect(pin, "a 64-character lowercase hex digest, or the comparison is meaningless").toBeTruthy();
  });

  /**
   * ⚠ THE ORDERING IS THE CONTROL. A checksum computed after `Expand-Archive` verifies nothing — the
   * archive has already been unpacked onto the PATH the next phase uses.
   */
  it("⚠ verifies BEFORE it extracts", () => {
    const hash = toolchainBlock.indexOf("Get-FileHash");
    const compare = toolchainBlock.indexOf("-ne $sha256");
    const extract = toolchainBlock.indexOf("Expand-Archive");

    expect(hash).toBeGreaterThan(-1);
    expect(compare, "the hash must actually be compared, not just computed").toBeGreaterThan(hash);
    expect(extract, "and both must precede extraction").toBeGreaterThan(compare);
  });

  it("⚠ fails the build on a mismatch rather than warning", () => {
    const compare = toolchainBlock.indexOf("-ne $sha256");
    const extract = toolchainBlock.indexOf("Expand-Archive");
    const block = toolchainBlock.slice(compare, extract);

    expect(block, "a mismatch must stop the build").toContain("exit 1");
  });

  it("does not leave a rejected archive on the build host", () => {
    const compare = toolchainBlock.indexOf("-ne $sha256");
    const extract = toolchainBlock.indexOf("Expand-Archive");
    expect(toolchainBlock.slice(compare, extract)).toMatch(/Remove-Item/);
  });

  /**
   * ⚠ THE COUPLING IS DELIBERATE, so the failure has to explain itself. Bumping `$ver` without
   * `$sha256` is the expected way for this to fire, and a bare "checksum mismatch" on a deliberate
   * version bump costs somebody a confusing ten minutes.
   */
  it("tells whoever bumped the version what to do", () => {
    const compare = toolchainBlock.indexOf("-ne $sha256");
    const extract = toolchainBlock.indexOf("Expand-Archive");
    expect(toolchainBlock.slice(compare, extract)).toMatch(/SHASUMS256\.txt/);
  });

  /**
   * ⚠ `$ErrorActionPreference = "Stop"` MUST NEVER APPEAR IN THE WINDOWS BUILDSPEC. CodeBuild restores
   * the PowerShell session between commands with Set-Variable over read-only automatics, and "Stop"
   * turns that non-terminating error into a build failure whose own commands all succeeded.
   */
  it("never sets $ErrorActionPreference to Stop", () => {
    expect(WIN).not.toMatch(/\$ErrorActionPreference\s*=\s*["']Stop["']/);
  });
});

/**
 * The electron-builder config, read as data rather than text: the signing invariants below are
 * split between the buildspec (which runs electron-builder) and package.json (which owns
 * mac.notarize and the Windows signtool options).
 */
const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")
) as {
  build: {
    mac: { notarize: boolean };
    win: { signtoolOptions: { signingHashAlgorithms: string[] } };
  };
};

/**
 * ── ⚠ EVERY PUBLISHED INSTALLER CARRIES A DIGEST, AND IT MUST NOT BE A SIBLING OBJECT ──────────
 *
 * Publication verified only byte LENGTH, so a substituted object of the same size passed, and no digest
 * existed anywhere for a downloader to check an installer against.
 *
 * ⚠ THE `.sha256`-SIBLING ASSERTION IS THE ONE THAT MATTERS MOST HERE, and it is a REGRESSION guard
 * rather than a style rule. `services/desktop`'s `latest()` lists everything under
 * `desktop/<platform>/`, filters only the folder placeholder, and presigns the NEWEST BY LastModified.
 * A `<artifact>.sha256` uploaded after its installer therefore becomes the newest object and the
 * download button serves ~90 bytes of hex instead of the app. That is the obvious way to implement
 * a digest and it silently breaks every participant's download, so it is pinned here.
 */
describe("⚠ published installers carry a verifiable digest", () => {
  for (const [name, src, hashCall] of [
    ["mac", MAC, /shasum -a 256/],
    ["windows", WIN, /Get-FileHash -Algorithm SHA256 -LiteralPath/],
  ] as const) {
    it(`${name}: computes a sha256 for each artifact`, () => {
      expect(src).toMatch(hashCall);
    });

    it(`${name}: puts it in the object's own metadata`, () => {
      expect(src, "the digest must travel with the object").toMatch(/--metadata "[^"]*sha256=\$/);
    });

    it(`${name}: ⚠ does NOT upload a sibling .sha256 object`, () => {
      // The head-object query is the legitimate reader of the metadata, not a sibling key.
      const code = src.replace(/Metadata\.sha256/g, "");
      expect(code, "a sibling object would become the newest and be served as the installer").not.toMatch(
        /\.sha256/
      );
    });

    it(`${name}: reads the digest back and fails the build if it is absent`, () => {
      // A digest silently dropped by the upload is worse than none: it reads as verified.
      expect(src).toMatch(/Metadata\.sha256/);
      expect(src).toMatch(/FATAL: sha256 metadata missing or wrong/);
    });
  }

  /**
   * ⚠ THIS SAMPLE SHIPS UNSIGNED, BY DESIGN. There is no bundled code-signing identity; users
   * who want signed builds wire in their own certificate through electron-builder's built-in
   * support (documented in desktop/README.md, "Code signing"). These tests pin the unsigned path
   * so a stray signing hook, or a notarize flag that fails an unsigned build, goes red.
   */
  describe("⚠ macOS builds unsigned, with built-in signing left to the user", () => {
    it("does not pass any -c.mac.sign / identity / afterAllArtifactBuild hook", () => {
      expect(MAC).not.toContain("-c.mac.sign");
      expect(MAC).not.toContain("-c.mac.identity");
      expect(MAC).not.toContain("-c.afterAllArtifactBuild");
    });

    it("keeps mac.notarize false and declares no afterSign hook", () => {
      // notarize:true with no credentials fails the build; a user enabling signing flips this
      // back deliberately. afterSign must be absent — the notarize hook script is not shipped.
      expect(PKG.build.mac.notarize, "true here fails an unsigned build").toBe(false);
      expect(PKG.build).not.toHaveProperty("afterSign");
    });

    it("sets CSC_IDENTITY_AUTO_DISCOVERY=false so the build does not hunt the keychain", () => {
      // With no identity meant to be used, this stops electron-builder failing on an ambiguous
      // or absent certificate. Exactly one occurrence on the single (unsigned) build path.
      const occurrences = MAC.match(/^\s*export CSC_IDENTITY_AUTO_DISCOVERY=false$/gm) ?? [];
      expect(occurrences).toHaveLength(1);
    });

    it("warns in the build log that the unsigned dmg is Gatekeeper-blocked", () => {
      expect(MAC).toMatch(/UNSIGNED dmg/);
      expect(MAC).toMatch(/xattr -dr com\.apple\.quarantine/);
    });
  });

  describe("⚠ Windows builds unsigned, with built-in signing left to the user", () => {
    it("does not pass a custom sign hook or reference a removed signing script", () => {
      expect(WIN).not.toContain("signtoolOptions.sign=");
      expect(WIN).not.toMatch(/sign-win\.js|WIN_SIGNER/);
    });

    /**
     * ⚠ THE sha256 PIN STAYS EVEN WHILE UNSIGNED. WindowsSignToolManager loops over
     * signingHashAlgorithms and signs once per hash, defaulting a .exe to ["sha1","sha256"].
     * A user who enables signing with their own certificate should make one signtool pass per
     * file, not two — and SHA-1 Authenticode is distrusted — so the pin is kept regardless.
     */
    it("pins signingHashAlgorithms to sha256 only", () => {
      expect(PKG.build.win.signtoolOptions.signingHashAlgorithms).toEqual(["sha256"]);
    });

    it("says in the build log that unsigned installers are a SmartScreen warning, not a block", () => {
      // The asymmetry with macOS matters when deciding what is shippable: Gatekeeper refuses an
      // unsigned dmg outright, SmartScreen only warns.
      expect(WIN).toMatch(/warning, not a block/);
    });
  });
});
