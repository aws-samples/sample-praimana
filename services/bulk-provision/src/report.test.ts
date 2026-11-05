// ── THE REPORT EMAIL ─────────────────────────────────────────────────────────────────────
//
// The report email lists the failed team names and email addresses. So the assertions that matter
// are about whether a failure is FINDABLE and ACTIONABLE — not whether the copy is pleasant.

import { describe, it, expect } from "vitest";
import { buildReportEmail, assertNoCredential } from "./report";
import type { ApplyReport } from "./apply";

const clean: ApplyReport = {
  teamsCreated: 3,
  teamsMatched: 0,
  invited: 18,
  skipped: 0,
  failed: 0,
  teams: [
    { teamName: "Jarvis", disposition: "created", teamId: "t1", members: [] },
    { teamName: "Wakanda", disposition: "created", teamId: "t2", members: [] },
    { teamName: "Stark", disposition: "created", teamId: "t3", members: [] },
  ],
};

const withFailures: ApplyReport = {
  teamsCreated: 2,
  teamsMatched: 0,
  invited: 10,
  skipped: 0,
  failed: 3,
  teams: [
    {
      teamName: "Jarvis",
      disposition: "created",
      teamId: "t1",
      members: [
        { email: "ok@example.com", status: "invited" },
        { email: "bad@example.com", status: "failed", reason: "the account could not be created" },
        {
          email: "unsent@example.com",
          status: "failed",
          reason: "the account was created but the email did not send — re-invite this address",
        },
      ],
    },
    { teamName: "Wakanda", disposition: "failed", members: [], error: 'More than one existing team is called "Wakanda" (t-9, t-10)' },
  ],
};

describe("⚠ a failure leads the headline", () => {
  /**
   * A subject saying "18 invited" with two failures buried in a table is how somebody gets silently
   * left out of a workshop. The count of PROBLEMS is what the facilitator needs to see first.
   */
  it("names the problem count when there is one", () => {
    const e = buildReportEmail(withFailures);
    expect(e.headline).toMatch(/3 problems/);
    expect(e.headline).not.toMatch(/^Bulk upload complete/);
  });

  it("says complete, with the invited count, when nothing failed", () => {
    expect(buildReportEmail(clean).headline).toBe("Bulk upload complete — 18 invited");
  });

  it("prefixes the experience name when one is known", () => {
    expect(buildReportEmail(clean, "AI Accelerator - Retail").headline).toMatch(
      /^AI Accelerator - Retail: /
    );
  });

  it("uses the singular for one problem", () => {
    expect(buildReportEmail({ ...withFailures, failed: 1 }).headline).toMatch(/1 problem\b/);
  });
});

describe("⚠ every failure is named, with its reason", () => {
  /**
   * "3 failed" is not actionable. The remedy DIFFERS by reason — a rejected address needs correcting,
   * an unsent email needs re-inviting — so the address and the reason have to travel together.
   */
  it("lists the failing addresses under their team", () => {
    const e = buildReportEmail(withFailures);
    const jarvis = e.details.find((d) => d.label.startsWith("Jarvis"))!;

    expect(jarvis.label).toMatch(/2 failed/);
    expect(jarvis.value).toContain("bad@example.com");
    expect(jarvis.value).toContain("unsent@example.com");
    expect(jarvis.value).toMatch(/re-invite/);
  });

  it("does NOT list the addresses that succeeded", () => {
    // A report listing everybody makes the failures hard to find, which defeats its purpose.
    const e = buildReportEmail(withFailures);
    expect(JSON.stringify(e.details)).not.toContain("ok@example.com");
  });

  /**
   * ⚠ A TEAM THAT WAS NEVER CREATED IS THE MOST IMPORTANT LINE IN THE EMAIL — nobody on it was
   * invited, and the reason (an ambiguous name) needs a human decision.
   */
  it("reports a team that failed outright, with its reason", () => {
    const e = buildReportEmail(withFailures);
    const wakanda = e.details.find((d) => d.label.startsWith("Wakanda"))!;

    expect(wakanda.label).toMatch(/NOT created/);
    expect(wakanda.value).toMatch(/More than one existing team/);
    expect(wakanda.value).toContain("t-9");
  });

  it("says so explicitly when there is nothing to report", () => {
    // An empty details table would read as "the report is broken".
    expect(buildReportEmail(clean).details).toEqual([{ label: "Result", value: "No failures." }]);
  });

  /**
   * ⚠ BOUNDED. A team could in principle have 10 failures; naming 80 addresses in one cell makes an
   * unreadable email. Ten plus a count keeps it useful without truncating silently.
   */
  it("caps the named addresses and says how many more there are", () => {
    const many: ApplyReport = {
      ...clean,
      failed: 12,
      teams: [
        {
          teamName: "Big",
          disposition: "created",
          teamId: "t",
          members: Array.from({ length: 12 }, (_, i) => ({
            email: `p${i}@example.com`,
            status: "failed" as const,
            reason: "nope",
          })),
        },
      ],
    };

    const value = buildReportEmail(many).details[0].value;
    expect(value).toMatch(/and 2 more/);
    expect(value).toContain("p0@example.com");
    expect(value).not.toContain("p11@example.com");
  });
});

