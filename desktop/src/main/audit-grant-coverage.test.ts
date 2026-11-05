// ── ⚠ WIDENING WHAT THIS MACHINE WILL TOUCH IS A RECORDED DECISION ────────────────────────────
//
// The log covers sign-in, platform config, agent spawns, tool permissions, chat sharing, file mutation
// and `docs:*`. Three classes of local security-critical state change emitted nothing:
//
//   db:addProject            inserts a row its OWN comment calls "a BOUNDARY GRANT, not just a record
//                            — an insert here widens what the file, git and spawn handlers will touch
//                            — and PERSISTENTLY". handlers/db.ts did not import this module at all.
//   files:commitProjectPath  rewrites the `project_path` setting `allowedRoots()` builds the fence
//                            from. Same: no import.
//   cli:trustWorkspace       writes `hasTrustDialogAccepted` into the OS-GLOBAL `~/.claude.json`,
//                            which its own comment says "is what makes Claude Code honour a folder's
//                            permissions.allow instead of prompting" — in a file that already called
//                            recordSecurityEvent for `agent.spawn`.
//   git:uploadSelected       POSTs up to a HUNDRED project files to the team store, while the
//                            single-file `docs:upload` / `docs:delete` each write a `docs.change`.
//
// So an investigator had no local answer to "who widened the confinement fence", "who trusted that
// folder for the agent", or "who put those files in the team store" — while `file.mutate` diligently
// recorded every write those grants then permitted.
//
// ⚠ THE EVENT UNION IS CLOSED, which is why this needed two new members rather than four call sites.
// That closure is the forcing function it was designed to be — and also why the gap survived: the
// facility was in scope everywhere, the VOCABULARY was not.
//
// ⚠ ASSERTED AGAINST THE SOURCE. These are four handlers in four modules whose effects need a
// database, a home directory and a network — and the property is "each of these sites emits", which is
// a fact about a set of call sites rather than about one behaviour. Same technique
// no-plaintext-credentials.test.ts uses for its ordering rules. The record SHAPES are exercised
// behaviourally by security-audit.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(local(rel), "utf8");
/** Comments quote these event names at length; only code counts. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const AUDIT = read("./security-audit.ts");
const DB = strip(read("./handlers/db.ts"));
const FILES = strip(read("./handlers/files.ts"));
const CLI = strip(read("./handlers/cli-assistant.ts"));
const GIT = strip(read("./handlers/git.ts"));

describe("⚠ the audit vocabulary covers grants", () => {
  it("declares project.grant and agent.trust in the closed union", () => {
    const union = AUDIT.slice(
      AUDIT.indexOf("export type SecurityAuditEvent"),
      AUDIT.indexOf("export type SecurityAuditOutcome")
    );
    expect(union).toContain('"project.grant"');
    expect(union).toContain('"agent.trust"');
  });

  /**
   * ⚠ THE UNION MUST STAY CLOSED. It is what makes a typo fail the build instead of writing an event
   * nobody greps for, and widening it to `string` would silently undo that for every existing member.
   */
  it("keeps the union closed rather than widening it to a string", () => {
    const union = AUDIT.slice(
      AUDIT.indexOf("export type SecurityAuditEvent"),
      AUDIT.indexOf("export type SecurityAuditOutcome")
    );
    expect(union, "no escape hatch").not.toMatch(/\|\s*string\b/);
  });
});

