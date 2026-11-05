// ── THE REPORT EMAIL ─────────────────────────────────────────────────────────────────────
//
// One email to the facilitator who uploaded, naming the failed teams and addresses.
//
// ⚠ NO NEW NOTIFY TEMPLATE. `workshop-update` already renders a headline, a body and a label/value
// details table through the branded layout — which is exactly this report's shape. A sixth template
// would mean a new HTML file, a new render function, a new route and their tests, to say the same
// thing in a slightly different font.
//
// ⚠ AND IT IS SENT ON SUCCESS TOO. Silence is indistinguishable from a job that never ran, which is
// precisely the ambiguity a fire-and-forget upload creates: the facilitator was told "we'll email
// you", so not emailing is a broken promise rather than a quiet success.

import type { ApplyReport } from "./apply";

export interface ReportEmail {
  headline: string;
  body: string;
  details: Array<{ label: string; value: string }>;
}

/** How many addresses to name per team before summarising. Keeps one email readable and bounded. */
const MAX_NAMED_PER_TEAM = 10;

/**
 * Turn a report into the email's semantic fields.
 *
 * ⚠ THE FAILURE COUNT LEADS THE HEADLINE WHEN THERE IS ONE. A subject that says "18 invited" with the
 * two failures buried in a table is how somebody gets silently left out of a workshop — the whole
 * point of this email is that the gap is the first thing read.
 */
export function buildReportEmail(report: ApplyReport, experienceName?: string): ReportEmail {
  const bad = report.failed > 0;
  const teamWord = report.teamsCreated === 1 ? "team" : "teams";

  const headline = bad
    ? `Bulk upload finished with ${report.failed} problem${report.failed === 1 ? "" : "s"}`
    : `Bulk upload complete — ${report.invited} invited`;

  const parts = [
    `${report.teamsCreated} ${teamWord} created`,
    report.teamsMatched > 0 ? `${report.teamsMatched} matched an existing team` : "",
    `${report.invited} invited`,
    /**
     * ⚠ `skipped` IS WORDED SO IT CANNOT READ AS A FAILURE. Those people already held a live
     * invitation and were deliberately left alone — re-inviting them would have re-minted their token
     * and invalidated the link already in their inbox.
     */
    report.skipped > 0
      ? `${report.skipped} already invited and left alone, so their existing link still works`
      : "",
    report.failed > 0 ? `${report.failed} failed` : "",
  ].filter(Boolean);

  /**
   * ⚠ THIS SENTENCE USED TO BE UNCONDITIONALLY WRONG FOR ONE WHOLE CLASS OF FAILURE, and being wrong
   * here is worse than being silent: it tells the operator the remedy is a re-upload when for those
   * addresses a re-upload does NOTHING.
   *
   * A re-upload retries an address only if it no longer looks invited. That is now true when
   * provisioning failed (the row is withdrawn — see `withdrawInvitation`), and it is NOT true when the
   * account was created and only the EMAIL failed: that address keeps a live invitation and a real
   * account, so the skip rule passes over it for ever. It needs an explicit re-invitation, which is
   * why those reasons say "re-invite".
   *
   * So the promise is now made only about the addresses it holds for, and the exception is named.
   */
  const needsManualReinvite = report.teams.some((t) =>
    t.members.some((m) => m.status === "failed" && "reason" in m && /re-invite/i.test(m.reason))
  );

  const body = bad
    ? `${parts.join(", ")}. The failures are listed below. ` +
      // The one instruction that stops the natural reaction being "re-upload and hope".
      `Uploading the same file again retries the failures — anyone already invited and set up is ` +
      `skipped, so nothing is duplicated.` +
      (needsManualReinvite
        ? ` The exceptions are the addresses marked "re-invite" below: those already have an account, ` +
          `so a re-upload will skip them and they must be re-invited individually.`
        : "")
    : `${parts.join(", ")}. Everyone listed in the file has been emailed their invitation.`;

  const details: Array<{ label: string; value: string }> = [];

  for (const team of report.teams) {
    if (team.disposition === "failed") {
      // A whole team that never existed — the most important line in the email.
      details.push({ label: `${team.teamName} — NOT created`, value: team.error ?? "unknown reason" });
      continue;
    }

    const failures = team.members.filter((m) => m.status === "failed");
    if (failures.length === 0) continue;

    const named = failures.slice(0, MAX_NAMED_PER_TEAM);
    const rest = failures.length - named.length;

    /**
     * ⚠ THE ADDRESS AND THE REASON TOGETHER. "3 failed" is not actionable — the facilitator has to
     * know WHICH addresses and WHY, because the remedy differs: a rejected address needs correcting,
     * an unsent email needs re-inviting.
     */
    const value =
      named.map((m) => `${m.email} (${"reason" in m ? m.reason : "failed"})`).join("; ") +
      (rest > 0 ? `; and ${rest} more` : "");

    details.push({ label: `${team.teamName} — ${failures.length} failed`, value });
  }

  if (details.length === 0) {
    details.push({ label: "Result", value: "No failures." });
  }

  return {
    headline: experienceName ? `${experienceName}: ${headline}` : headline,
    body,
    details,
  };
}

/**
 * ⚠ NOTHING HERE CARRIES A CREDENTIAL, and it must stay that way. The report is built from an
 * `ApplyReport`, which holds addresses and reasons only — no temporary password ever reaches it,
 * because `applyPlan` never puts one there. This function exists partly so that boundary has a name:
 * if a future change adds a password to the report type, this is where it would leak into an email
 * that goes to someone OTHER than its owner.
 */
export function assertNoCredential(email: ReportEmail): void {
  const blob = JSON.stringify(email).toLowerCase();
  if (blob.includes("password") || blob.includes("temporarypassword")) {
    throw new Error("the bulk report must never contain a credential");
  }
}
