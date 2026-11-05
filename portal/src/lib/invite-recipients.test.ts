// ── ⚠ THE HANDLER'S OWN COLLAPSE, WHICH IS THE SECOND LAYER OF THE DE-DUPLICATION FIX ────────
//
// `inviteBodySchema` now REFUSES a body carrying the same address twice (see invite-body.test.ts).
// This file pins the other half: `POST /api/invite` also builds its work list from a unique set,
// so the fan-out is safe even for a caller that does not go through the schema, the singular
// `email` form, or any future in-process caller of this handler.
//
// The derivation under test is reproduced here rather than imported, because it is a handful of
// lines inside a Next route module that cannot be loaded without a session, a backend and SES. What
// is being asserted is therefore the RULE, and `invite-body.test.ts` is what guarantees the schema
// refuses the same input, two independent statements of one requirement, which is the shape the
// original defect argues for: the Maps downstream already looked deduplicated and were not.

import { describe, it, expect } from "vitest";

/** The handler's recipient derivation, verbatim. */
function recipientsOf(body: { emails?: string[]; email?: string }): string[] {
  const { emails, email } = body;
  const bySpelling = new Map<string, string>();
  for (const candidate of emails || (email ? [email] : [])) {
    const key = candidate.toLowerCase();
    if (!bySpelling.has(key)) bySpelling.set(key, candidate);
  }
  return [...bySpelling.values()];
}

describe("POST /api/invite, the recipient work list", () => {
  it("collapses 80 copies of one address to a single recipient", () => {
    // Every side effect below this point is one-per-element: an invitation row, a Cognito
    // AdminCreateUser attempt, and an SES send carrying a live join link.
    const body = { emails: Array.from({ length: 80 }, () => "victim@example.com") };
    expect(recipientsOf(body)).toEqual(["victim@example.com"]);
  });

  it("treats differently-cased spellings as one recipient", () => {
    // Matches `tokenByEmail` / `provisionByEmail`, both keyed `.toLowerCase()`.
    expect(recipientsOf({ emails: ["A@example.com", "a@example.com", "a@Example.com"] })).toHaveLength(1);
  });

  it("keeps the address as the caller spelled it", () => {
    // ⚠ NOT LOWER-CASED. The surviving string is what the invitation row carries and what appears
    // in the recipient's "to" line, so normalising it would change what the person sees. The
    // lower-cased form is the KEY only.
    expect(recipientsOf({ emails: ["Ada.Lovelace@Example.com"] })).toEqual([
      "Ada.Lovelace@Example.com",
    ]);
  });

  it("keeps first occurrence when spellings differ", () => {
    expect(recipientsOf({ emails: ["Ada@example.com", "ada@example.com"] })).toEqual(["Ada@example.com"]);
  });

  it("preserves order and every distinct address", () => {
    // A cohort import must arrive intact: de-duplication is not permission to reorder or drop.
    const distinct = ["c@example.com", "a@example.com", "b@example.com"];
    expect(recipientsOf({ emails: distinct })).toEqual(distinct);
  });

  it("handles the singular form and the empty case", () => {
    expect(recipientsOf({ email: "solo@example.com" })).toEqual(["solo@example.com"]);
    expect(recipientsOf({})).toEqual([]);
    // `emails: []` must stay empty rather than falling through to `email`, so the handler's
    // "emails is required" refusal still fires.
    expect(recipientsOf({ emails: [], email: "fallback@example.com" })).toEqual([]);
  });
});