describe("⚠ every boundary grant emits", () => {
  it("db:addProject records the grant", () => {
    const body = DB.slice(DB.indexOf('"db:addProject"'), DB.indexOf('"db:removeProject"'));
    expect(body).toContain("recordSecurityEvent(");
    expect(body).toContain('"project.grant"');
  });

  /**
   * ⚠ AFTER THE INSERT, AND NOT ON THE EARLY RETURN. An existing row grants nothing new — the boundary
   * already included that path — so recording there would report a widening that did not happen, and on
   * a returning user that is most of the traffic through this handler.
   */
  it("db:addProject records only when a row is actually inserted", () => {
    const body = DB.slice(DB.indexOf('"db:addProject"'), DB.indexOf('"db:removeProject"'));
    const earlyReturn = body.indexOf("if (existing)");
    const insert = body.indexOf("INSERT INTO projects");
    const record = body.indexOf("recordSecurityEvent(");

    expect(record, "after the insert, not before").toBeGreaterThan(insert);
    expect(
      body.slice(earlyReturn, insert),
      "the existing-row branch must not record a grant"
    ).not.toContain("recordSecurityEvent(");
  });

  it("files:commitProjectPath records the fence being repointed", () => {
    const body = FILES.slice(
      FILES.indexOf('"files:commitProjectPath"'),
      FILES.indexOf('"files:selectUpload"')
    );
    expect(body).toContain("recordSecurityEvent(");
    expect(body).toContain('"project.grant"');
  });

  /**
   * ⚠ THE PATH IS RECORDED AS A BASENAME. A full project path is a person's name, their employer's and
   * their client's in one string, and this log is plaintext — the rule the module states for every other
   * path it records, and the reason `redactedTarget` exists.
   */
  it("records paths through redactedTarget, never raw", () => {
    for (const [name, body] of [
      ["db:addProject", DB.slice(DB.indexOf('"db:addProject"'), DB.indexOf('"db:removeProject"'))],
      [
        "files:commitProjectPath",
        FILES.slice(FILES.indexOf('"files:commitProjectPath"'), FILES.indexOf('"files:selectUpload"')),
      ],
    ] as const) {
      const at = body.indexOf("recordSecurityEvent(");
      const call = body.slice(at, at + 300);
      expect(call, `${name} must redact the path`).toContain("redactedTarget(");
    }
  });
});

describe("⚠ the workspace trust grant emits", () => {
  /**
   * ⚠ SCOPED TO THE GRANT HANDLER, ENDING AT THE REVOCATION ONE. This slice used to run to
   * `"cli:getModels"`, which was correct until `cli:untrustWorkspace` and `cli:isWorkspaceTrusted` were
   * added between them — at which point the occurrence COUNT below started including their records and
   * failed. A count assertion is only as good as the region it counts over.
   */
  const body = CLI.slice(
    CLI.indexOf('"cli:trustWorkspace"'),
    CLI.indexOf('"cli:untrustWorkspace"')
  );

  it("records the grant", () => {
    expect(body).toContain('"agent.trust"');
  });

  /**
   * ⚠ AFTER THE WRITE SUCCEEDS. `writeFileSync` can throw — a read-only home, a malformed
   * `~/.claude.json` — and a record claiming a grant that did not happen is worse than none.
   */
  it("records after the file is written, not before", () => {
    /**
     * ⚠ ANCHORED ON THE SUCCESS RECORD, NOT THE FIRST `agent.trust`. The REFUSAL record legitimately
     * precedes the write — a first version of this assertion found that one and failed on correct code,
     * which is a good reminder that "the first occurrence" is rarely the one an ordering claim means.
     */
    const write = body.indexOf("writeFileSync(claudeJsonPath");
    expect(write, "the grant must be written").toBeGreaterThan(-1);
    const success = body.indexOf('outcome: "success"');
    expect(success, "there must be a success record").toBeGreaterThan(-1);
    expect(success, "and it must follow the write it attests to").toBeGreaterThan(write);
  });

  /**
   * ⚠ AND THE REFUSAL AND THE FAILURE ARE RECORDED TOO, which is unusual on this surface and specific to
   * this grant. Nothing is written on a refusal, so without a record a probe of this channel is
   * indistinguishable from no call at all — and there is no revocation path anywhere in the app, so this
   * record is the only trace the decision leaves.
   */
  it("records the refusal and the failure, not only the grant", () => {
    expect(body).toContain('outcome: "refused"');
    expect(body).toContain('outcome: "failure"');
    /**
     * ⚠ AT LEAST FOUR, NOT EXACTLY N. This was `toBe(3)` and broke the moment the grant gained a
     * confirmation, whose DECLINE is a fourth `agent.trust` record — a correct addition failing a test
     * that had pinned a count as a proxy for "the outcomes are covered". The outcomes are what matter,
     * so they are asserted by name above and the count only guards against them collapsing into one.
     */
    expect(
      (body.match(/"agent\.trust"/g) ?? []).length,
      "grant, path refusal, decline and failure"
    ).toBeGreaterThanOrEqual(4);
  });

  /**
   * ⚠ THE DECLINE IS ITS OWN OUTCOME. "The participant said no" is a different fact from "the path was
   * refused", and collapsing them would lose the only local evidence of why an assistant keeps
   * prompting somebody.
   */
  it("distinguishes a declined confirmation from a refused path", () => {
    expect(body).toMatch(/detail: `declined:/);
    expect(body).toMatch(/detail: `not-an-open-root:/);
  });
});

