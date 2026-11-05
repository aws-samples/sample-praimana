import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE SENTENCE AN OPERATOR READS after disabling or restoring platform access.
 *
 * This is the whole output of the action. The badge is a display mirror that can lag (the
 * user-access service reports `statusMirrored` separately), the row may have been swapped
 * by the refetch, and the dialog is gone, so this string is the only thing that tells the
 * operator what actually happened. Two of the four states it must express are ones a
 * count cannot: `audited: false` means an access change is in the system with NO RECORD of
 * who made it, and `invitationsRevokeComplete: false` means a live credential SURVIVED the
 * disable, so the person just locked out can re-register, receive a brand-new Cognito sub,
 * and step out from under the block entirely.
 *
 * The two arriving TOGETHER is the case worth testing, because that is where a message
 * assembled by concatenation goes wrong: a missing separator, a doubled "However", a
 * sentence that starts mid-clause, or, worst, one gap silently overwriting the other.
 *
 * ── WHY THE BUILDER IS MIRRORED ──
 * It is inline in `trpc.admin.setUserAccess.useMutation`'s onSuccess in a "use client"
 * page. There is no DOM environment in this suite (`vitest.config.ts`: `environment:
 * "node"`, `include: ["src/**\/*.test.ts"]`, and no jsdom/happy-dom/@testing-library in the
 * dependency tree), so rendering the page is not an option. The mirror is paired with
 * source pins below so it cannot drift away from what it describes.
 */

const readCode = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");

const ADMIN_PAGE = "../app/admin/page.tsx";

/** What `admin.setUserAccess` resolves to, see the BFF's return in routers/admin.ts. */
interface AccessResult {
  enabled: boolean;
  invitationsRevoked: number;
  invitationsRevokeComplete: boolean;
  audited: boolean;
}

/** Mirrors the outcome built in admin/page.tsx's setUserAccess onSuccess. */
function accessOutcome(
  name: string,
  result: AccessResult
): { kind: "confirmed" | "partial"; message: string } {
  if (result.enabled) {
    return {
      kind: result.audited ? "confirmed" : "partial",
      message: result.audited
        ? `${name} can sign in again.`
        : `${name} can sign in again, but the change could not be written to the audit trail, there is no record of who restored it. Report it.`,
    };
  }

  const revoked =
    result.invitationsRevoked > 0
      ? ` ${result.invitationsRevoked} pending invitation${result.invitationsRevoked === 1 ? "" : "s"} destroyed, a new invitation is needed to re-register.`
      : "";

  const gaps: string[] = [];
  if (!result.invitationsRevokeComplete) {
    gaps.push(
      "at least one pending invitation could NOT be revoked and still admits a registration, they can re-register under a new account, which would escape this block. Revoke it by hand and report this."
    );
  }
  if (!result.audited) {
    gaps.push(
      "the change could not be written to the audit trail, there is no record of who made it. Report it."
    );
  }

  return {
    kind: gaps.length === 0 ? "confirmed" : "partial",
    message:
      gaps.length === 0
        ? `${name} can no longer sign in.${revoked}`
        : `${name} can no longer sign in.${revoked} However, ${gaps.join(" Also, ")}`,
  };
}

/** A clean disable: everything the action promised actually happened. */
const clean: AccessResult = {
  enabled: false,
  invitationsRevoked: 2,
  invitationsRevokeComplete: true,
  audited: true,
};

// ─── invitationsRevokeComplete: false → PARTIAL, naming the consequence ─────────

