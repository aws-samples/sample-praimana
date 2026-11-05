// ── ⚠ THE AUDIT LOG'S ANSWER TO "WAS THE AGENT ASKED FIRST?" ────────────────────────────────────
//
// Two of the three agent runtimes launched with tool approval pre-granted, and the finding's second half was
// that there was "no durable record of the privileged actions". A record naming only the binary does not
// answer the question an operator actually has afterwards, so the record names the POLICY — and this is the
// function that reads it off the argv that is about to be spawned.
//
// ⚠ READ FROM THE ARGV, NOT FROM A CONSTANT BESIDE IT, which is what these cases pin: a policy
// derived from what the code intends would keep reporting "ask" after somebody added a flag, and an
// audit trail that lies in the safe direction is worse than none.

import { describe, it, expect } from "vitest";
import { toolPolicyOf } from "./agent-tool-policy";

describe("toolPolicyOf", () => {
  it("reports the blanket-trust flag, which is what the finding was about", () => {
    expect(toolPolicyOf(["chat", "--no-interactive", "--trust-all-tools"])).toBe("trust-all");
    expect(toolPolicyOf(["acp", "--trust-all-tools"])).toBe("trust-all");
  });

  /** The narrow form kiro-trust.ts replaced it with: a named subset silent, the rest prompted. */
  it("distinguishes the narrow trust list from blanket trust", () => {
    expect(toolPolicyOf(["acp", "--trust-tools=fs_read,fs_write"])).toBe("trust-listed");
  });

  it("reports Claude's pre-approval flag", () => {
    expect(toolPolicyOf(["-p", "--allowedTools", "Read", "Grep"])).toBe("pre-approved");
  });

  it("reports `ask` when nothing is pre-approved", () => {
    expect(toolPolicyOf(["-p", "--verbose", "--output-format", "stream-json"])).toBe("ask");
    expect(toolPolicyOf([])).toBe("ask");
  });

  /**
   * ⚠ THE MOST PERMISSIVE FORM WINS. An argv carrying both must be recorded as what it actually
   * grants, not as the stricter flag it also mentions — the opposite way round is a log that
   * understates a privilege.
   */
  it("records the weaker policy when an argv carries two", () => {
    expect(toolPolicyOf(["acp", "--trust-tools=fs_read", "--trust-all-tools"])).toBe("trust-all");
    expect(toolPolicyOf(["--allowedTools", "Read", "--trust-tools=fs_read"])).toBe("trust-listed");
  });

  /**
   * ⚠ A FLAG NAME MUST MATCH EXACTLY. `--trust-all-tools-maybe` is not the flag, and a substring
   * match would report blanket trust for an argv that does not grant it — the same understating
   * problem in reverse.
   */
  it("does not match a flag that merely looks like one", () => {
    expect(toolPolicyOf(["--trust-all-tools-later"])).toBe("ask");
    expect(toolPolicyOf(["--allowedToolsets", "x"])).toBe("ask");
  });
});

/**
 * ── ⚠ CODEX EXPRESSES POLICY THROUGH `--sandbox`, AND THIS FUNCTION WAS BLIND TO IT ────────────
 *
 * The codex argv carries none of the three flags above, so it fell through to `ask` and the hash-chained
 * record stated the runtime asked before each tool when in fact nothing was asked — the WIDEST of the three
 * setup policies recorded as the NARROWEST. An audit trail that errs toward "nothing was granted" is worse
 * than no audit trail, because it is trusted.
 */
describe("toolPolicyOf — codex's sandbox forms", () => {
  it("reports workspace-write as the bounded pre-approval it is", () => {
    expect(
      toolPolicyOf(["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "<prompt>"])
    ).toBe("sandbox-write");
  });

  it("reports read-only distinctly, because it grants no writes", () => {
    expect(
      toolPolicyOf(["exec", "--skip-git-repo-check", "--sandbox", "read-only", "<prompt>"])
    ).toBe("sandbox-read");
  });

  /** ⚠ THE CODEX SETUP ARGV MUST NEVER AGAIN READ AS `ask`. That is the finding, in one line. */
  it("⚠ never reports `ask` for an argv that grants workspace write and shell", () => {
    expect(
      toolPolicyOf(["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "<prompt>"])
    ).not.toBe("ask");
  });

  /**
   * Detected although the tree passes it nowhere — this module reads argv, not intent, and a detector
   * that only knows the values currently in use would report `ask` for the value granting everything.
   */
  it("reports codex's blanket bypasses as trust-all", () => {
    expect(toolPolicyOf(["exec", "--dangerously-bypass-approvals-and-sandbox"])).toBe("trust-all");
    expect(toolPolicyOf(["exec", "--sandbox", "danger-full-access"])).toBe("trust-all");
  });

  it("still reports `ask` when the flag is absent, or has no value to read", () => {
    expect(toolPolicyOf(["exec", "--skip-git-repo-check", "<prompt>"])).toBe("ask");
    // Trailing flag: nothing follows it, so there is no mode and nothing to claim.
    expect(toolPolicyOf(["exec", "--sandbox"])).toBe("ask");
    // A value that is not one of codex's three is not a policy this function knows.
    expect(toolPolicyOf(["exec", "--sandbox", "something-new"])).toBe("ask");
  });

  /** The ordering rule holds across vocabularies: the wider grant wins, whichever CLI named it. */
  it("records the wider grant when an argv mixes vocabularies", () => {
    expect(toolPolicyOf(["--sandbox", "read-only", "--trust-all-tools"])).toBe("trust-all");
    expect(toolPolicyOf(["--sandbox", "workspace-write", "--trust-tools=fs_read"])).toBe(
      "trust-listed"
    );
  });
});
