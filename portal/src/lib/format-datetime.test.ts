import { describe, it, expect } from "vitest";
import { formatInstantUtc, invitationStatusLabel } from "./format-datetime";

/**
 * These functions exist to be SAFE IN A CLIENT COMPONENT, so the tests are about
 * determinism and degradation rather than about pretty output.
 *
 * The reported defect was an admin invitations row rendering the raw
 * `2026-08-01T20:47:31.195Z`. The trap in fixing it is that the obvious fix -
 * `toLocaleString()`, is evaluated twice for a client component (server prerender,
 * then hydration) by two runtimes that disagree about both timezone and the exact
 * glyphs Intl emits, which React reports as a hydration mismatch. Hence a fixed zone
 * and a hand-rolled month table, and hence the first test below: the contract is that
 * output depends on the INPUT and nothing else.
 */
describe("formatInstantUtc", () => {
  it("renders the reported value in a form an operator can read", () => {
    // The exact string from the bug report.
    expect(formatInstantUtc("2026-08-01T20:47:31.195Z")).toBe("01 Aug 2026 20:47 UTC");
  });

  it("PRINTS the zone, because an unlabelled time cannot answer 'has this lapsed?'", () => {
    expect(formatInstantUtc("2026-08-01T20:47:31.195Z")).toContain("UTC");
  });

  it("is a pure function of its input, no ambient clock, no ambient locale", () => {
    // The hydration guarantee, asserted rather than assumed. If someone swaps the
    // implementation for toLocaleString(), the value starts depending on the
    // runtime's timezone and ICU build, and this test is what should catch it.
    const iso = "2026-08-01T20:47:31.195Z";
    const first = formatInstantUtc(iso);
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = "Asia/Tokyo";
      expect(formatInstantUtc(iso)).toBe(first);
      process.env.TZ = "America/Los_Angeles";
      expect(formatInstantUtc(iso)).toBe(first);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it("does not shift the instant into a local day", () => {
    // 00:30Z on the 2nd is the 1st in the Americas. A local-time formatter would
    // render the wrong DATE here, which is the failure a reader cannot detect.
    expect(formatInstantUtc("2026-08-02T00:30:00.000Z")).toBe("02 Aug 2026 00:30 UTC");
  });

  it("zero-pads so a column of rows does not shift horizontally", () => {
    expect(formatInstantUtc("2026-08-09T05:04:00.000Z")).toBe("09 Aug 2026 05:04 UTC");
  });

  it("degrades to an empty string rather than 'Invalid Date'", () => {
    // `sentAt` is "" for rows the tRPC mapper defaulted, and absent entirely on rows
    // written before the field existed. Rendering "Invalid Date" to an operator is
    // worse than rendering nothing: it reads as data corruption.
    expect(formatInstantUtc("")).toBe("");
    expect(formatInstantUtc(null)).toBe("");
    expect(formatInstantUtc(undefined)).toBe("");
    expect(formatInstantUtc("not-a-date")).toBe("");
    expect(formatInstantUtc("2026-13-45T99:99:99Z")).toBe("");
  });
});

/**
 * The clock is a PARAMETER here, not a `Date.now()` call, and that is the whole point:
 * the previous implementation read the clock during the render of a client component,
 * so a row sitting near its 24-hour boundary could prerender "Pending" and hydrate
 * "Expired". Passing `now` in makes both the boundary and the pre-mount case testable.
 */
describe("invitationStatusLabel", () => {
  const T = Date.parse("2026-08-01T20:47:31.195Z");

  it("reports an accepted invitation regardless of expiry", () => {
    // An accepted row is a historical fact; its link expiry is no longer meaningful.
    expect(
      invitationStatusLabel(
        { status: "Accepted", expiresAt: "2026-07-01T00:00:00.000Z" },
        T
      )
    ).toMatch(/accepted/i);
  });

  it("reports Pending before the expiry", () => {
    expect(
      invitationStatusLabel({ status: "Pending", expiresAt: "2026-08-02T20:47:31.195Z" }, T)
    ).toMatch(/pending/i);
  });

  it("reports expiry once the window has passed", () => {
    expect(
      invitationStatusLabel({ status: "Pending", expiresAt: "2026-07-31T20:47:31.195Z" }, T)
    ).toMatch(/expired/i);
  });

  it("treats an UNPARSEABLE expiry as Pending, not Expired", () => {
    // Fails in the direction that does not accuse a working invite of being dead. A
    // false "Expired" makes an operator re-send a link that was fine.
    expect(invitationStatusLabel({ status: "Pending", expiresAt: "garbage" }, T)).toMatch(
      /pending/i
    );
  });

  it("treats a MISSING expiry as Pending (rows predating the field)", () => {
    expect(invitationStatusLabel({ status: "Pending" }, T)).toMatch(/pending/i);
  });

  it("reads Pending when now = 0, the pre-mount sentinel", () => {
    // useClientNow() returns 0 until mounted. That must render "Pending", so the
    // server render and the first client render agree; the only post-mount correction
    // then ADDS an expiry warning rather than withdrawing one.
    expect(
      invitationStatusLabel({ status: "Pending", expiresAt: "2026-07-31T00:00:00.000Z" }, 0)
    ).toMatch(/pending/i);
  });
});