describe("a SURVIVING invitation renders as PARTIAL", () => {
  it("is PARTIAL, never confirmed, even though the disable itself worked", () => {
    // The service's own framing: the access change succeeded, but the guarantee attached
    // to it did not. Reporting this as a clean success is how a live credential goes
    // unnoticed; reporting it as a FAILURE would have the operator retry, which cannot
    // revoke the survivor and would write a second audit entry.
    const { kind } = accessOutcome("Alice", {
      ...clean,
      invitationsRevokeComplete: false,
    });
    expect(kind).toBe("partial");
  });

  it("is PARTIAL even when the count says invitations WERE destroyed", () => {
    // The exact case the count cannot express: "2 destroyed" reads identically whether a
    // third survived or there were only two. A partial that turns clean once the count is
    // non-zero would hide the survivor behind evidence of success.
    for (const invitationsRevoked of [0, 1, 2, 50]) {
      expect(
        accessOutcome("Alice", {
          ...clean,
          invitationsRevoked,
          invitationsRevokeComplete: false,
        }).kind,
        `count=${invitationsRevoked}`
      ).toBe("partial");
    }
  });

  it("names the SURVIVING-CREDENTIAL consequence, not just 'something failed'", () => {
    // What the operator must act on: the invitation is still redeemable, redeeming it
    // mints a new sub, and the disable is keyed on the old one, so the lockout undoes
    // itself. A message that said "revocation incomplete" would be a status, not an
    // instruction.
    const { message } = accessOutcome("Alice", {
      ...clean,
      invitationsRevokeComplete: false,
    });
    expect(message).toContain("still admits a registration");
    expect(message).toContain("re-register under a new account");
    expect(message).toContain("escape this block");
    // And it says what to DO. A partial with no next step is a partial nobody actions.
    expect(message).toContain("Revoke it by hand");
  });

  it("still confirms the disable itself, so the operator knows what DID happen", () => {
    // A partial is not a failure. Losing the "they can no longer sign in" clause would
    // read as "nothing happened", which is the reading that produces a retry.
    const { message } = accessOutcome("Alice", {
      ...clean,
      invitationsRevokeComplete: false,
    });
    expect(message).toContain("Alice can no longer sign in.");
  });

  it("is CONFIRMED when the revocation completed and the change was audited", () => {
    // The negative control. Without it, "always partial" would pass every test above and
    // teach the operator that the amber panel means nothing.
    const { kind, message } = accessOutcome("Alice", clean);
    expect(kind).toBe("confirmed");
    expect(message).not.toContain("However");
    expect(message).toBe(
      "Alice can no longer sign in. 2 pending invitations destroyed, a new invitation is needed to re-register."
    );
  });
});

// ─── audited: false + invitationsRevokeComplete: false, TOGETHER ────────────────

describe("BOTH gaps arriving together produce ONE coherent message", () => {
  const both = accessOutcome("Alice", {
    ...clean,
    invitationsRevokeComplete: false,
    audited: false,
  });

  it("reports both gaps, neither silently replaces the other", () => {
    // The failure mode a ternary would produce: two independent facts, one slot, one of
    // them lost. The audit gap is the quieter of the two and would be the casualty.
    expect(both.message).toContain("still admits a registration");
    expect(both.message).toContain("could not be written to the audit trail");
  });

  it("is a single well-formed sentence run, not a mangled concatenation", () => {
    // Assert the SHAPE rather than the whole string, so wording can be improved without
    // breaking this: one "However," pivot, an "Also," joining the second gap, and no
    // doubled or dangling punctuation from the pieces meeting.
    expect(both.message.match(/However,/g)).toHaveLength(1);
    expect(both.message.match(/Also,/g)).toHaveLength(1);
    expect(both.message).not.toMatch(/\.\./);
    expect(both.message).not.toMatch(/\s{2}/);
    expect(both.message).not.toMatch(/,\s*(However|Also)/i);
    // Every clause boundary is a real one: no lower-case sentence start after a full stop.
    expect(both.message).not.toMatch(/\.\s+[a-z]/);
  });

  it("puts the SURVIVING CREDENTIAL first, it is the more serious of the two", () => {
    // Deliberate ordering. An unredeemed invitation means the lockout can undo itself; a
    // missing audit row is serious but does not restore access. If the operator reads only
    // the first clause, it must be the one that needs acting on today.
    const survivor = both.message.indexOf("still admits a registration");
    const audit = both.message.indexOf("audit trail");
    expect(survivor).toBeGreaterThan(-1);
    expect(audit).toBeGreaterThan(survivor);
  });

  it("names the person, since the notice outlives the row it is about", () => {
    // Rendered above the list, and the row it refers to is replaced by the refetch, gone
    // on a page turn, or filtered out by a search. A message that said "the user" would
    // be unattributable by the time it is read.
    expect(both.message.startsWith("Alice can no longer sign in.")).toBe(true);
  });

  it("is PARTIAL, and reads as one incident rather than two notices", () => {
    expect(both.kind).toBe("partial");
    // One panel, one string. Two ActionOutcome slots would race each other and the second
    // would replace the first.
    expect(typeof both.message).toBe("string");
  });

  it("reads correctly when the audit gap arrives ALONE", () => {
    // The single-gap path through the same join: "However," with no "Also,".
    const { kind, message } = accessOutcome("Alice", { ...clean, audited: false });
    expect(kind).toBe("partial");
    expect(message.match(/However,/g)).toHaveLength(1);
    expect(message).not.toContain("Also,");
    expect(message).toContain("no record of who made it");
    expect(message).not.toMatch(/\.\s+[a-z]/);
  });

  it("reads correctly when NOTHING was revoked and both gaps fired", () => {
    // `invitationsRevoked: 0` empties the `revoked` clause, so the "However," lands
    // directly after the first sentence, the join most likely to produce a double space
    // or a missing one.
    const { message } = accessOutcome("Alice", {
      enabled: false,
      invitationsRevoked: 0,
      invitationsRevokeComplete: false,
      audited: false,
    });
    expect(message).toContain("sign in. However, at least one");
    expect(message).not.toMatch(/\s{2}/);
    expect(message).not.toMatch(/\.\./);
  });
});

