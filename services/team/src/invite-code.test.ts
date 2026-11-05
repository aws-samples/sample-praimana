import { describe, it, expect } from "vitest";
import type { DocClient } from "@praimana/service-shared";
import {
  AmbiguousInviteCodeError,
  generateInviteCode,
  isWellFormedInviteCode,
  MAX_INVITE_CODE_ATTEMPTS,
} from "./invite-code.js";
import { DynamoTeamRepository } from "./repository.dynamo.js";

/**
 * ── THE JOIN CODE HAD NO ENTROPY ────────────────────────────────────────────────────────────
 *
 * `ulid().slice(0, 8).toUpperCase()` keeps only the high 40 bits of a
 * ULID's 48-bit millisecond timestamp and discards its entire 80-bit random tail, so the code
 * was a pure function of the creation time at ~256 ms granularity.
 *
 * ⚠ THE ASSERTION THAT MATTERS IS THE COLLISION ONE, not the predictability one. Guessing a code
 * grants nothing by itself — POST /teams/join also requires a live, unspent invitation for the
 * caller's own verified email on that team. What the old expression actually broke was
 * CORRECTNESS: bulk provisioning creates up to 20 teams per upload within the same few
 * milliseconds, so those teams got the IDENTICAL code, and `getByInviteCode`'s `Limit: 1` then
 * resolved a joiner to an arbitrary one of them.
 *
 * The `oldStyleCode` helper below reproduces the defect so the tests state what changed rather
 * than merely asserting that today's implementation does what it does.
 */

/** The pre-fix expression, kept here so the regression it caused is demonstrable. */
function oldStyleCode(): string {
  // The real ULID is not needed — only the property that the first 8 characters encode the
  // clock. Two calls in the same 256 ms window produced the same 8 characters.
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let ms = Date.now();
  let out = "";
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out.slice(0, 8).toUpperCase();
}

describe("the join code carries real entropy", () => {
  it("reproduces the reported defect in the OLD expression, so the fix has a baseline", () => {
    // Two codes minted back to back — the bulk-upload case. The old expression gives the same
    // string; if this ever stops being true the premise of this whole file is wrong.
    const a = oldStyleCode();
    const b = oldStyleCode();
    expect(a).toBe(b);
  });

  it("mints a DISTINCT code for every team in a simulated bulk upload", () => {
    // ⚠ THE REGRESSION THAT MATTERED. BULK_MAX_TEAMS is 20, all created inside one Lambda
    // invocation milliseconds apart. Under the old expression every one of these collided.
    const codes = Array.from({ length: 20 }, () => generateInviteCode());
    expect(new Set(codes).size).toBe(20);
  });

  it("is not derived from the clock — 2000 draws are effectively all distinct", () => {
    // At 40 bits the birthday expectation across 2000 draws is ~1e-3, so a duplicate here means
    // the generator lost its entropy rather than that we were unlucky.
    const codes = new Set(Array.from({ length: 2000 }, () => generateInviteCode()));
    expect(codes.size).toBe(2000);
  });

  it("uses every position, so no character is a constant prefix", () => {
    // The old code's leading characters barely moved (they encode the high bits of the clock).
    // A generator that accidentally fixed a position would still pass the distinctness tests
    // above, so each position is checked for variety independently.
    const samples = Array.from({ length: 200 }, () => generateInviteCode());
    for (let position = 0; position < 8; position += 1) {
      const distinct = new Set(samples.map((code) => code[position]));
      expect(distinct.size, `position ${position} must vary`).toBeGreaterThan(4);
    }
  });

  it("emits 8 characters from the ambiguity-free alphabet only", () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateInviteCode();
      expect(code).toHaveLength(8);
      // Crockford without I, L, O, U — the code is read off a screen and dictated aloud, so
      // I/1, L/1 and O/0 are the transcription failures this excludes.
      expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
      expect(code).not.toMatch(/[ILOU]/);
    }
  });

  it("recognises its own output and rejects anything else", () => {
    expect(isWellFormedInviteCode(generateInviteCode())).toBe(true);
    expect(isWellFormedInviteCode("SHORT")).toBe(false);
    expect(isWellFormedInviteCode("TOOLONGCODE")).toBe(false);
    // The excluded letters must not validate, or a hand-typed O would be accepted and then
    // never match a stored code.
    expect(isWellFormedInviteCode("IIIIIIII")).toBe(false);
    expect(isWellFormedInviteCode("OOOOOOOO")).toBe(false);
    expect(isWellFormedInviteCode("abcdefgh")).toBe(false);
  });

  it("allows at least one re-draw on the creation path", () => {
    // The route loops while `attempt < MAX_INVITE_CODE_ATTEMPTS`, so a value of 1 would silently
    // disable the collision retry while leaving the code that reads as though it retried.
    expect(MAX_INVITE_CODE_ATTEMPTS).toBeGreaterThan(1);
  });
});

/**
 * ── AN AMBIGUOUS LOOKUP IS AN ERROR, NOT AN ARBITRARY PICK ──────────────────────────────────
 *
 * A GSI cannot enforce uniqueness, and the index certainly holds duplicates for teams created
 * before the generator was fixed. `Limit: 1` returned whichever one DynamoDB surfaced.
 */
describe("DynamoTeamRepository.getByInviteCode", () => {
  /** A doc client that answers one Query with the supplied items. */
  function fakeDb(items: unknown[]) {
    const sent: Record<string, unknown>[] = [];
    const db = {
      async send(cmd: { input: Record<string, unknown> }) {
        sent.push(cmd.input);
        return { Items: items };
      },
    };
    return { db: db as unknown as DocClient, sent };
  }

  it("asks for TWO items, because one cannot reveal ambiguity", () => {
    const { db, sent } = fakeDb([]);
    return new DynamoTeamRepository(db).getByInviteCode("ABCD2345").then(() => {
      expect(sent[0].Limit).toBe(2);
      expect(sent[0].IndexName).toBe("inviteCode-index");
    });
  });

  it("returns the team when exactly one matches", async () => {
    const team = { id: "t1", inviteCode: "ABCD2345" };
    const { db } = fakeDb([team]);
    await expect(
      new DynamoTeamRepository(db).getByInviteCode("ABCD2345")
    ).resolves.toMatchObject({ id: "t1" });
  });

  it("returns null when nothing matches", async () => {
    const { db } = fakeDb([]);
    await expect(
      new DynamoTeamRepository(db).getByInviteCode("ABCD2345")
    ).resolves.toBeNull();
  });

  it("THROWS rather than guessing when two teams share the code", async () => {
    // The whole point: no arbitrary answer is correct here. Picking one silently joined — or
    // more often wrongly refused — a legitimate joiner against a team they never saw.
    const { db } = fakeDb([
      { id: "t1", inviteCode: "ABCD2345" },
      { id: "t2", inviteCode: "ABCD2345" },
    ]);
    await expect(
      new DynamoTeamRepository(db).getByInviteCode("ABCD2345")
    ).rejects.toThrow(AmbiguousInviteCodeError);
  });

  it("carries the match count on the error, so the operator log can say how bad it is", async () => {
    const { db } = fakeDb([
      { id: "t1", inviteCode: "ABCD2345" },
      { id: "t2", inviteCode: "ABCD2345" },
    ]);
    await new DynamoTeamRepository(db).getByInviteCode("ABCD2345").then(
      () => expect.unreachable("must have thrown"),
      (err) => {
        expect(err).toBeInstanceOf(AmbiguousInviteCodeError);
        expect(err.matches).toBe(2);
        expect(err.inviteCode).toBe("ABCD2345");
      }
    );
  });
});
