// ── ⚠ SECURITY EVENTS ARE RECORDED, AND EDITS TO THE RECORD ARE DETECTABLE ────────────────────
//
// When a participant asks "who signed in as me?" or "what did the agent get permission to run?", the app
// could answer nothing.
//
// These tests exercise the real file on a real temp directory, because the two things most likely to
// be wrong are both invisible to a source read: the FILE PERMISSIONS (0600 vs the umask default of
// 0644) and whether the hash chain actually survives a restart. A chain that silently restarts every
// launch is worse than none — it reports tampering on every honest log.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/** A fresh userData per test file; `app.getPath` is the only Electron surface this module uses. */
let userData = "";
vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

import {
  AUDIT_FILE_MODE,
  MAX_AUDIT_LINES,
  __setMaxAuditLines,
  auditLogPath,
  recordSecurityEvent,
  verifyAuditChain,
  __resetAuditState,
  type SecurityAuditRecord,
} from "./security-audit";

const readLog = () => fs.readFileSync(auditLogPath(), "utf-8");
const records = (): SecurityAuditRecord[] =>
  readLog()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  __resetAuditState();
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("it records what happened", () => {
  it("writes one JSONL record per event", () => {
    recordSecurityEvent({ event: "auth.signin", outcome: "success", userId: "user-1" });
    recordSecurityEvent({ event: "auth.signout", outcome: "success", userId: "user-1" });

    const rows = records();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ seq: 1, event: "auth.signin", outcome: "success", userId: "user-1" });
    expect(rows[1]).toMatchObject({ seq: 2, event: "auth.signout" });
    expect(new Date(rows[0].at).toString()).not.toBe("Invalid Date");
  });

  it("numbers records contiguously, so a gap is evidence", () => {
    for (let i = 0; i < 5; i++) recordSecurityEvent({ event: "tool.permission", outcome: "refused" });
    expect(records().map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("omits absent fields rather than writing empty ones", () => {
    // Every record repeats its keys; a log of `"userId":""` is bytes with no information.
    recordSecurityEvent({ event: "auth.signin", outcome: "refused", detail: "bad-signature" });
    const [row] = records();
    expect(row).not.toHaveProperty("userId");
    expect(row.detail).toBe("bad-signature");
  });
});

describe("⚠ 0600 — owner read/write only", () => {
  it("creates the file unreadable by anyone else", () => {
    /**
     * The default for a new file under a typical umask is 0644, which hands the record of who signed
     * in to every other local account on a shared or managed machine. `appendFileSync(file, data)`
     * would do exactly that, which is why the write opens an fd with an explicit mode.
     */
    recordSecurityEvent({ event: "auth.signin", outcome: "success" });
    const mode = fs.statSync(auditLogPath()).mode & 0o777;
    expect(mode & 0o077, "no group or world bits").toBe(0);
    expect(mode).toBe(AUDIT_FILE_MODE);
  });

  it("NARROWS a log an earlier build left world-readable", () => {
    /**
     * ⚠ THE CASE A `mode:` OPTION ALONE DOES NOT COVER. `mode` applies only when the file is
     * CREATED, so an upgrade over a 0644 log written by a previous version would keep those
     * permissions for ever. Hence the explicit chmod on every write.
     */
    fs.writeFileSync(auditLogPath(), "", { mode: 0o644 });
    fs.chmodSync(auditLogPath(), 0o644);
    expect(fs.statSync(auditLogPath()).mode & 0o077).not.toBe(0); // precondition

    recordSecurityEvent({ event: "auth.signin", outcome: "success" });
    expect(fs.statSync(auditLogPath()).mode & 0o077).toBe(0);
  });
});

describe("⚠ the hash chain makes selective editing detectable", () => {
  const seed = () => {
    recordSecurityEvent({ event: "auth.signin", outcome: "success", userId: "user-1" });
    recordSecurityEvent({ event: "tool.permission", outcome: "success", detail: "allowed-once" });
    recordSecurityEvent({ event: "auth.signout", outcome: "success", userId: "user-1" });
  };

  it("verifies an untouched log", () => {
    seed();
    expect(verifyAuditChain(readLog())).toMatchObject({ ok: true, records: 3 });
  });

  it("links each record to the one before it", () => {
    seed();
    const rows = records();
    expect(rows[0].prev).toBe("genesis");
    expect(rows[1].prev).toBe(rows[0].hash);
    expect(rows[2].prev).toBe(rows[1].hash);
  });

  it("detects a DELETED record — the realistic attack", () => {
    /**
     * An actor who wants one line gone, not the whole file. Removing the middle record leaves record
     * 3 pointing at a hash that is no longer present, and its sequence number jumps.
     */
    seed();
    const lines = readLog().split("\n").filter(Boolean);
    const tampered = [lines[0], lines[2]].join("\n") + "\n";

    const result = verifyAuditChain(tampered);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(2);
    expect(result.reason).toMatch(/removed or reordered/);
  });

  it("detects an EDITED record", () => {
    // Turning a refusal into a success — the edit someone would actually want.
    seed();
    const lines = readLog().split("\n").filter(Boolean);
    const row = JSON.parse(lines[1]) as SecurityAuditRecord;
    row.outcome = "refused";
    lines[1] = JSON.stringify(row);  // nosemgrep: no-stringify-keys

    const result = verifyAuditChain(lines.join("\n") + "\n");
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(2);
    expect(result.reason).toMatch(/do not match their hash/);
  });

  it("detects a re-hashed record, because the CHAIN also has to match", () => {
    /**
     * ⚠ THE ATTACK A PER-RECORD CHECKSUM WOULD MISS. Someone who edits a record and recomputes its
     * own hash still cannot fix it: the NEXT record's `prev` still names the old hash. This is the
     * difference between a checksum and a chain, and it is the reason `prev` exists.
     */
    seed();
    const lines = readLog().split("\n").filter(Boolean);
    const row = JSON.parse(lines[1]) as SecurityAuditRecord;
    row.outcome = "refused";
    // Recompute exactly as the module does.
    const canonical = [row.seq, row.at, row.event, row.outcome, row.userId ?? "", row.detail ?? "", row.prev].join(
      "\u0000"
    );
    row.hash = createHash("sha256").update(canonical, "utf8").digest("hex");
    lines[1] = JSON.stringify(row);  // nosemgrep: no-stringify-keys

    const result = verifyAuditChain(lines.join("\n") + "\n");
    expect(result.ok).toBe(false);
    // Record 2 now verifies against itself, so the break surfaces at record 3's `prev`.
    expect(result.brokenAt).toBe(3);
    expect(result.reason).toMatch(/prev hash does not match/);
  });

  it("detects a REORDERED pair", () => {
    seed();
    const lines = readLog().split("\n").filter(Boolean);
    const swapped = [lines[1], lines[0], lines[2]].join("\n") + "\n";
    expect(verifyAuditChain(swapped).ok).toBe(false);
  });

  it("reports an unparseable line rather than skipping it", () => {
    seed();
    expect(verifyAuditChain(readLog() + "{not json\n").ok).toBe(false);
  });

  it("⚠ CONTINUES the chain across a restart", () => {
    /**
     * The bug this would have had. `lastSeq`/`lastHash` live in memory, so without reading the tail
     * of an existing log on first write, every launch would restart at seq 1 with prev "genesis"
     * mid-file — which is the exact signature of a truncated log. An integrity check that cries
     * tampering on every honest restart gets switched off.
     */
    seed();
    __resetAuditState(); // as if the process had exited
    recordSecurityEvent({ event: "auth.signin", outcome: "success", userId: "user-2" });

    const rows = records();
    expect(rows).toHaveLength(4);
    expect(rows[3].seq).toBe(4);
    expect(rows[3].prev).toBe(rows[2].hash);
    expect(verifyAuditChain(readLog())).toMatchObject({ ok: true, records: 4 });
  });

  it("recovers from a partial trailing line left by a crash", () => {
    // Continue from the last COMPLETE record rather than treating the file as corrupt.
    seed();
    fs.appendFileSync(auditLogPath(), '{"seq":4,"event":"auth.sig');
    __resetAuditState();
    recordSecurityEvent({ event: "auth.signout", outcome: "success" });

    /**
     * Parsed tolerantly on purpose: the partial line is still in the file and is not valid JSON, so
     * the shared `records()` helper would throw on it. What matters is that the NEW record continued
     * from the last complete one (seq 3) rather than restarting at 1.
     */
    const parsed = readLog()
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as SecurityAuditRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is SecurityAuditRecord => !!r && typeof r.hash === "string");
    expect(parsed.at(-1)?.seq).toBe(4);
    expect(parsed.at(-1)?.prev).toBe(parsed.at(-2)?.hash);
  });
});