describe("⚠ bulk document upload emits", () => {
  const body = GIT.slice(GIT.indexOf('"git:uploadSelected"'));

  it("records a docs.change like its single-file siblings", () => {
    expect(body).toContain("recordSecurityEvent(");
    expect(body).toContain('"docs.change"');
  });

  /**
   * ⚠ A COUNT, NOT UP TO 100 FILE NAMES. The names would dominate the log and push genuine history
   * toward the rotation bound, against the module's stated rule that a record is "enough to reconstruct
   * a sequence, never enough to reconstruct the work".
   */
  it("records a count rather than the file names", () => {
    const at = body.indexOf("recordSecurityEvent(");
    const call = body.slice(at, at + 400);
    expect(call).toMatch(/bulk-upload/);
    expect(call, "no per-file detail").not.toContain("files.map");
    expect(call, "and no key list").not.toMatch(/paths\s*\./);
  });

  /**
   * ⚠ THE SERVER'S NUMBER, NOT OURS. The docs service applies its own extension, size and path policy,
   * so recording `files.length` would claim an upload the team store may not have accepted.
   */
  it("records what the server said it stored", () => {
    const at = body.indexOf("recordSecurityEvent(");
    expect(body.slice(at, at + 400)).toContain("result.stored");
  });
});

/**
 * ── ⚠ AND THE FOUR MODULES NOW IMPORT THE FACILITY THEY WERE MISSING ──────────────────────────
 *
 * Two of them did not import `recordSecurityEvent` at all, which is the mechanical shape of this
 * finding: not a judgement that these events did not matter, but that nobody in those files had the
 * function to hand.
 */
describe("the modules import the audit module", () => {
  for (const [name, src] of [
    ["handlers/db.ts", DB],
    ["handlers/files.ts", FILES],
    ["handlers/cli-assistant.ts", CLI],
    ["handlers/git.ts", GIT],
  ] as const) {
    it(`${name} imports recordSecurityEvent`, () => {
      expect(src).toMatch(/import \{[^}]*recordSecurityEvent[^}]*\} from "\.\.\/security-audit"/);
    });
  }
});

/**
 * ── ⚠ COMPLETENESS: EVERY ACTION RECORD NAMES ITS SUBJECT ──────────────────────────────────────
 *
 * The report named two sites. A sweep of the tree found the same omission at six, in the same differential
 * shape as everything else in that report:
 *
 *   tool.permission   attributed in cli-assistant.ts, NOT in kiro-acp.ts — and that is the record that
 *                     says somebody let the agent do something
 *   agent.spawn       attributed in none of its four sites
 *   chat.share        attributed on `shared`, NOT on `unshared`, two screens apart in one file
 *   docs.change       attributed in git.ts, NOT in team-data.ts  (the two the report named)
 *
 * ⚠ SO THE RULE IS STATED PER EVENT CLASS, NOT PER CALL SITE. "These six sites were fixed" is the
 * bookkeeping that produced the gap; "every record of a user ACTION carries a subject, and here are the
 * classes that are exempt and why" is a property the next call site inherits automatically. A seventh
 * `agent.spawn` added tomorrow fails this test rather than a report next quarter.
 *
 * ⚠ WHY ATTRIBUTION IS NOT COSMETIC HERE. Several identities are stored locally and
 * `auth:switchAccount` installs another account's session with no re-authentication, which is an
 * accepted risk recorded as threat T023 in .threatmodel/praimana-threat-model.md and SECURITY.md.
 * Accepting it is only defensible while the log can say WHICH identity acted — an unattributed
 * record makes the acceptance strictly worse.
 */
