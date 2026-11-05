// ── ⚠ WHICH MUTATIONS EMIT AN AUDIT EVENT, ASSERTED RATHER THAN CLAIMED ───────────────────────
//
// A code review found six of the most consequential mutations this BFF exposes emitting nothing:
// `submission.publishResults` (publishes the final ranking and completes the experience),
// `submission.score`, `submission.patch`, `workshop.setPhases`, `workshop.setCurrentPhase` and
// `team.revokeInvitation`, the last destroying a live invitation credential while
// `removeMember`/`reactivateMember` one resolver away were both audited.
//
// WHAT MADE IT INVISIBLE was not the absence itself but the absence of any way to see it.
// `audit-logger.ts`'s header claimed coverage of "(d) Privileged mutations", and the only way to
// test that claim was to grep for `auditLog(` and read every resolver in full. `AUDIT_EVENTS` now
// makes the emitted vocabulary reviewable; this file makes the COVERAGE reviewable.
//
// ⚠ `UNAUDITED_MUTATIONS` IS A REGISTRY, NOT AN APPROVAL. Every name in it is a mutation that emits
// no audit event TODAY. Some are settled decisions, some are open questions flagged below, the
// point of the list is that the set is exact and cannot grow by accident. A new unaudited mutation
// fails this test, and a mutation that gains an event must be removed from the list, so neither
// direction can drift silently. It is deliberately NOT phrased as "deliberately exempt": pretending
// an open question is a decision is how the original gap survived a documentation claim.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_EVENTS } from "./audit-logger";

const ROUTERS = join(__dirname, "trpc", "routers");

/**
 * Mutations that emit no audit event today, each with why.
 *
 * SETTLED, the portal is not the system of record for these, and an event per call would be
 * volume without attribution value:
 *   · `auth.updateProfile`, the caller editing their OWN name/organisation. Self-service.
 *   · `feedback.submit`, the caller's own feedback; the ticket IS the record.
 *   · `team.acceptMyInvitations`- the caller accepting invitations already issued to them; the
 *                                 issuance is audited (`account.invite.issued`) and the resulting
 *                                 membership is audited (`team.joined`).
 *   · `ai.createThread`, an assistant conversation the caller owns; token usage and thread
 *                                 lifecycle are the AI service's own telemetry.
 *   · `git.sync`, a read-through refresh of a team's repository view.
 *   · `submission.ensure`, idempotent "create the row if absent"; carries no caller content
 *                                 and no state a later investigation would ask about.
 *
 * ── ⚠ THREE ENTRIES LEFT THIS LIST ───────────────────────────────────────────────────────────
 * `workshop.update`, `rating.publish` and `team.create` were in the OPEN group below, with the
 * note that the decision "belongs to whoever owns the trail rather than to this test". A security
 * review named them (Low, "Privileged portal mutations (workshop.update,
 * rating.publish, team.create) emit no audit event, contradicting the tier's own audit
 * catalogue"), which is that decision arriving: all three now emit, and this list no longer
 * exempts them. `rating.analyze` was NOT named and stays.
 *
 * OPEN, not named by any finding, so NOT changed, but each is a defensible candidate and the
 * decision belongs to whoever owns the trail rather than to this test:
 *   · `rating.analyze`, generates AI analysis for a team. It is on `billableProcedure`,
 *                                 so a caller REFUSED by its rate limiter is recorded
 *                                 (`authz.trpc.rate_limited`, emitted from `trpc.ts`); a
 *                                 successful analysis still emits nothing, which is why it stays.
 *                                 Its sibling `publish`, the DISCLOSURE, is now audited.
 *   · `message.send`, `task.create`, `task.update`, `task.delete`, team-workspace content writes.
 *                                 High volume; the collaboration service holds the content. Note
 *                                 that the DESKTOP twins of the first two ARE audited, because that
 *                                 tier has no verified actor at all and needed a record more.
 *   · `feedback.acknowledge`, staff marking feedback handled.
 *   · `resources.beginUpload`, OPENS a multipart upload and creates nothing anyone can see. The
 *                                 event is `resources.completeUpload`, which IS audited: that is the
 *                                 moment the file exists and becomes visible to every role on the
 *                                 experience. Auditing the begin would record intentions, including
 *                                 the many abandoned halfway up a venue's wifi.
 *   · `resources.abortUpload`, housekeeping. Discards parts of an upload that never completed, so
 *                                 no state any user can observe changes. Its only effect is to stop
 *                                 S3 billing for orphaned parts sooner than the bucket lifecycle rule
 *                                 would.
 */
