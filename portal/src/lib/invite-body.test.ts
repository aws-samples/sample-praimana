// ── ⚠ THE BOUNDS ON THE ONE MUTATING ROUTE THAT HAD NONE ─────────────────────────────────────
//
// A code review found `POST /api/invite` parsing its body with a bare destructure of
// `await req.json()`, the only mutating surface in the app with no schema, while the sibling
// bulk-CSV path enforced MAX_BULK_ROWS, MAX_EMAIL_CHARS and a format check. That asymmetry is what
// showed it was an omission rather than a design.
//
// WHY THE CAP IS A SECURITY CONTROL AND NOT INPUT HYGIENE. Every downstream side effect scales
// one-for-one with the list:
//
//   · one invitation row written per address;
//   · `provisionAccounts` runs several sequential Cognito admin calls per address against a
//     POOL-WIDE quota that `provision.ts` itself describes as "the same one that would block a
//     real user's sign-in", so a large batch is a self-inflicted auth outage for every user;
//   · `runPaced` sends one SES email per address with a 1100ms gap, awaited inline, each carrying
//     a working join link and, for a new account, a live temporary password.
//
// So an unbounded `emails[]` is an availability attack and a bulk-credential-mail primitive at the
// same time, reachable by EXECUTIVE (described in the same repo as a "read-only observer").

import { describe, it, expect } from "vitest";
import { inviteBodySchema } from "./invite-body";
import { MAX_BULK_ROWS, MAX_CELL_CHARS, MAX_EMAIL_CHARS } from "./bulk-invite/contract";

/** The reasons a body was refused, or `null` when it parsed. */
function reject(body: unknown): string[] | null {
  const result = inviteBodySchema.safeParse(body);
  return result.success ? null : result.error.issues.map((i) => i.message);
}

const emails = (n: number) => Array.from({ length: n }, (_, i) => `p${i}@example.com`);

