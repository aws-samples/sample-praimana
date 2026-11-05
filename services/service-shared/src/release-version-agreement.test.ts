import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { siblingRepoPath } from "./sibling-repo.js";

/**
 * ── ⚠ ONE RELEASE, ONE SPELLING, ACROSS TWO APP TIERS ───────────────────────────────────────────
 *
 * `platform-api.yaml` takes `ReleaseVersion` and `platform-portal.yaml` takes
 * `PortalReleaseVersion`. Previously they denoted the SAME release in two different forms:
 * the API's pattern required a leading `v` (`v0.6.13`) and the portal's forbade one (`0.6.13`),
 * because the API's S3 layout is `lambda/v<version>/` and the portal's is `portal/<version>/`.
 *
 * ⚠ THAT IS NOT A COSMETIC INCONSISTENCY, AND IT COST A RELEASE. The API tier was once
 * deployed at `v0.6.12` while the portal was at `0.6.13`. Every deploy reported success, because
 * a stale version is a working deploy of the wrong code — `buildspec-publish.yml` says exactly
 * this, and records an earlier drift of FOUR versions. The two spellings are what made the gap
 * hard to see at a glance: `v0.6.12` beside `0.6.13` does not read as "one release behind".
 *
 * The fix moved the `v` out of the parameter and into the KEY: both tiers now take bare semver,
 * and `platform-api.yaml` writes the literal `v` into its own thirteen CodeUri keys. So the
 * bucket layout is untouched and the value a human types is identical for both tiers.
 *
 * ⚠ WHY A TEST, AND WHY IN THIS REPO. Nothing in a unit test can observe which release an account
 * has deployed. What CAN be observed is whether the two templates still AGREE — on the form of the
 * version, on which release they default to, and on the key layout this repo's publisher writes
 * to. Every way those three drift apart is structural and deploys cleanly, which is the category
 * this repo's cross-repo template tests exist for.
 *
 * ⚠ THIS FILE READS THE TIER TEMPLATES DIRECTLY, NOT VIA `infrastructureTemplateText()`. That
 * helper resolves `aws/app/platform-all-in-one.yaml`, which NO LONGER EXISTS — the infrastructure
 * repo was split into seven tier templates and the all-in-one was deleted. Its own header warns
 * that this is the failure mode to check for first ("IF THIS GOES QUIET AGAIN, THE PATH IS THE
 * FIRST THING TO CHECK"), and it has gone quiet again: seven test files' worth of assertions are
 * currently inert for that reason. Routing THIS file through the same helper would have made it
 * inert on the day it was written. Repointing the helper across seven templates is a separate
 * change, deliberately not bundled here.
 */

const apiPath = siblingRepoPath("infrastructure", "aws", "app", "platform-api.yaml");
const portalPath = siblingRepoPath("infrastructure", "aws", "app", "platform-portal.yaml");
/**
 * ⚠ THE IDENTITY TIER WAS MISSED, AND THAT IS WHY IT IS LISTED HERE BY NAME. When the `v` moved
 * out of the parameter this file asserted only api + portal, so it passed green
 * while platform-identity.yaml still required `v0.6.12` for the same release - three tiers, two
 * spellings, which is the exact defect the change removed from the other two. It surfaced
 * during a deploy. A test that covers a subset of the tiers cannot see drift in
 * the tier it omits, so ANY new tier taking a release version belongs in TIERS below.
 */
const identityPath = siblingRepoPath("infrastructure", "aws", "app", "platform-identity.yaml");

const HAS_TEMPLATES =
  existsSync(apiPath) && existsSync(portalPath) && existsSync(identityPath);

/** Empty string rather than null when absent, for the reason `infrastructureTemplateText` documents. */
const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

const API = read(apiPath);
const PORTAL = read(portalPath);
const IDENTITY = read(identityPath);

/** Every tier that names a release, with the parameter each one calls it. */
const TIERS = [
  { name: "platform-api.yaml", text: () => API, param: "ReleaseVersion" },
  { name: "platform-portal.yaml", text: () => PORTAL, param: "PortalReleaseVersion" },
  { name: "platform-identity.yaml", text: () => IDENTITY, param: "ReleaseVersion" },
] as const;

const TEMPLATES_ABSENT_TODO =
  `is checked once the app tier templates exist at ${apiPath}, ${portalPath} and ${identityPath} — ` +
  `override the root with AIAP_INFRASTRUCTURE_REPO`;

/** The bare-semver pattern both tiers must constrain their version parameter to. */
const BARE_SEMVER_PATTERN = String.raw`"^[0-9]+\\.[0-9]+\\.[0-9]+$"`;

/**
 * Reads a parameter's `AllowedPattern` and `Default` out of a template's Parameters block.
 *
 * Deliberately textual rather than a YAML parse: these templates carry SAM shorthand
 * (`!Sub`, `!GetAtt`) that a plain YAML loader rejects, and every other template test in this
 * repo is textual for the same reason.
 */
function versionParameter(template: string, name: string): { pattern?: string; default?: string } {
  // The parameter's own block: from `  <Name>:` to the next top-level-indented key.
  const block = new RegExp(`^  ${name}:\\n(?:(?: {4,}.*)?\\n)*`, "m").exec(template)?.[0] ?? "";  // nosemgrep: detect-non-literal-regexp,missing-template-string-indicator
  return {
    pattern: /^\s*AllowedPattern:\s*(.+?)\s*$/m.exec(block)?.[1],
    default: /^\s*Default:\s*"?([0-9]+\.[0-9]+\.[0-9]+)"?\s*$/m.exec(block)?.[1],
  };
}