const UNAUDITED_MUTATIONS: readonly string[] = [
  "ai.createThread",
  "auth.updateProfile",
  "feedback.submit",
  "feedback.acknowledge",
  "git.sync",
  "message.send",
  "rating.analyze",
  "resources.beginUpload",
  "resources.abortUpload",
  "submission.ensure",
  "task.create",
  "task.update",
  "task.delete",
  "team.acceptMyInvitations",
];

/**
 * Every mutation in every router, and whether its resolver emits an audit event.
 *
 * Source-scanned rather than exercised: asserting this by CALLING each resolver would need a
 * session, a token and a stubbed backend per procedure, which is what made "read every resolver"
 * the only available check in the first place. Procedures are split on their declaration at
 * two-space indent, so each block is one procedure's chain from `.input` to the end of `.mutation`.
 *
 * ⚠ EVERY PROCEDURE BASE MUST BE LISTED IN `PROCEDURE_BASES` OR THE SCAN SILENTLY MERGES BLOCKS.
 * Adding `billableProcedure` for `rating.analyze` proved this the hard way: the splitter did not know
 * the name, so `analyze`'s chain was absorbed into the preceding `summary` block, which made a QUERY
 * look like a mutation (it now contained `.mutation(`) and made the real mutation disappear. Both
 * directions were wrong, and neither was obvious from the failure. `the bases are exactly ...` below
 * is the guard that turns a new base into a named failure instead of a miscount.
 */
const PROCEDURE_BASES = [
  "protectedProcedure",
  "billableProcedure",
  "publicProcedure",
  "t.procedure",
] as const;

function mutations(): Array<{ name: string; audited: boolean }> {
  const found: Array<{ name: string; audited: boolean }> = [];
  const bases = PROCEDURE_BASES.map((b) => b.replace(".", "\\.")).join("|");

  for (const file of readdirSync(ROUTERS).filter((f) => f.endsWith(".ts") && !f.includes(".test."))) {
    const router = file.replace(/\.ts$/, "");
    const src = readFileSync(join(ROUTERS, file), "utf8");
    const blocks = src.split(new RegExp(`\\n(?= {2}[A-Za-z_][A-Za-z0-9_]*: (?:${bases}))`));  // nosemgrep: missing-template-string-indicator

    for (const block of blocks.slice(1)) {
      const declared = /^ {2}([A-Za-z_][A-Za-z0-9_]*):/.exec(block);
      if (!declared || !block.includes(".mutation(")) continue;
      found.push({ name: `${router}.${declared[1]}`, audited: block.includes("auditLog(") });
    }
  }

  return found;
}