describe("⚠ every record of a user action names its subject (derived sweep)", () => {
  /**
   * Events that describe something a signed-in participant DID. `recordSecurityEvent` drops an absent
   * subject silently, so an omission here is invisible in the log rather than obvious.
   */
  const ATTRIBUTABLE = [
    "account.switch",
    "account.remove",
    "chat.share",
    "agent.spawn",
    "agent.trust",
    "tool.permission",
    "file.mutate",
    "docs.change",
    "project.grant",
  ] as const;

  /**
   * Classes deliberately outside the rule, with the reason — not a list of things left undone.
   *
   *   auth.*       the identity is being ESTABLISHED or torn down. A failed `auth.signin` has no
   *                verified subject to name, and naming the CLAIMED one would put a renderer-supplied
   *                value in the subject field, which is the forged-subject finding this module already
   *                fixed at `normalisedSubject`. Successful sign-in and both `account.*` events do
   *                record it, so "who is on this machine" is answerable without it.
   *   platform.*   machine-level configuration, set before anybody is signed in.
   *   log.rotated  written by this module about itself; there is no actor.
   */
  const EXEMPT_PREFIXES = ["auth.", "platform."] as const;
  const EXEMPT_EVENTS = ["log.rotated"] as const;

  /** Every non-test module under src/main, so a new handler is swept without being listed. */
  const modules = (): string[] => {
    const root = local("./");
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(p);
      }
    };
    walk(root);
    return out;
  };

  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  /**
   * Every `recordSecurityEvent({ … })` argument literal in the tree, with its event name.
   *
   * ⚠ BRACE-MATCHED, NOT LINE-MATCHED. These literals span one line in some files and eight in others,
   * and a per-line regex would read the `event:` of one call and the `userId:` of the next.
   */
  const callSites = (): Array<{ file: string; event: string; literal: string }> => {
    const sites: Array<{ file: string; event: string; literal: string }> = [];
    for (const file of modules()) {
      const src = stripComments(readFileSync(file, "utf8"));
      let from = 0;
      for (;;) {
        const call = src.indexOf("recordSecurityEvent(", from);
        if (call === -1) break;
        const open = src.indexOf("{", call);
        if (open === -1) break;
        let depth = 0;
        let close = open;
        for (; close < src.length; close++) {
          if (src[close] === "{") depth++;
          else if (src[close] === "}" && --depth === 0) break;
        }
        const literal = src.slice(open, close + 1);
        sites.push({
          file: file.slice(file.indexOf("src/main/")),
          event: /event:\s*["']([^"']+)["']/.exec(literal)?.[1] ?? "",
          literal,
        });
        from = close + 1;
      }
    }
    return sites;
  };

  it("finds the call sites at all — a sweep that matches nothing proves nothing", () => {
    const sites = callSites();
    expect(sites.length, "recordSecurityEvent is called across the main process").toBeGreaterThan(20);
    const events = new Set(sites.map((s) => s.event));
    // Anchors: a refactor that hides these from the sweep is caught here rather than passing silently.
    for (const required of ["agent.spawn", "tool.permission", "file.mutate", "docs.change"]) {
      expect(events, `${required} must be visible to the sweep`).toContain(required);
    }
  });

  it("has no attributable record written without a subject", () => {
    const gaps: string[] = [];
    for (const { file, event, literal } of callSites()) {
      if (!event) continue;
      if (EXEMPT_EVENTS.includes(event as never)) continue;
      if (EXEMPT_PREFIXES.some((p) => event.startsWith(p))) continue;
      if (!ATTRIBUTABLE.includes(event as never)) continue;
      /**
       * ⚠ BOTH SPELLINGS. `userId: activeUserId() ?? undefined` and the conditional-spread shorthand
       * `...(userId ? { userId } : {})` are both real attribution, and `share:shareSession` uses the
       * second — a `userId:` -only check reported it as a gap when it was the one site already correct.
       */
      const attributed = /userId:/.test(literal) || /\{\s*userId\s*\}/.test(literal);
      if (!attributed) gaps.push(`${file} ${event}`);
    }
    expect(
      gaps,
      "each of these records an action with no acting subject — add userId: activeUserId() ?? " +
        "undefined, or exempt the event class above with a reason"
    ).toEqual([]);
  });

  /** The gap the report actually named: the least-constrained write channel recorded nothing at all. */
  it("files:writeFile records the overwrite it performs", () => {
    const src = read("./handlers/files.ts");
    const body = src.slice(src.indexOf('"files:writeFile"'));
    const write = body.indexOf("fs.writeFileSync(");
    const record = body.indexOf("recordSecurityEvent(");

    expect(record, "the overwrite must be recorded").toBeGreaterThan(-1);
    expect(record, "after the syscall — a record written first claims what may not have happened")
      .toBeGreaterThan(write);
    expect(body.slice(record, record + 260)).toContain('event: "file.mutate"');
  });
});