describe("inviteBodySchema, the recipient list", () => {
  it("accepts what the two real forms send", () => {
    // Administration → Invitations (platform-scoped), and the team workspace form.
    expect(reject({ emails: ["a@example.com"], platformRole: "JUDGE", workshopId: "w1" })).toBeNull();
    expect(
      reject({
        emails: ["a@example.com", "b@example.com"],
        teamId: "t1",
        teamName: "Team Phoenix",
        inviteCode: "CODE1234",
        workshopId: "w1",
        platformRole: "PARTICIPANT",
        teamRole: "BUILDER",
      })
    ).toBeNull();
  });

  it(`caps the list at MAX_BULK_ROWS (${MAX_BULK_ROWS}), the bulk path's own ceiling`, () => {
    // Same sinks, same per-pool quotas, so the safe batch size is identical. A caller must not be
    // able to bypass the CSV path's cap by switching to the JSON one.
    expect(reject({ emails: emails(MAX_BULK_ROWS), platformRole: "PARTICIPANT" })).toBeNull();
    expect(reject({ emails: emails(MAX_BULK_ROWS + 1), platformRole: "PARTICIPANT" })).toEqual([
      `emails exceeds maximum of ${MAX_BULK_ROWS}`,
    ]);
  });

  /**
   * ⚠ THE SECONDARY DEFECT THE REPORT FOUND AT THE SAME LINES. `recipients` was built as
   * `emails || (email ? [email] : [])` and only `length === 0` was rejected, so `{"emails":{}}`
   * has `length === undefined`, passes that test, and reaches `recipients.filter(...)` as a
   * TypeError, i.e. a 500 on an authenticated route. A type check is what closes it.
   */
  it("refuses a NON-ARRAY `emails`, which used to be a 500", () => {
    for (const bad of [{}, "a@example.com", 7, true]) {
      expect(reject({ emails: bad, platformRole: "PARTICIPANT" }), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it("refuses malformed addresses without scanning quadratically", () => {
    // Linear checks only, no nested quantifiers, so a hostile 254-character address cannot be a
    // CPU attack in its own right.
    const bad = ["", "no-at-sign", "two@@ats.com", "a@b", "a@.com", "a@b.", "sp ace@example.com"];
    for (const email of bad) {
      expect(reject({ emails: [email], platformRole: "PARTICIPANT" }), email).not.toBeNull();
    }
  });

  it(`bounds each address at MAX_EMAIL_CHARS (${MAX_EMAIL_CHARS})`, () => {
    const long = `${"a".repeat(MAX_EMAIL_CHARS)}@example.com`;
    expect(reject({ emails: [long], platformRole: "PARTICIPANT" })).not.toBeNull();
  });

  it("refuses unknown keys, so a field nobody validates cannot ride along", () => {
    expect(reject({ emails: ["a@example.com"], somethingElse: "x" })).not.toBeNull();
  });
});

describe("inviteBodySchema, ⚠ LOG-RECORD FORGERY via teamName", () => {
  /**
   * The second, lower-severity finding at the same lines. `teamName` reaches `console.warn`, and
   * `console.*` writes ONE CLOUDWATCH RECORD PER LINE, so a name carrying CRLF plus a fabricated
   * `[INVITE] …` prefix injects extra attacker-authored records into the very stream an
   * investigator would use to reconstruct who invited whom. It cannot alter existing records; it
   * can manufacture new ones, which is enough to mislead.
   *
   * Fixed twice over, independently: refused here, and the two message-text uses in the route were
   * changed to structured fields. Either alone would do; neither relies on the other.
   */
  it("refuses CR, LF and TAB in teamName", () => {
    const forged = "Phoenix\r\n[INVITE] 0/1 invitations issued for team Legitimate";
    expect(reject({ emails: ["a@example.com"], teamName: forged })).toEqual([
      "teamName must not contain line breaks or tabs",
    ]);
    for (const ch of ["\r", "\n", "\t"]) {
      expect(reject({ emails: ["a@example.com"], teamName: `A${ch}B` }), JSON.stringify(ch)).not.toBeNull();
    }
  });

  it("still accepts the punctuation a real team name has", () => {
    // A guard that refused "Team Phoenix (EMEA), 2026" would be reverted, and the defect with it.
    for (const name of ["Team Phoenix", "Phoenix (EMEA), 2026", "O'Brien & Co.", "チーム鳳凰"]) {
      expect(reject({ emails: ["a@example.com"], teamName: name }), name).toBeNull();
    }
  });

  it(`bounds teamName at MAX_CELL_CHARS (${MAX_CELL_CHARS}), reusing the bulk path's ceiling`, () => {
    expect(reject({ emails: ["a@example.com"], teamName: "x".repeat(MAX_CELL_CHARS) })).toBeNull();
    expect(reject({ emails: ["a@example.com"], teamName: "x".repeat(MAX_CELL_CHARS + 1) })).not.toBeNull();
  });

  it("bounds and line-checks the identifiers too", () => {
    expect(reject({ emails: ["a@example.com"], teamId: "t".repeat(201) })).not.toBeNull();
    expect(reject({ emails: ["a@example.com"], inviteCode: "C\nODE" })).not.toBeNull();
    expect(reject({ emails: ["a@example.com"], platformRole: "JUDGE\r\nX" })).not.toBeNull();
  });
});

// ── ⚠ BOUNDED IS NOT THE SAME AS UNIQUE, AND THE GAP BETWEEN THEM WAS A SECOND FINDING ────────
//
// `.max(MAX_BULK_ROWS)` bounds how many addresses arrive and says nothing about how many are the
// SAME address. The handler's lookup Maps are keyed lower-case so they LOOK deduplicated, but
// every list that drives a side effect is derived from the original array and filtered with
// `.has()`, true for every copy. So `{ emails: Array(80).fill("victim@example.com") }` passed
// every filter 80 times and produced 80 Cognito AdminCreateUser attempts against the pool-wide
// quota plus 80 invitation emails, each with a live join link, to that one address.
//
// Note what makes this the interesting shape: the request is WITHIN every documented bound. The
// count is legal, each address is legal, the actor is legitimately entitled to invite. Only the
// multiplicity is the attack, which is why nothing else caught it.
describe("inviteBodySchema, one entry per address", () => {
  const dup = "victim@example.com";

  it("refuses the 80-copies-of-one-address body that mailed 80 live join links", () => {
    expect(reject({ emails: Array.from({ length: MAX_BULK_ROWS }, () => dup) })).toEqual([
      "emails contains duplicate addresses",
    ]);
  });

  it("refuses a single repeat, not just a large one", () => {
    // Two sends and two provisioning attempts is already the defect; the count is not the point.
    expect(reject({ emails: [dup, dup] })).not.toBeNull();
  });

  it("compares case-insensitively, because every downstream lookup does", () => {
    // `tokenByEmail` and `provisionByEmail` are keyed `.toLowerCase()`, so these are ONE recipient
    // to the rest of the flow. A case-sensitive check here would let the duplicate through to the
    // exact code paths that treat them as the same person.
    expect(reject({ emails: ["Victim@Example.com", "victim@example.com"] })).not.toBeNull();
    expect(reject({ emails: [dup, dup.toUpperCase()] })).not.toBeNull();
  });

  it("still accepts a full-size batch of genuinely distinct addresses", () => {
    // The guard must not become a reason to lower the batch ceiling: a real cohort import is
    // MAX_BULK_ROWS distinct people, and refusing it would get this reverted.
    expect(reject({ emails: emails(MAX_BULK_ROWS) })).toBeNull();
  });

  it("leaves the singular `email` form alone", () => {
    // One address cannot duplicate itself, and the handler collapses this form too.
    expect(reject({ email: dup })).toBeNull();
  });
});