describe.skipIf(!HAS_TEMPLATES)("every app tier spells a release the same way", () => {
  it("each version parameter constrains to BARE semver, with no leading v", () => {
    for (const tier of TIERS) {
      const p = versionParameter(tier.text(), tier.param);
      // Located at all — a rename would otherwise make every assertion below vacuously pass.
      expect(p.pattern, `${tier.name}: ${tier.param} has no AllowedPattern`).toBeDefined();
      expect(p.pattern, `${tier.name}: ${tier.param} is not bare semver`).toBe(BARE_SEMVER_PATTERN);
    }
  });

  it("no pattern admits a leading v, which would let both forms coexist again", () => {
    for (const tier of TIERS) {
      // `^v?...` would be the tempting "accept both" relaxation. It reintroduces the ambiguity:
      // two spellings of one release, and no way to tell a typo from a convention.
      const { pattern } = versionParameter(tier.text(), tier.param);
      expect(pattern, `${tier.name}: ${tier.param} admits an optional v`).not.toMatch(/\^v\??/);
    }
  });

  it("all tiers DEFAULT to the same release", () => {
    /**
     * This is the assertion that would have caught the version gap described above. The tiers are separate
     * stacks and separate repos, but the platform ships them as ONE release, and a customer
     * deploying the published templates unmodified gets every default.
     *
     * ⚠ IF THIS FAILS AFTER AN INTENTIONAL SPLIT, the fix is to change the templates together,
     * not to delete this test. A tier pinned to an older release on purpose is a decision worth
     * writing down in the template.
     */
    const defaults = TIERS.map((tier) => {
      const d = versionParameter(tier.text(), tier.param).default;
      expect(d, `${tier.name}: ${tier.param} has no bare-semver Default`).toBeDefined();
      return { name: tier.name, value: d };
    });
    const distinct = [...new Set(defaults.map((d) => d.value))];
    expect(
      distinct.length,
      `tiers disagree on the release: ${defaults.map((d) => `${d.name}=${d.value}`).join(", ")}`,
    ).toBe(1);
  });
});

describe.skipIf(!HAS_TEMPLATES)("the v lives in the KEY, and this repo puts one there too", () => {
  it("every CodeUri key prefixes a literal v onto the version", () => {
    const keys = [...API.matchAll(/Key: !Sub "lambda\/(v?)\$\{ReleaseVersion\}\//g)];

    // Thirteen functions today; asserted as "some" rather than an exact count so that adding a
    // service does not fail this test for the wrong reason. The `every` below is the real check.
    expect(keys.length, "no lambda CodeUri keys found — did the Key shape change?").toBeGreaterThan(0);
    for (const [match, v] of keys) {
      expect(v, `key is missing the literal v: ${match}`).toBe("v");
    }
  });

  it("the publisher writes the same prefix the template reads", () => {
    /**
     * `buildspec-publish.yml` builds `VERSION="v$RAW"` and uploads to
     * `${LAMBDA_PREFIX}${VERSION}/`. If that `v` were dropped here while the template kept
     * prefixing one, every function's CodeUri would point at a key that does not exist and the
     * stack update would fail on a missing object — after the publish reported success.
     */
    const buildspec = readFileSync(new URL("../../buildspec-publish.yml", import.meta.url), "utf8");
    expect(buildspec).toMatch(/VERSION="v\$RAW"/);
  });

  it("the publisher's guard validates the BARE version, matching the stack's pattern", () => {
    /**
     * The guard exists so a bad version fails in the pipeline rather than as an opaque
     * parameter-validation error at CreateChangeSet. That only holds if it validates the same
     * string a deployer passes — the bare one — against the same pattern the stack enforces.
     */
    const buildspec = readFileSync(new URL("../../buildspec-publish.yml", import.meta.url), "utf8");
    expect(buildspec).toMatch(/echo "\$RAW" \| grep -Eq '\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$'/);
    // And it must NOT be checking the v-prefixed form, which would accept what the stack rejects.
    expect(buildspec).not.toMatch(/echo "\$VERSION" \| grep -Eq '\^v/);
  });

  it("tells the deployer a bare version, so the hint can be pasted as-is", () => {
    const buildspec = readFileSync(new URL("../../buildspec-publish.yml", import.meta.url), "utf8");
    // The published manifest and the closing log line are the two places a human copies from.
    expect(buildspec).toMatch(/deployWith: "ReleaseVersion=" \+ process\.env\.RAW/);
    expect(buildspec).toMatch(/Deploy it with: ReleaseVersion=\$RAW/);
  });
});

/**
 * ⚠ DECLARED ONLY WHEN THE TEMPLATES ARE MISSING, not gated with `skipIf`. Vitest counts an
 * `it.todo` as a todo even inside a skipped `describe`, so the `skipIf` form reported "1 todo" on
 * a complete checkout where every assertion above had actually RUN. In this repo a todo is the
 * signal that cross-repo assertions went inert, so a permanent decorative one is worse than
 * useless — it is the exact signal this suite needs to stay trustworthy.
 */
if (!HAS_TEMPLATES) {
  describe("cross-tier version agreement", () => {
    it.todo(TEMPLATES_ABSENT_TODO);
  });
}