describe("the revoked-count clause", () => {
  it("is SINGULAR for one invitation and plural for more", () => {
    // "1 pending invitations destroyed" in a permanent-consequence sentence undermines
    // the sentence.
    expect(
      accessOutcome("Alice", { ...clean, invitationsRevoked: 1 }).message
    ).toContain("1 pending invitation destroyed");
    expect(
      accessOutcome("Alice", { ...clean, invitationsRevoked: 2 }).message
    ).toContain("2 pending invitations destroyed");
  });

  it("is omitted entirely at zero, rather than saying '0 destroyed'", () => {
    // Nothing was destroyed, so there is nothing to warn about; "0 pending invitations
    // destroyed" is noise on the common case and would train the operator to skip the
    // clause that matters when it is non-zero.
    const { message } = accessOutcome("Alice", { ...clean, invitationsRevoked: 0 });
    expect(message).toBe("Alice can no longer sign in.");
    expect(message).not.toContain("0 pending");
  });

  it("says a fresh invitation is needed, because re-enabling does not restore them", () => {
    // The irreversible half of a reversible action, and the one the confirmation dialog
    // promised to report back on.
    expect(accessOutcome("Alice", clean).message).toContain(
      "a new invitation is needed to re-register"
    );
  });
});

// ─── The RESTORE direction ──────────────────────────────────────────────────────

describe("restoring access", () => {
  const enabled: AccessResult = {
    enabled: true,
    invitationsRevoked: 0,
    invitationsRevokeComplete: true,
    audited: true,
  };

  it("is CONFIRMED and says the one thing that changed", () => {
    expect(accessOutcome("Alice", enabled)).toEqual({
      kind: "confirmed",
      message: "Alice can sign in again.",
    });
  });

  it("is PARTIAL on an audit gap, phrased for the RESTORE direction", () => {
    // "who restored it", not "who made it": the audit row is the answer to a different
    // question in each direction, and an operator reading a restore's notice should not
    // have to translate a disable's wording.
    const { kind, message } = accessOutcome("Alice", { ...enabled, audited: false });
    expect(kind).toBe("partial");
    expect(message).toContain("no record of who restored it");
    expect(message).not.toMatch(/\s{2}/);
  });

  it("NEVER raises a surviving-invitation gap on a restore", () => {
    // There is nothing to revoke on an enable, the service leaves the flag alone and the
    // BFF defaults an ABSENT field to false (fail-closed, correctly, for the disable
    // direction). Reading that flag on the enable path would fire a false alarm about a
    // credential nobody tried to revoke, on the recovery action, against an older service.
    const { kind, message } = accessOutcome("Alice", {
      ...enabled,
      invitationsRevokeComplete: false,
    });
    expect(kind).toBe("confirmed");
    expect(message).not.toContain("admits a registration");
  });
});

