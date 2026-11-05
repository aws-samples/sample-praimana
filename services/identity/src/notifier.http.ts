import { callService, canSeeUser } from "@praimana/service-shared";
import type { FeedbackNotifier, FeedbackReport } from "./domain.js";

/**
 * Tells staff a report arrived, by asking the NOTIFY service to send one email.
 *
 * ── ⚠ WHY DIRECT LAMBDA INVOCATION AND NOT AN HTTP CALL ──
 *
 * Every API Gateway route inherits `DefaultAuthorizer: CognitoJwt`, so a tokenless HTTP request to
 * notify's public URL is 401'd by the gateway before its Lambda runs. This call has no caller bearer to
 * re-present — the reporter's token authenticates THEM, and a notification is the platform acting on its
 * own behalf. `callService` is the transport built for exactly that, and `lambda:InvokeFunction` scoped to
 * the named function IS the credential.
 *
 * ── ⚠ IT REUSES `workshop-update` RATHER THAN ADDING A TEMPLATE ──
 *
 * That route is already a generic headline/body/details/action email. A sixth template would be a copy of
 * it with different prose, and templates are the part of notify most likely to drift out of visual step
 * with each other. The `headline` carries the report kind, so the subject line is still specific.
 *
 * ── ⚠ AND IT NEVER THROWS ──
 *
 * The report is ALREADY STORED by the time this runs. A notification failure must not turn a successful
 * report into an error for the person who filed it — they would try again, and the inbox would fill with
 * duplicates of a report that landed the first time. Every failure is swallowed and logged; the return
 * value is for the log line, not for a branch.
 */
export class HttpFeedbackNotifier implements FeedbackNotifier {
  constructor(
    private readonly notifyFunction = process.env.NOTIFY_FUNCTION_NAME ||
      "praimana-notify"
  ) {}

  async notifyNewReport(report: FeedbackReport, recipients: string[]): Promise<number> {
    // No staff addresses ⇒ nothing to do, and NOT an error. A platform with no admin accounts is a
    // configuration state, not a failed notification.
    if (recipients.length === 0) return 0;

    try {
      await callService(
        this.notifyFunction,
        "POST",
        "/v1/notify/workshop-update",
        // The platform acting on its own behalf. ADMIN because notify's routes are staff-gated and this
        // is not a user request — the reporter's own role is in the BODY, where it belongs as data.
        { id: "system", email: "", role: "ADMIN" },
        {
          to: recipients,
          /**
           * ⚠ THE REPORTER'S SUBJECT, PREFIXED WITH THE KIND — and this is what the subject field is FOR.
           *
           * Every report used to arrive headlined "A bug has been reported", which is indistinguishable
           * noise in a mail client: staff could not tell two reports apart, or judge which to open first,
           * without opening both. The kind stays as a prefix so the channel is still obvious at a glance.
           *
           * The fallback covers a row written before the field existed (see the repository's normalisation)
           * — a bare prefix, never the word "undefined" in somebody's inbox.
           */
          headline: `${report.kind === "BUG" ? "Bug" : "Feedback"}: ${
            report.subject || (report.kind === "BUG" ? "a bug has been reported" : "new feedback")
          }`,
          /**
           * ⚠ THE REPORTER'S TEXT IS THE BODY, AND IT IS NOT SUMMARISED OR TRUNCATED HERE. It is already
           * bounded at the route (MAX_FEEDBACK_MESSAGE), and a clipped bug report is one somebody has to
           * open the inbox to finish reading — which defeats the point of sending it.
           */
          body: report.message,
          details: [
            /**
             * ── ⚠ THE ADDRESS IS WITHHELD WHEN THE LEAST-PRIVILEGED RECIPIENT MAY NOT SEE IT ──────
             *
             * This was the SECOND CHANNEL of the inbox disclosure. Fixing
             * `GET /admin/feedback` alone would have achieved nothing: this line put the reporter's
             * address into the body of a mail sent to every ADMIN *and* FACILITATOR, so a
             * facilitator still learned the address of any ADMIN who filed a report — the exact
             * fact `USER_VISIBILITY_GRANTS` withholds.
             *
             * ⚠ DECIDED AGAINST THE LOWEST-PRIVILEGED RECIPIENT, NOT PER RECIPIENT. This is ONE
             * send to a mixed audience (`staffEmails` returns ADMIN and FACILITATOR together), so
             * there is no per-reader tailoring available without splitting it into two sends — and
             * two sends means two failure modes, two retries and two ways for staff to receive
             * different accounts of the same report. FACILITATOR is therefore the audience this
             * body is built for.
             *
             * WHAT THAT COSTS, stated plainly: for a report filed BY AN ADMIN, no recipient gets
             * the address by mail even though an ADMIN recipient would have been entitled to it.
             * They get it from the inbox, which applies the matrix per reader properly. The
             * common case — a participant, judge, executive or facilitator filing a report — is
             * unaffected, and that is the case where replying by mail is actually useful.
             *
             * ⚠ THE ROLE IS STILL SHOWN. A triager needs to know whether a report came from staff
             * or a participant, and a role on its own identifies nobody.
             */
            canSeeUser("FACILITATOR", report.reportedByRole)
              ? {
                  label: "Reported by",
                  value: `${report.reportedByEmail} (${report.reportedByRole})`,
                }
              : { label: "Reported by", value: `${report.reportedByRole} (see the inbox)` },
            { label: "App", value: report.surface },
            ...(report.version ? [{ label: "Version", value: report.version }] : []),
            ...(report.location ? [{ label: "Screen", value: report.location }] : []),
            /**
             * ⚠ THE EXPERIENCE ID IS HERE BECAUSE THE EMAIL GOES TO *ALL* STAFF. The ask was to notify the
             * current experience's facilitators; this service cannot resolve an experience's owner (see
             * the port's note), so every recipient gets it and this line is how they tell at a glance
             * whether it concerns them.
             */
            ...(report.workshopId ? [{ label: "Experience", value: report.workshopId }] : []),
            ...(report.teamId ? [{ label: "Team", value: report.teamId }] : []),
          ],
          actionLabel: "Open the inbox",
          // Deep link straight to the tab, so nobody has to hunt for it.
          ...(process.env.PORTAL_URL
            ? { actionUrl: `${process.env.PORTAL_URL}/admin?tab=feedback` }
            : {}),
        },
        { source: "identity-feedback", timeoutMs: 4_000 }
      );

      return recipients.length;
    } catch (err) {
      /**
       * ⚠ ONE CATCH IS ENOUGH, AND CHECKING A RETURN VALUE WOULD HAVE BEEN WRONG. `callService` THROWS on
       * every failure — a thrown callee, an HTTP error status, or an unreadable payload — and returns
       * `{status, body}` only on success. The first draft of this file branched on a non-existent `res.ok`,
       * which type-checking caught; had the shape been looser it would have silently treated every failure
       * as a success.
       *
       * `ServiceInvokeError` carries the callee's status, which is the one detail worth logging: a 400 from
       * notify means this payload is wrong and will keep failing, while a 5xx is transient.
       */
      const status = (err as { status?: number })?.status;
      console.warn("[identity] feedback notification could not be sent", {
        reportId: report.id,
        ...(typeof status === "number" ? { status } : {}),
        // The NAME only. A full AWS error message carries an account id and a function ARN.
        error: err instanceof Error ? err.name : "unknown",
      });
      return 0;
    }
  }
}