describe("it stays bounded, and a trim cannot be forged", () => {
  /**
   * ⚠ DRIVEN AT A SMALL BOUND. Rotation logic is identical at 40 records and at 2000, and exercising the
   * real number meant thousands of real file writes per case — seconds each, which put two of these over
   * vitest's 5s default whenever the machine was busy. That reads as flakiness and invites a bumped
   * timeout rather than a fix. One case below keeps the production number.
   */
  const BOUND = 40;
  beforeEach(() => __setMaxAuditLines(BOUND));

  const fill = (n: number) => {
    for (let i = 0; i < n; i++) recordSecurityEvent({ event: "tool.permission", outcome: "success" });
  };

  it("trims to the most recent window", () => {
    fill(BOUND + 25);
    const lines = readLog().split("\n").filter(Boolean);
    // The kept window plus the one `log.rotated` record that replaced it.
    expect(lines.length).toBeLessThanOrEqual(BOUND + 1);
  });

  /**
   * ── ⚠ ROTATION LEAVES THE FILE BELOW ITS OWN TRIGGER ────────────────────────────────────────
   *
   * The survivor window was `slice(-maxLines)` and the marker is written on TOP of it, so the rewritten chain
   * was `maxLines + 1` long and `lineCount` was set to that — permanently above the trigger. Every subsequent
   * audited action therefore re-read the whole log, re-parsed every line, computed `maxLines + 1` fresh
   * SHA-256 digests and rewrote the file, synchronously on the Electron main process. At the production bound
   * that is a ~300 KB read and write plus 2001 hashes per audited action, which presents as the UI freezing.
   */
  it("⚠ does not sit permanently at its own rotation trigger", () => {
    fill(BOUND + 5);
    const after = readLog().split("\n").filter(Boolean).length;
    expect(after, "the rewritten chain must clear the trigger, marker included").toBeLessThanOrEqual(
      BOUND
    );
  });

  /**
   * ⚠ AND IT BUYS EVENTS BETWEEN ROTATIONS, which `maxLines - 1` would not have — that clears the
   * trigger but the next append re-crosses it, so the file is still rewritten on essentially every
   * event. Counted by watching the whole-file rewrites: an append is `appendFileSync`, a rotation is
   * `writeFileSync`.
   */
  it("⚠ amortises rotation instead of rewriting on every event", () => {
    fill(BOUND + 2); // get past the bound once
    const rewrites = vi.spyOn(fs, "writeFileSync");
    fill(BOUND / 2); // BOUND is 40, so 20 further events
    const count = rewrites.mock.calls.length;
    rewrites.mockRestore();

    /**
     * With the 80% watermark the window has ~20% of `BOUND` (8) events of headroom, so 20 events is
     * two or three rotations — not twenty. The assertion is deliberately loose about the exact
     * number and strict about the ORDER of magnitude, which is the property that regressed.
     */
    expect(count, `${count} rewrites for ${BOUND / 2} events is per-event rotation`).toBeLessThan(
      BOUND / 4
    );
  });

  it("⚠ writes a HASHED, CHAINED rotation record — not an annotation", () => {
    /**
     * The fix for the forged-marker finding. The first line is now an ordinary record: it has a `seq`, a
     * `prev` of "genesis" and a `hash` over its own canonical form, so the verifier treats it like
     * anything else and has no fields to take on trust.
     */
    fill(BOUND + 5);
    const first = JSON.parse(readLog().split("\n")[0]) as SecurityAuditRecord;

    expect(first.event).toBe("log.rotated");
    expect(first.seq).toBe(1);
    expect(first.prev).toBe("genesis");
    expect(typeof first.hash).toBe("string");
    expect(first.detail, "it records what was dropped").toMatch(/trimmed:\d+-dropped:kept-\d+/);
    // The old shape is gone entirely.
    expect(readLog()).not.toContain('"carried"');
    expect(readLog()).not.toContain("continuesFrom");
  });

  /**
   * ── ⚠ A FLOOD OF CHEAP SUCCESSES CANNOT EVICT THE DECISIONS ─────────────────────────────────
   *
   * The refusal path has a budget; the success path deliberately does not, and that justification stands — a
   * real agent run emits hundreds of genuine `file.mutate` records and coalescing them would lose the
   * sequence. The hole was in RETENTION: `slice(-keep)` is pure recency, so `fileOps:createFile` —
   * renderer-driven, no rate limit, one record per call — pushed out every sign-in, grant and tool approval
   * before it.
   *
   * ⚠ AND THE ERASURE VERIFIED CLEAN, which is what made it worth more than its severity. Rotation
   * re-chains the survivors, so `verifyAuditChain` reported the file intact and the result was
   * indistinguishable from ordinary trimming. Asserted below.
   */
  it("⚠ a file.mutate flood does not evict the decision records", () => {
    // The records an investigator would come looking for, written first so recency is against them.
    recordSecurityEvent({ event: "auth.signin", outcome: "success", userId: "u1" });
    recordSecurityEvent({ event: "project.grant", outcome: "success", userId: "u1" });
    recordSecurityEvent({ event: "agent.trust", outcome: "success", userId: "u1" });
    recordSecurityEvent({ event: "agent.spawn", outcome: "success", userId: "u1" });
    recordSecurityEvent({ event: "tool.permission", outcome: "success", userId: "u1" });
    recordSecurityEvent({ event: "chat.share", outcome: "success", userId: "u1" });

    // What renderer-resident code can emit at will, in enough volume to rotate several times over.
    for (let i = 0; i < BOUND * 4; i++) {
      recordSecurityEvent({ event: "file.mutate", outcome: "success", detail: `create:f${i}` });
    }

    const kept = records().map((r) => r.event);
    for (const decision of [
      "auth.signin",
      "project.grant",
      "agent.trust",
      "agent.spawn",
      "tool.permission",
      "chat.share",
    ]) {
      expect(kept, `${decision} must survive a flood four times the window`).toContain(decision);
    }
    // The flood is still retained, just no longer at the decisions' expense — the point is partition,
    // not a denylist on `file.mutate`.
    expect(kept.filter((e) => e === "file.mutate").length).toBeGreaterThan(BOUND / 2);
    // And the bound is still a bound.
    expect(records().length).toBeLessThanOrEqual(BOUND);
  });

  /** The partition must not become unlimited retention for anything — the file is still bounded. */
  it("⚠ trims decision records too once they alone exceed the window", () => {
    for (let i = 0; i < BOUND * 2; i++) {
      recordSecurityEvent({ event: "tool.permission", outcome: "success", detail: `p${i}` });
    }
    expect(records().length, "no class gets an unbounded promise").toBeLessThanOrEqual(BOUND);
  });

  /** A partitioned trim is still one chain, and the marker says what the partition preserved. */
  it("⚠ a partitioned trim still verifies, and says how many decisions it kept", () => {
    recordSecurityEvent({ event: "auth.signin", outcome: "success", userId: "u1" });
    for (let i = 0; i < BOUND * 3; i++) {
      recordSecurityEvent({ event: "file.mutate", outcome: "success", detail: `create:f${i}` });
    }
    const result = verifyAuditChain(readLog());
    expect(result.ok, result.reason).toBe(true);

    const first = JSON.parse(readLog().split("\n")[0]) as SecurityAuditRecord;
    expect(first.event).toBe("log.rotated");
    expect(first.detail, "the marker distinguishes a healthy trim from an eviction").toMatch(
      /decisions:\d+/
    );
  });

  it("a trimmed log still verifies, as one unbroken chain", () => {
    fill(BOUND + 25);
    const result = verifyAuditChain(readLog());
    expect(result.ok, result.reason).toBe(true);
    // Contiguous from 1 — which is what keeps a gap meaningful.
    expect(records().map((r) => r.seq)).toEqual(records().map((_, i) => i + 1));
  });

  it("⚠ DETECTS A DELETED RECORD AFTER A TRIM — the attack that used to verify clean", () => {
    /**
     * ── THE FINDING, AS A TEST ────────────────────────────────────────────────────────────────
     *
     * Previously: delete record k, then write `{carried: true, droppedThrough: k, continuesFrom: <k's
     * hash>}` — a value already visible as record k+1's `prev`. Two edits, no hashing, and
     * `verifyAuditChain` returned ok. This asserts the shortcut is gone.
     */
    fill(BOUND + 5);
    const lines = readLog().split("\n").filter(Boolean);
    const victim = JSON.parse(lines[3]) as SecurityAuditRecord;

    // The old forgery, verbatim.
    const forged = JSON.stringify({
      carried: true,
      at: new Date(0).toISOString(),
      droppedThrough: victim.seq,
      continuesFrom: victim.hash,
      note: "trimmed",
    });
    const tampered = [...lines.slice(0, 3), forged, ...lines.slice(4)].join("\n") + "\n";

    const result = verifyAuditChain(tampered);
    expect(result.ok, "a forged rotation marker must NOT verify").toBe(false);
    expect(result.brokenAt).toBe(victim.seq);
  });

  it("keeps 0600 through rotation", () => {
    // The rewrite is a second chance to widen the permissions.
    fill(BOUND + 5);
    expect(fs.statSync(auditLogPath()).mode & 0o077).toBe(0);
  });

  it("continues the chain across a restart AFTER a trim", () => {
    // `loadTail` must adopt the rewritten file's tail, not the pre-rotation one.
    fill(BOUND + 5);
    __resetAuditState();
    __setMaxAuditLines(BOUND);
    recordSecurityEvent({ event: "auth.signin", outcome: "success", userId: "user-9" });

    const rows = records();
    expect(rows.at(-1)?.prev).toBe(rows.at(-2)?.hash);
    expect(verifyAuditChain(readLog()).ok).toBe(true);
  });

  it("rotates repeatedly without losing the chain", () => {
    fill(BOUND * 3 + 10);
    const raw = readLog();
    expect(raw.split("\n").filter(Boolean).length).toBeLessThanOrEqual(BOUND + 1);
    expect(verifyAuditChain(raw).ok, "three rotations, chain intact").toBe(true);
  });

  it(
    "⚠ holds at the PRODUCTION bound too, including across a restart",
    () => {
      /**
       * One case at the real number, because the tracked line count is what decides when to rotate and
       * `loadTail` is what re-establishes it on a relaunch. An explicit timeout: this writes ~2040
       * records to a real file and is inherently a few seconds, which is stated rather than left to
       * fail under load.
       */
      __setMaxAuditLines(MAX_AUDIT_LINES);
      fill(MAX_AUDIT_LINES - 5);
      __resetAuditState();
      fill(40);

      const lines = readLog().split("\n").filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(MAX_AUDIT_LINES + 1);
      expect(verifyAuditChain(readLog()).ok).toBe(true);
    },
    30_000
  );
});