describe("audit coverage over tRPC mutations", () => {
  it("finds the mutations at all, a scan that matches nothing would pass everything", () => {
    // The failure mode of a source-scanning test is silent vacuity: rename `protectedProcedure` and
    // this file goes green while asserting nothing. Pinned loosely so it survives a new router.
    const all = mutations();
    expect(all.length).toBeGreaterThan(20);
    expect(all.map((m) => m.name)).toContain("submission.publishResults");
  });

  it("⚠ KNOWS EVERY PROCEDURE BASE THE ROUTERS USE, an unknown one miscounts silently", () => {
    // Derived from the routers, so a new base (`billableProcedure` was one) fails here with its own
    // name rather than surfacing as a mutation that mysteriously appeared or vanished.
    const used = new Set<string>();
    let mutationCalls = 0;
    for (const file of readdirSync(ROUTERS).filter((f) => f.endsWith(".ts") && !f.includes(".test."))) {
      const src = readFileSync(join(ROUTERS, file), "utf8");
      // Only the procedure declarations: `t.procedure`, or a name ending in `Procedure`. A bare
      // `^  name: Type` also matches interface fields and object literals, which is what the first
      // draft of this test learned by failing on `Array` and `CostLine`.
      for (const [, base] of src.matchAll(
        /^ {2}[A-Za-z_][A-Za-z0-9_]*: (t\.procedure|[A-Za-z_][A-Za-z0-9_]*Procedure)\b/gm
      )) {
        used.add(base);
      }
      // Not `^\s*\.mutation\(`: `team.acceptMyInvitations` chains it on the declaration line
      // (`protectedProcedure.mutation(...)`, no `.input`), and anchoring to the line start missed it.
      mutationCalls += [...src.matchAll(/\.mutation\(/g)].length;
    }
    expect([...used].filter((b) => !PROCEDURE_BASES.includes(b as never)).sort()).toEqual([]);

    /**
     * ⚠ AND A COUNT THAT DOES NOT DEPEND ON THE NAME AT ALL, because the check above only catches a
     * base someone calls `…Procedure`. Every `.mutation(` in the routers must have been reached by the
     * splitter, if one is missing, its block was absorbed into a neighbour and this file is silently
     * measuring the wrong thing, which is exactly the failure `billableProcedure` caused.
     */
    expect(mutations().length, "every .mutation( should belong to a discovered procedure block")
      .toBe(mutationCalls);
  });

  it("audits every mutation that is not in the registry", () => {
    const missing = mutations()
      .filter((m) => !m.audited && !UNAUDITED_MUTATIONS.includes(m.name))
      .map((m) => m.name);

    // If this fails on a mutation you just added: either emit an event (see the audited neighbours
    // for the shape) or add it to UNAUDITED_MUTATIONS **with a reason**. Do not add it silently -
    // an unexplained entry is the documentation gap this whole test exists to prevent.
    expect(missing).toEqual([]);
  });

  it("keeps the registry exact, an audited mutation must not still be listed as unaudited", () => {
    const audited = mutations().filter((m) => m.audited).map((m) => m.name);
    const stale = UNAUDITED_MUTATIONS.filter((name) => audited.includes(name));
    expect(stale).toEqual([]);
  });

  it("lists no mutation that no longer exists", () => {
    // A renamed or deleted resolver must not leave a stale exemption behind for a future
    // same-named procedure to inherit.
    const names = mutations().map((m) => m.name);
    expect(UNAUDITED_MUTATIONS.filter((n) => !names.includes(n))).toEqual([]);
  });

  it("covers the six mutations the finding named, plus the desktop writes", () => {
    // The regression test for the actual report. These are the resolvers that emitted nothing.
    const audited = new Set(mutations().filter((m) => m.audited).map((m) => m.name));
    for (const name of [
      "submission.publishResults",
      "submission.score",
      "submission.patch",
      "workshop.setPhases",
      "workshop.setCurrentPhase",
      "team.revokeInvitation",
    ]) {
      expect(audited.has(name), `${name} must emit an audit event`).toBe(true);
    }

    // The desktop tier is REST, not tRPC, so it is not in the scan above, assert its event names
    // are at least declared, and `desktop-audit.test.ts` asserts the routes emit them.
    for (const event of ["desktop.message.sent", "desktop.task.created", "desktop.team.joined"]) {
      expect(AUDIT_EVENTS).toContain(event);
    }
  });
});

describe("AUDIT_EVENTS, the catalogue itself", () => {
  it("has no duplicates", () => {
    expect(new Set(AUDIT_EVENTS).size).toBe(AUDIT_EVENTS.length);
  });

  it("uses dot-namespaced lower-case names, so a log query can prefix-match a domain", () => {
    for (const event of AUDIT_EVENTS) {
      expect(event, event).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
    }
  });

  it("declares every name the source actually emits", () => {
    // The type already enforces this at compile time; asserted here so the failure is a named test
    // rather than a build error somebody works around with a cast.
    const declared = new Set<string>(AUDIT_EVENTS);
    const emitted = new Set<string>();

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
          const src = readFileSync(path, "utf8");
          for (const [, name] of src.matchAll(/event:\s*"([^"]+)"/g)) emitted.add(name);
          // The one ternary form: `event: input.enabled ? "a" : "b"`.
          for (const [, a, b] of src.matchAll(/event:\s*[^"\n]*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g)) {
            emitted.add(a);
            emitted.add(b);
          }
        }
      }
    };
    walk(join(__dirname, ".."));

    expect([...emitted].filter((e) => !declared.has(e))).toEqual([]);
  });
});
