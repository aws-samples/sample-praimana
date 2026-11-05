import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * THE SPAWN ENVIRONMENT CARRIES NO MODEL CONFIGURATION.
 *
 * ── THE RULE, AND WHY IT IS A RULE ──
 *
 * Claude Code resolves its own configuration: settings files at four precedence levels,
 * the macOS Keychain (`claude login`), ~/.claude/.credentials.json, `apiKeyHelper`, and
 * `awsCredentialExport`. The desktop's job is to make the process START correctly, then
 * get out of the way.
 *
 * This was TESTED, not assumed. Spawning the CLI with a deliberately empty environment
 * (only HOME, PATH, TERM) inside the workshop project still read that project's
 * .claude/settings.json, enabled Bedrock, took its AWS_REGION, fetched its own
 * credentials, and reached inference-profile/global.anthropic.claude-opus-4-8 — failing
 * only on an IAM policy. It got to the model unaided.
 *
 * Every attempt to help produced a bug instead:
 *   - merging only ~/.claude/settings.json ignored the project's, so Bedrock never
 *     turned on and the CLI 403'd against the Anthropic API (presenting as a hang,
 *     because it retries ten times with backoff);
 *   - an auth gate built from those same files could not see Keychain credentials, so it
 *     would have blocked every Anthropic-direct customer.
 *
 * Hence source-level assertions: the failure mode is a well-meaning future edit
 * re-adding "just this one variable", and the cost of that is a class of bug that takes
 * an afternoon to trace back from a retry loop.
 */

const SRC = join(__dirname, "cli-assistant.ts");
const src = readFileSync(SRC, "utf8");

/** The spawnEnv literal, comments stripped — the comments discuss what it must NOT do. */
const spawnEnvBlock = (() => {
  const start = src.indexOf("const spawnEnv: NodeJS.ProcessEnv = {");
  const end = src.indexOf("};", start);
  return src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
})();

describe("the spawn env injects only Electron repairs", () => {
  it("sets the four things Electron genuinely breaks, and nothing more", () => {
    // PATH: a Finder/dock launch inherits no shell PATH, so `claude` is unfindable.
    // HOME: without it the CLI cannot locate ~/.claude at all.
    // TERM/NO_COLOR: we parse the output, so ANSI escapes would corrupt it.
    for (const key of ["TERM", "NO_COLOR", "HOME", "PATH"]) {
      expect(spawnEnvBlock, `spawnEnv should set ${key}`).toContain(key);
    }
  });

  it("passes process.env through rather than curating it", () => {
    expect(spawnEnvBlock).toContain("...process.env");
  });

  it.each([
    "claudeEnv",
    "awsCreds",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "ANTHROPIC_API_KEY",
    "AWS_REGION",
  ])("does NOT inject %s", (forbidden) => {
    // Each of these is something the CLI already resolves better than we can.
    expect(spawnEnvBlock, `spawnEnv must not carry ${forbidden}`).not.toContain(forbidden);
  });
});

describe("no credential handling remains in the spawn path", () => {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("does not execute the credential-export command itself", () => {
    // The CLI runs awsCredentialExport when it needs to. Running it here meant parsing
    // its output and handling short-lived secrets in a process that had no need of them.
    expect(code).not.toMatch(/execSync/);
    expect(code).not.toMatch(/"Credentials"/);
  });

  it("does not import execSync any more", () => {
    expect(src).not.toMatch(/import \{[^}]*execSync/);
  });
});

describe("cwd is what selects the project's settings", () => {
  it("both the exec and spawn call sites set cwd to the project path", () => {
    // This is the ONE thing that has to be right for the CLI to find
    // <project>/.claude/settings.json. Two call sites (claude uses exec, others spawn),
    // so both are asserted — a missing cwd on either would silently fall back to the
    // app's own working directory and read the wrong settings.
    const occurrences = [...src.matchAll(/cwd:\s*projectPath/g)];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});

describe("settings are still read — for diagnostics only", () => {
  it("loadClaudeSettings is called, but its env is not spread into the spawn", () => {
    // Explaining a failure from settings is useful; building the environment from them
    // is what caused the bugs. Keeping the read while forbidding the spread is the whole
    // distinction this change rests on.
    expect(src).toContain("loadClaudeSettings(projectPath)");
    expect(spawnEnvBlock).not.toContain("claudeEnv");
  });

  it("the auth gate and the hint both still run", () => {
    expect(src).toContain("describeAuthGap(claudeEnv, credentialExport)");
    expect(src).toContain("bedrockFlagHint(claudeEnv, credentialExport)");
  });
});