describe("⚠ it never fails the operation it is auditing", () => {
  it("swallows a write failure", () => {
    /**
     * If the disk is full, the right outcome is a sign-in that works with a gap in the log — not a
     * user locked out by their own audit trail. The gap is visible anyway: sequence numbers are
     * contiguous by construction.
     */
    fs.rmSync(userData, { recursive: true, force: true }); // the directory is gone
    expect(() => recordSecurityEvent({ event: "auth.signin", outcome: "success" })).not.toThrow();
  });

  it("swallows an unreadable existing log", () => {
    fs.mkdirSync(auditLogPath()); // a directory where the file should be
    expect(() => recordSecurityEvent({ event: "auth.signin", outcome: "success" })).not.toThrow();
  });
});

describe("⚠ what is deliberately NOT in the log", () => {
  it("records no token, password, email or name anywhere in the module", () => {
    /**
     * The log is plaintext and 0600 — easier to read than the encrypted settings rows, so putting a
     * credential or an email in it would move a secret to a weaker place while claiming to improve
     * security. `userId` (a Cognito `sub` UUID) is the one identifier recorded, so "who" is still
     * answerable.
     */
    const src = strip(readFileSync(local("./security-audit.ts"), "utf8"));
    for (const forbidden of ["auth_token", "user_email", "user_name", "idToken", "refreshToken", "password"]) {
      expect(src, `${forbidden} must not reach the audit log`).not.toContain(forbidden);
    }
  });

  it("logs no tool ARGUMENTS with a permission decision", () => {
    // The agent's title can contain a full shell command with paths in it. Whether a call was
    // approved is the audit fact; its contents are not, and they accumulate.
    const acp = strip(readFileSync(local("./handlers/kiro-acp.ts"), "utf8"));
    const call = acp.slice(acp.indexOf('event: "tool.permission"'));
    const block = call.slice(0, call.indexOf("});") + 3);
    expect(block).not.toContain("title");
    expect(block).not.toContain("request.");
  });
});