// ─── The builder is still the one in the page ───────────────────────────────────

describe("admin/page.tsx still builds the message this mirror describes", () => {
  it("reads BOTH gap flags and collects them rather than choosing between them", () => {
    const source = readCode(ADMIN_PAGE);
    expect(source).toContain("if (!result.invitationsRevokeComplete)");
    expect(source).toContain("if (!result.audited)");
    // A list, joined, the shape that cannot lose the second fact.
    expect(source).toContain("const gaps: string[] = []");
    expect(source).toContain('gaps.join(" Also, ")');
  });

  it("derives the outcome KIND from the gap list, not from `audited` alone", () => {
    // The one-character version of this defect: `kind: result.audited ? ... ` would report
    // a surviving credential as a clean success whenever the audit row was written.
    const source = readCode(ADMIN_PAGE);
    expect(source).toContain('kind: gaps.length === 0 ? "confirmed" : "partial"');
  });

  it("still forwards invitationsRevokeComplete from the BFF, fail-closed", () => {
    // The page cannot report a gap it is never told about. `=== true` rather than `?? true`
    // is what makes an older service version report the survivor rather than hide it.
    const bff = readCode("./trpc/routers/admin.ts");
    expect(bff).toContain("invitationsRevokeComplete: data.invitationsRevokeComplete === true");
  });

  it("renders the outcome ABOVE the list, where a destroyed row cannot take it down", () => {
    const source = readCode(ADMIN_PAGE);
    expect(source).toContain("<ActionOutcome");
    expect(source).toContain("outcome={accessOutcome}");
    // Dismissible: a notice the operator cannot clear is still on screen during the next
    // action and will be read as being about that one.
    expect(source).toContain("onDismiss={() => setAccessOutcome(null)}");
  });
});

describe("ActionOutcome gives PARTIAL its own treatment", () => {
  // The component's map is a module-private const, so this is a source pin. What matters
  // is that partial is neither the green success nor the red failure: an operator who sees
  // green does not act, and one who sees red retries, and a retry acts a second time
  // without fixing either gap.
  const source = readCode("../components/ActionOutcome.tsx");

  it("has four distinct states, partial among them", () => {
    expect(source).toContain(
      'export type ActionOutcomeKind = "confirmed" | "partial" | "failed" | "unknown"'
    );
  });

  it("labels partial in WORDS, not by colour alone", () => {
    expect(source).toContain('label: "Done, with a gap"');
  });

  it("does not dress partial as a clean success or as a failure", () => {
    /* ⚠ ASSERTED IN SEMANTIC TOKENS NOW, NOT HUES. This read `toContain("amber")` /
       `not.toContain("green")` / `not.toContain("red")`, which stopped compiling against the
       source once the palette moved to tokens, the component says `warn` / `success` / `danger`
       rather than naming a colour.

       The pin is BETTER for it: "amber" was only ever a proxy for "not the success treatment and
       not the failure treatment", and the token names say that outright. The intent is unchanged
       and is the reason the test exists: an operator who sees the success treatment does not act,
       and one who sees the failure treatment retries, and a retry acts a second time without
       fixing either gap. */
    const partialBlock = source.slice(
      source.indexOf("partial: {"),
      source.indexOf("failed: {")
    );
    expect(partialBlock).toContain("warn");
    expect(partialBlock).not.toContain("success");
    expect(partialBlock).not.toContain("danger");
  });

  it("auto-dismisses nothing, every state waits to be acknowledged", () => {
    // A partial or unknown outcome on an access change is not a toast. A timer would take
    // the only report of a surviving credential off the screen while the operator was
    // reading the row it referred to.
    expect(source).not.toContain("setTimeout");
  });
});