describe("⚠ skipped must not read as failed", () => {
  /**
   * Those people already held a live invitation and were deliberately left alone — re-inviting would
   * have re-minted their token and invalidated the link already in their inbox. A report that made
   * that look like a problem would invite exactly the wrong fix.
   */
  it("explains that a skipped invitation still works", () => {
    const e = buildReportEmail({ ...clean, invited: 15, skipped: 3 });
    expect(e.body).toMatch(/already invited and left alone/);
    expect(e.body).toMatch(/existing link still works/);
    // Still a success headline: skipped is not failed.
    expect(e.headline).toMatch(/^Bulk upload complete/);
  });

  it("mentions matched teams when some already existed", () => {
    expect(buildReportEmail({ ...clean, teamsCreated: 1, teamsMatched: 2 }).body).toMatch(
      /2 matched an existing team/
    );
  });
});

describe("⚠ it tells the operator that re-uploading is safe", () => {
  /**
   * The natural reaction to a partial report is to re-upload and hope. Saying explicitly that a
   * re-upload retries ONLY the failures is what turns that instinct into the correct action instead
   * of a fear of duplicates.
   */
  it("says a re-upload retries the failures", () => {
    const body = buildReportEmail(withFailures).body;
    // ⚠ WORDED "the failures", NOT "ONLY the failures". The old absolute was false for any address
    // whose account was created and whose email failed — see the exception test below.
    expect(body).toMatch(/same file again retries the failures/i);
    expect(body).toMatch(/nothing is duplicated/i);
  });

  it("does not say that when nothing failed", () => {
    // Irrelevant advice on a clean run is noise that makes the useful case less noticeable.
    expect(buildReportEmail(clean).body).not.toMatch(/retries the failures/i);
  });

  /**
   * ── ⚠ THE PROMISE MUST NOT BE MADE ABOUT ADDRESSES IT DOES NOT HOLD FOR ────────────────
   *
   * This sentence used to be unconditional, and for one whole class of failure it was FALSE — which is
   * worse than silence, because it names a remedy that does nothing.
   *
   * A re-upload retries an address only if it no longer looks invited. That is true when PROVISIONING
   * failed (the row is withdrawn). It is NOT true when the account was created and only the EMAIL
   * failed: that address keeps a live invitation AND a real account, so the skip rule passes over it
   * for ever. Those reasons say "re-invite", and the body now names them as the exception.
   */
  it("names the re-invite addresses as the exception to the re-upload advice", () => {
    const body = buildReportEmail(withFailures).body;

    // `withFailures` contains an "email did not send — re-invite this address" member.
    expect(body).toMatch(/exceptions are the addresses marked/i);
    expect(body).toMatch(/re-invited individually/i);
  });

  it("does NOT add the exception when every failure was rolled back", () => {
    // A withdrawn invitation IS retried by a re-upload, so the caveat would be noise that dilutes the
    // one instruction that matters.
    const rolledBack: ApplyReport = {
      ...clean,
      invited: 17,
      failed: 1,
      teams: [
        {
          teamName: "Stark Stack",
          disposition: "created",
          teamId: "t1",
          members: [
            {
              email: "happy@example.com",
              status: "failed",
              reason:
                "the account could not be created (No live invitation for that address) — the invitation was withdrawn, so uploading the same file again will retry this address",
            },
          ],
        },
      ],
    };

    const body = buildReportEmail(rolledBack).body;
    expect(body).toMatch(/retries the failures/i);
    expect(body).not.toMatch(/exceptions are the addresses marked/i);
  });
});

describe("⚠ the report can never carry a credential", () => {
  /**
   * This report goes to the FACILITATOR — someone other than the account owner. A temporary password
   * reaching it would disclose one person's credential to another, which is worse than the original
   * "password in an email" problem rather than the same size.
   *
   * `applyPlan` never puts one in the report, so this is belt-and-braces — but it is the named place
   * where such a leak would happen, and it fails loudly rather than sending.
   */
  it("passes for a normal report", () => {
    expect(() => assertNoCredential(buildReportEmail(withFailures))).not.toThrow();
  });

  it("throws if a credential ever appears in it", () => {
    expect(() =>
      assertNoCredential({ headline: "x", body: "temporaryPassword: Hunter2", details: [] })
    ).toThrow(/never contain a credential/);
  });

  it("catches it in the details too, not just the body", () => {
    expect(() =>
      assertNoCredential({ headline: "x", body: "y", details: [{ label: "Password", value: "z" }] })
    ).toThrow();
  });
});