describe("every event the report named is actually recorded", () => {
  const AI = strip(readFileSync(local("./handlers/ai.ts"), "utf8"));
  const PLATFORM = strip(readFileSync(local("./handlers/platform.ts"), "utf8"));
  const ACP = strip(readFileSync(local("./handlers/kiro-acp.ts"), "utf8"));

  it("⚠ SIGN-IN, both success and failure, on BOTH paths", () => {
    /**
     * The report listed `auth:completeSignIn` and `ai:login` explicitly, and an auth audit log
     * missing its sign-ins is missing its main case.
     *
     * ⚠ THE COUNT DROPPED WHEN THE CHECKS WERE CONSOLIDATED, and that is the fix rather than a
     * regression. A later finding in the same review — "second session-adoption path skips the desktop
     * role gate and adoptSession's invariants" — was answered by moving every admission check into
     * `verifyIdTokenForAdoption`, so each handler now records ONE refusal carrying that function's
     * `detail` instead of a copy per reason. What matters is unchanged and is asserted directly below:
     * both paths record, and every distinct reason is still distinguishable in the log.
     */
    const signins = AI.match(/event: "auth\.signin"/g) ?? [];
    expect(signins.length).toBeGreaterThanOrEqual(4);
    expect((AI.match(/event: "auth\.signin",\s*outcome: "success"/g) ?? []).length).toBe(2);

    // One refusal record per adoption path, each carrying the shared verifier's reason.
    for (const handler of ['"auth:completeSignIn"', '"ai:login"']) {
      const body = AI.slice(AI.indexOf(handler));
      const refusal = body.indexOf('outcome: "refused"');
      expect(refusal, `${handler} must record a refusal`).toBeGreaterThan(-1);
      expect(body.slice(refusal, refusal + 200), handler).toContain("detail: verified.detail");
    }
    // The distinct refusal reasons, so a log reader can tell an expired token from a forged one.
    for (const reason of [
      "issuer-mismatch",
      "audience-mismatch",
      "not-an-id-token",
      "expired",
      "bad-signature",
      "keychain-unavailable",
    ]) {
      expect(AI, `${reason} must be distinguishable`).toContain(reason);
    }
    expect(AI).toMatch(/role-not-permitted/);
  });

  it("distinguishes the two sign-in paths from each other", () => {
    // Otherwise "a sign-in happened" cannot be tied to which door was used.
    expect(AI).toContain('detail: "browser-handoff"');
    expect(AI).toContain('detail: "hosted-ui"');
  });

  it("SIGN-OUT, recorded before the teardown while there is still a subject", () => {
    const body = AI.slice(AI.indexOf('ipcMain.handle("auth:signOut"'));
    const audit = body.indexOf('event: "auth.signout"');
    const teardown = body.indexOf("tearDownSession()");
    expect(audit).toBeGreaterThan(-1);
    expect(audit, "after the teardown there is no user_id left to record").toBeLessThan(teardown);
  });

  /**
   * ── ⚠ AND ONLY WHEN THERE WAS A SESSION TO END ────────────────────────────────────────────────
   *
   * `auth:signOut` recorded a `success` on EVERY call, including with nobody signed in (`revocation ===
   * "no-account"`), so ~2000 invokes evicted every genuine record from the rotation window while changing
   * nothing and attributing the event to no one.
   *
   * The teardown itself stays unconditional — only the empty record is gone.
   */
  it("⚠ writes no signout record when nobody was signed in", () => {
    const body = AI.slice(
      AI.indexOf('ipcMain.handle("auth:signOut"'),
      AI.indexOf('ipcMain.handle("ai:ping"')
    );
    const guard = body.indexOf("if (userId) {");
    const audit = body.indexOf('event: "auth.signout"');
    const teardown = body.indexOf("tearDownSession()");

    expect(guard, "the record must be guarded by having a subject").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(audit);
    expect(teardown, "but the teardown still runs either way").toBeGreaterThan(guard);
    expect(body, "a subject-less record is what the flood exploited").not.toMatch(
      /\.\.\.\(userId \? \{ userId \} : \{\}\)/
    );
  });

  it("ACCOUNT SWITCH and REMOVE", () => {
    expect(AI).toContain('event: "account.switch"');
    expect(AI).toContain('event: "account.remove"');
  });

  it("PLATFORM connect and reset, distinguishing a CHANGE from first-time setup", () => {
    // Moving an install to a different Cognito pool is the most consequential config change here.
    expect(PLATFORM).toContain('event: "platform.connect"');
    expect(PLATFORM).toContain('event: "platform.reset"');
    expect(PLATFORM).toMatch(/changed:\$\{config\.fingerprint\}/);
    expect(PLATFORM).toMatch(/initial:\$\{config\.fingerprint\}/);
  });

  it("TOOL PERMISSION decisions, including the ones nobody clicked", () => {
    /**
     * Recorded in `settle`, the single funnel — so a denial by timeout, by the window closing or by
     * the agent exiting is recorded too. Auditing only the button handlers would produce a log where
     * approvals are visible and refusals are missing.
     */
    const settle = ACP.slice(ACP.indexOf("const settle = (approved: boolean)"));
    expect(settle.slice(0, settle.indexOf("resolve(approved)"))).toContain('event: "tool.permission"');
  });

  /**
   * ── ⚠ THE FOUR EVENTS THE FIRST VERSION OF THIS LOG LEFT OUT ─────────────────────────────────
   *
   * The log shipped covering the credential lifecycle and nothing else, and the finding named the rest
   * explicitly: chat sharing, agent spawns, file mutation, document upload/delete. Those are the actions that
   * happen ONLY on this machine — no platform backend can hold a record of a local file being trashed or an
   * agent being launched — and they are what a participant actually asks about afterwards.
   */
  describe("the local actions the platform backend cannot know about", () => {
    const FILE_OPS = strip(readFileSync(local("./handlers/file-ops.ts"), "utf8"));
    const TEAM_DATA = strip(readFileSync(local("./handlers/team-data.ts"), "utf8"));
    const CLI = strip(readFileSync(local("./handlers/cli-assistant.ts"), "utf8"));
    const FRAMEWORK = strip(readFileSync(local("./handlers/framework.ts"), "utf8"));
    const CLAUDE = strip(readFileSync(local("./handlers/claude-code.ts"), "utf8"));

    it("CHAT SHARING, both publishing and withdrawing", () => {
      // Publishing a private transcript to a team is the least reversible thing in the app that is
      // not a delete.
      expect((AI.match(/event: "chat\.share"/g) ?? []).length).toBe(2);
      expect(AI).toMatch(/detail: `shared:/);
      expect(AI).toContain('detail: "unshared"');
    });

    it("EVERY FILE MUTATION, including the one that destroys", () => {
      /**
       * Counted, because five of the six would look complete. `trash` is the one a participant asks
       * about, so it is also named directly.
       */
      const mutations = FILE_OPS.match(/auditMutation\(/g) ?? [];
      // One helper definition plus one call per mutating handler: create-file, create-folder,
      // rename, move, copy, trash.
      expect(mutations.length).toBe(7);
      for (const action of ["create-file", "create-folder", "rename", "move", "copy", "trash"]) {
        expect(FILE_OPS, `${action} must be recorded`).toContain(`"${action}"`);
      }
      expect(FILE_OPS).toContain('event: "file.mutate"');
    });

    /**
     * ⚠ THE BASENAME, NOT THE PATH. `/Users/jane.doe/clients/acme-merger/valuation.xlsx` is a
     * person's name, an employer's name and a confidential project in one string — written into a
     * PLAINTEXT file that is easier to read than the encrypted database. It is also attacker-chosen
     * on some paths, so echoing it would make this log an injection sink for whatever renders it.
     */
    it("records a file by its NAME, never by its path", () => {
      expect(FILE_OPS).toContain("redactedTarget(target)");
      const helper = FILE_OPS.slice(FILE_OPS.indexOf("function auditMutation"));
      const body = helper.slice(0, helper.indexOf("\n}"));
      expect(body).not.toMatch(/\$\{target\}/);
    });

    it("DOCUMENT upload and delete", () => {
      expect((TEAM_DATA.match(/event: "docs\.change"/g) ?? []).length).toBe(2);
      expect(TEAM_DATA).toMatch(/detail: `upload:/);
      expect(TEAM_DATA).toMatch(/detail: `delete:/);
      // The stored key's name only — the local source path is a person's filesystem.
      expect(TEAM_DATA).toContain("redactedTarget(storedPath)");
    });

    /**
     * ⚠ EVERY RUNTIME, INCLUDING THE WELL-BEHAVED ONE. The finding was that two of three launched
     * with tool approval pre-granted; a log covering only those two would make the SDK path — which
     * keeps `permissionMode: "default"` and an unconditional `canUseTool` — look like the absent one.
     */
    it("AGENT SPAWNS on all three runtimes", () => {
      expect(CLI, "the two CLI spawn sites").toContain("recordAgentSpawn(");
      expect((CLI.match(/recordAgentSpawn\(/g) ?? []).length).toBe(3); // definition + 2 calls
      expect(ACP).toContain('event: "agent.spawn"');
      expect(FRAMEWORK).toContain('event: "agent.spawn"');
      expect(CLAUDE).toContain('event: "agent.spawn"');
    });

    /**
     * ⚠ AND THE TOOL POLICY IS PART OF THE RECORD, which is the half of the privileged-access finding
     * that an "agent started" line alone would not answer: an operator needs to know whether the
     * agent that touched a file had been asked first.
     */
    it("records the tool policy the argv actually carried", () => {
      expect(CLI).toContain("toolPolicyOf(args)");
      expect(ACP).toContain("toolPolicyOf(args)");
      // The SDK path prompts per tool, so its policy is a constant rather than a read.
      expect(CLAUDE).toContain("claude-sdk:ask");
    });
  });

  it("records the platform FINGERPRINT rather than the URL", () => {
    // A customer's hostname is not needed to identify a platform, and this file is plaintext.
    const at = PLATFORM.indexOf('event: "platform.connect",\n      outcome: "success"');
    expect(at).toBeGreaterThan(-1);
    // Bounded to the audit call itself. A wider slice runs into the handler's RETURN value, which
    // legitimately carries `apiBaseUrl` back to the renderer — that is not the log.
    const call = PLATFORM.slice(at, PLATFORM.indexOf("});", at));
    expect(call).not.toContain("apiBaseUrl");
    expect(call).toContain("fingerprint");
  });
});

// ── ⚠ THE AUDITED SUBJECT CANNOT CORRUPT THE DIGEST INPUT ─────────────────────────────────────
//
// `userId` was spread into the record and into `canonical()` verbatim, and both handlers take it
// straight from the renderer with no shape check, no length bound and no control-character strip.
//
// ⚠ IT BROKE AN INVARIANT THIS MODULE STATES ABOUT ITSELF, which is why it is worth more than its
// severity label. `canonical()` joins fields with \u0000 on the written assumption that \u0000 "cannot occur
// in any of these fields, so no combination of values can be arranged to produce the same digest as a
// different combination". The module already applies exactly this hygiene to its other
// renderer-influenced field — `redactedTarget` strips control characters and truncates, commented "\u0000
// would corrupt the digest input". `userId` was the one field the rule was not applied to.
//
// ⚠ AND THE CONTROL CHARACTERS BELOW ARE WRITTEN AS ESCAPE SEQUENCES, deliberately. A literal \u0000 in a
// source file makes git classify it as binary and show no diff for it — which is a real hazard for a
// test file about \u0000 handling, and was cleaned out of three files in this repo for exactly that reason.
describe("⚠ the userId field is normalised at the sink", () => {
  it("strips control characters, so the digest separator cannot appear in a field", () => {
    recordSecurityEvent({ event: "account.switch", outcome: "refused", userId: "\u0000forged" });

    const rec = JSON.parse(readLog().trim()) as SecurityAuditRecord;
    expect(rec.userId, "no \u0000 may survive into a hashed field").toBe("forged");
    expect(rec.userId).not.toContain("\u0000");
  });

  it("strips every control character, not only \u0000", () => {
    recordSecurityEvent({ event: "account.switch", outcome: "refused", userId: "abc\ttext" });

    const rec = JSON.parse(readLog().trim()) as SecurityAuditRecord;
    expect(rec.userId).toBe("abctext");
  });

  /**
   * ⚠ THE AMBIGUITY THIS CLOSES. With \u0000 admitted, a subject could carry the separator `canonical()`
   * relies on, so two different field combinations could produce the same digest input — precisely the
   * property the module claims is impossible. Normalising the subject is what makes the claim true.
   */
  it("⚠ a subject cannot smuggle the separator into the digest input", () => {
    recordSecurityEvent({ event: "account.switch", outcome: "refused", userId: "alice\u0000x" });
    recordSecurityEvent({ event: "account.switch", outcome: "refused", userId: "alicex" });

    const [first, second] = readLog()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as SecurityAuditRecord);
    expect(first.userId, "the separator is gone").toBe("alicex");
    expect(second.userId).toBe("alicex");
    // And the chain is still sound, because `prev` differs even when every other field matches.
    expect(second.prev).toBe(first.hash);
    expect(verifyAuditChain(readLog()).ok).toBe(true);
  });

  it("bounds an absurdly long subject", () => {
    recordSecurityEvent({ event: "account.switch", outcome: "refused", userId: "u".repeat(10_000) });

    const rec = JSON.parse(readLog().trim()) as SecurityAuditRecord;
    expect(rec.userId!.length).toBeLessThanOrEqual(64);
  });

  /**
   * ⚠ A SUBJECT THAT NORMALISES TO NOTHING IS OMITTED, not written empty. `userId: ""` would claim a
   * subject the log does not have; the absent field is how "no subject" has always been represented.
   */
  it("omits the field entirely when nothing survives normalisation", () => {
    recordSecurityEvent({ event: "account.switch", outcome: "refused", userId: "\u0000\u0000" });

    const rec = JSON.parse(readLog().trim()) as SecurityAuditRecord;
    expect(rec).not.toHaveProperty("userId");
  });

  it("leaves an ordinary Cognito subject untouched", () => {
    // A real `sub` is a UUID; normalisation must be a no-op on every legitimate value.
    const sub = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    recordSecurityEvent({ event: "auth.signin", outcome: "success", userId: sub });

    expect((JSON.parse(readLog().trim()) as SecurityAuditRecord).userId).toBe(sub);
  });

  it("the normalised value is what was hashed, not the raw one", () => {
    // Otherwise the record would verify against a value the file does not contain.
    recordSecurityEvent({ event: "account.switch", outcome: "refused", userId: "\u0000forged" });

    expect(verifyAuditChain(readLog()).ok, "the chain must verify over what was written").toBe(true);
  });
});

/**
 * ── ⚠ AND THE TWO HANDLERS REFUSE BEFORE THEY RECORD ──────────────────────────────────────────
 *
 * The eviction half. ~2000 consequence-free calls used to push all genuine history out of the rotation
 * window, and rotation re-chains the survivors so `verifyAuditChain` still reports clean — so the
 * accountability control was defeated while continuing to look intact.
 *
 * Asserted against the source: these are IPC handlers whose effects need a database and a keychain, and
 * the property is an ORDERING between a gate and an append.
 */
describe("⚠ the account handlers do not let a caller write records at will", () => {
  const AI = strip(readFileSync(local("./handlers/ai.ts"), "utf8"));

  for (const channel of ['"auth:switchAccount"', '"auth:removeAccount"']) {
    const body = AI.slice(AI.indexOf(channel), AI.indexOf(channel) + 3_000);

    it(`${channel} refuses a malformed id before recording anything`, () => {
      const gate = body.indexOf("isSafeRowId(accountId)");
      const record = body.indexOf("recordSecurityEvent(");
      expect(gate, "the shape gate must exist").toBeGreaterThan(-1);
      expect(record, "and there must still be a record on the real path").toBeGreaterThan(-1);
      expect(gate, "the gate comes first").toBeLessThan(record);
    });

    it(`${channel} refuses an id that names no account before recording anything`, () => {
      const known = body.indexOf("listAccounts().accounts.some(");
      const record = body.indexOf("recordSecurityEvent(");
      expect(known, "an unknown id must cost zero records").toBeGreaterThan(-1);
      expect(known).toBeLessThan(record);
    });
  }

  /**
   * ⚠ AND A REFUSAL NAMES NO SUBJECT. On a refusal the app never resolved anybody, so recording the
   * caller's string would let a chosen identity into the log for an event that did not happen to them.
   */
  it("auth:switchAccount records a subject only when the switch succeeded", () => {
    const body = AI.slice(AI.indexOf('"auth:switchAccount"'), AI.indexOf('"auth:removeAccount"'));
    expect(body).toMatch(/result\.ok \? \{ userId: accountId \} : \{\}/);
  });
});

/**
 * ── ⚠ A FLOOD OF IDENTICAL REFUSALS CANNOT EVICT THE HISTORY ───────────────────────────────────
 *
 * Several channels emit one record per invocation with no state change and no rate limit:
 * `cli:trustWorkspace`/`cli:untrustWorkspace` write an `agent.trust` refusal for any path failing
 * `isOpenProjectRoot`, and `auth:completeSignIn` writes an `auth.signin` refusal for any non-empty string,
 * because the issuer check is local and precedes any network call. So ~2000 cheap calls pushed every genuine
 * record out of the retained window — destroying the machine's only local evidence of boundary grants, before
 * or after doing something worth hiding.
 */
describe("⚠ repeated refusals are bounded, not allowed to evict the log", () => {
  const refuse = (n: number, detail = "declined:notes") => {
    for (let i = 0; i < n; i++) {
      recordSecurityEvent({ event: "agent.trust", outcome: "refused", detail });
    }
  };

  it("⚠ preserves genuine history through a 2000-call flood", () => {
    __setMaxAuditLines(MAX_AUDIT_LINES);
    recordSecurityEvent({ event: "auth.signin", outcome: "success", userId: "victim" });
    recordSecurityEvent({ event: "project.grant", outcome: "success", detail: "proj" });

    refuse(2000);

    const rows = records();
    expect(
      rows.find((r) => r.event === "auth.signin"),
      "the sign-in that mattered must still be there"
    ).toBeTruthy();
    expect(rows.find((r) => r.event === "project.grant")).toBeTruthy();
    // 2000 identical refusals collapse to a couple of dozen lines rather than 2000.
    expect(rows.length).toBeLessThan(40);
  });

  /**
   * ⚠ THE FACT IS NOT DROPPED, only the duplicates. The thinning walks powers of two, which always
   * writes the tail — so the largest observed count survives and the run is self-describing.
   */
  it("carries the repeat count, so a thinned run is still legible", () => {
    refuse(300);

    const details = records().map((r) => r.detail ?? "");
    expect(details.some((d) => d.includes("declined:notes"))).toBe(true);
    expect(
      details.some((d) => /x(128|256)$/.test(d)),
      `no count annotation in ${JSON.stringify(details.slice(-4))}`
    ).toBe(true);
  });

  /**
   * ⚠ ORDINARY USE IS UNTOUCHED. A participant who mistypes a folder a few times must appear in the
   * log individually — thinning that would be losing real detail to solve a flood that is not
   * happening.
   */
  it("records a short run verbatim", () => {
    refuse(5);
    expect(records()).toHaveLength(5);
  });

  /** A success is a state transition, so every one keeps its own line. */
  it("⚠ never coalesces successes", () => {
    for (let i = 0; i < 30; i++) {
      recordSecurityEvent({ event: "file.mutate", outcome: "success", detail: "same-file" });
    }
    expect(records()).toHaveLength(30);
  });

  it("does not conflate refusals that differ", () => {
    refuse(5, "declined:a");
    refuse(5, "declined:b");
    recordSecurityEvent({ event: "auth.signin", outcome: "refused", detail: "declined:a" });

    // Three distinct shapes, none of them past the threshold: nothing is suppressed.
    expect(records()).toHaveLength(11);
  });

  /**
   * ── ⚠ AND IT CANNOT BE EVADED BY VARYING THE PAYLOAD ──────────────────────────────────────────
   *
   * The per-shape thinning keys on `detail`, and the loudest reported channel supplies an
   * attacker-varied one: `cli:trustWorkspace` records `declined:${redactedTarget(folderPath)}`, the
   * basename of a caller-supplied path. So a caller that varies the path gets a fresh key every time
   * and never reaches a burst threshold — which is why the global per-window refusal budget exists.
   *
   * This case is the one that would have caught a coalescer built on shape alone.
   */
  it("⚠ bounds a flood whose detail changes every call", () => {
    __setMaxAuditLines(MAX_AUDIT_LINES);
    recordSecurityEvent({ event: "auth.signin", outcome: "success", userId: "victim" });

    for (let i = 0; i < 2000; i++) {
      // A different "path" each time — no two records share a key.
      recordSecurityEvent({ event: "agent.trust", outcome: "refused", detail: `declined:f${i}` });
    }

    const rows = records();
    expect(rows.length, "the budget must hold regardless of shape").toBeLessThan(80);
    expect(rows.find((r) => r.event === "auth.signin"), "history survives").toBeTruthy();
    // A throttled window is never mistakable for a quiet one.
    expect(rows.some((r) => (r.detail ?? "").includes("throttled-after:"))).toBe(true);
  });

  /** Successes are exempt from the budget, so a legitimate agent run is recorded in full. */
  it("⚠ does not budget successes", () => {
    __setMaxAuditLines(MAX_AUDIT_LINES);
    for (let i = 0; i < 300; i++) {
      recordSecurityEvent({ event: "file.mutate", outcome: "success", detail: `wrote:f${i}` });
    }
    expect(records()).toHaveLength(300);
  });

  /** The chain stays verifiable — thinning is a decision not to append, not a rewrite. */
  it("keeps the chain intact", () => {
    refuse(100);
    expect(verifyAuditChain(readLog()).ok).toBe(true);
  });
});
