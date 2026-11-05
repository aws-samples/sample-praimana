import { describe, it, expect } from "vitest";

/**
 * The workshop start/end date rules, required, ordered, and timezone-lossless.
 *
 * Owner: "can we have the options for the facilitator to enter start date and end date
 * while creating the workshop and able to edit it as well later make it both required".
 *
 * The workshop SERVICE already accepted and stored `startsAt`/`endsAt` (create takes them,
 * the update allowlist includes them), the gap was the tRPC schema and the two forms. So
 * what is worth testing is not persistence but the two things a form gets wrong:
 *
 *   1. THE TIMEZONE ROUND TRIP. `<input type="datetime-local">` speaks LOCAL wall-clock
 *      time with no offset; the store holds a UTC instant. Converting with a bare
 *      `toISOString().slice(0,16)` renders in UTC, so a facilitator in London who set
 *      09:00 BST reopens the form, sees 08:00, and saving MOVES their workshop by an hour.
 *      Silent, and it compounds every time the form is opened.
 *   2. THE ORDERING RULE, including which boundary is allowed.
 */

/** Mirrors `toLocalInput` in app/experiences/[id]/settings/page.tsx. */
function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

/** Mirrors the forms' local → ISO conversion on submit. */
function toIso(local: string): string {
  return local ? new Date(local).toISOString() : "";
}

/** Mirrors `datesInverted` in both forms. */
function datesInverted(startIso: string, endIso: string): boolean {
  return !!startIso && !!endIso && new Date(endIso) < new Date(startIso);
}

describe("the datetime-local round trip", () => {
  it("returns the SAME wall-clock time it was given", () => {
    // THE REGRESSION GUARD. Whatever the test machine's timezone, a value entered in the
    // form and read back must be identical, that is the property a naive
    // toISOString().slice() breaks, and it breaks it silently by an offset-sized amount.
    for (const local of [
      "2026-08-04T09:00",
      "2026-12-31T23:59",
      "2026-01-01T00:00",
      "2026-06-15T14:30",
    ]) {
      expect(toLocalInput(toIso(local))).toBe(local);
    }
  });

  it("survives repeated open-and-save cycles without drifting", () => {
    // The compounding case: a form opened, saved, reopened. Any per-trip offset error
    // would accumulate here, which is how "my workshop moved" becomes "my workshop moved
    // several hours".
    let local = "2026-08-04T09:00";
    for (let i = 0; i < 5; i++) local = toLocalInput(toIso(local));
    expect(local).toBe("2026-08-04T09:00");
  });

  it("produces a real UTC instant with an offset, as the schema requires", () => {
    // The tRPC schema is `z.string().datetime({ offset: true })`, so a bare local string
    // must not reach it.
    const iso = toIso("2026-08-04T09:00");
    expect(iso).toMatch(/Z$/);
    expect(() => new Date(iso).toISOString()).not.toThrow();
  });

  it("treats absent, null and unparseable values as 'not set'", () => {
    // Every workshop created before dates existed is in exactly this state, and the form
    // must render an empty field rather than "Invalid Date".
    expect(toLocalInput(null)).toBe("");
    expect(toLocalInput(undefined)).toBe("");
    expect(toLocalInput("")).toBe("");
    expect(toLocalInput("not a date")).toBe("");
  });
});

describe("the ordering rule", () => {
  it("refuses an end BEFORE the start", () => {
    expect(datesInverted(toIso("2026-08-04T09:00"), toIso("2026-08-03T09:00"))).toBe(true);
    // One minute earlier still counts, the rule is not "roughly the same day".
    expect(datesInverted(toIso("2026-08-04T09:00"), toIso("2026-08-04T08:59"))).toBe(true);
  });

  it("ALLOWS an end EQUAL to the start", () => {
    // Deliberate: a zero-length experience is odd but not incoherent, and refusing it
    // would be the form inventing a policy nobody stated.
    expect(datesInverted(toIso("2026-08-04T09:00"), toIso("2026-08-04T09:00"))).toBe(false);
  });

  it("allows a normal range", () => {
    expect(datesInverted(toIso("2026-08-04T09:00"), toIso("2026-08-06T17:00"))).toBe(false);
  });

  it("does not fire while either date is still empty", () => {
    // Half-filled is INCOMPLETE, not invalid. Showing "the end must be after the start"
    // to someone who has typed only a start is a false accusation; the missing-date
    // blocker is what speaks then.
    expect(datesInverted("", toIso("2026-08-04T09:00"))).toBe(false);
    expect(datesInverted(toIso("2026-08-04T09:00"), "")).toBe(false);
    expect(datesInverted("", "")).toBe(false);
  });
});
