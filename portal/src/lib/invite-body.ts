import { z } from "zod";
import { MAX_BULK_ROWS, MAX_CELL_CHARS, MAX_EMAIL_CHARS } from "@/lib/bulk-invite/contract";

/**
 * ── THE REQUEST BODY OF `POST /api/invite` ───────────────────────────────────────────────────
 *
 * ⚠ THIS ROUTE WAS THE ONLY MUTATING SURFACE WITH NO SCHEMA. The sibling bulk-CSV path
 * enforces MAX_BULK_ROWS, MAX_EMAIL_CHARS, format checks, this route must apply the same
 * bounds so a caller cannot bypass them by switching from the CSV path to the JSON one.
 *
 * The cap is the same MAX_BULK_ROWS the bulk path uses: both paths end up in the same
 * downstream sinks (Cognito provisioning, SES sends) with the same per-pool quotas, so
 * the safe batch size is identical.
 *
 * ⚠ IN ITS OWN MODULE SO IT CAN BE TESTED. A Next route file exports HTTP methods; validation
 * that lives inside one can only be checked by driving the whole handler, which needs a session,
 * a backend and SES. `bulk-invite/contract.ts` is the same shape for the same reason, the bounds
 * are the security control, so they get direct tests rather than incidental coverage.
 */

/**
 * Structural email check, linear, no nested quantifiers, no catastrophic backtracking.
 * Mirrors `emailRejectionReason` in bulk-invite/contract.ts: one @, something either side,
 * no whitespace, a dot in the domain, within the RFC 5321 length ceiling.
 */
const emailSchema = z
  .string()
  .min(1, "email is required")
  .max(MAX_EMAIL_CHARS, `email exceeds ${MAX_EMAIL_CHARS} characters`)
  .refine((val) => !(/\s/.test(val)), "email contains whitespace")
  .refine((val) => {
    const at = val.indexOf("@");
    if (at < 1) return false;
    if (at !== val.lastIndexOf("@")) return false;
    const domain = val.slice(at + 1);
    if (!domain.includes(".")) return false;
    if (domain.startsWith(".") || domain.endsWith(".")) return false;
    return true;
  }, "email format is invalid");

/**
 * No CR, LF or TAB. Anything that can start a new line can forge a log record, and nothing
 * legitimate in a team name, a role or an id contains one.
 */
const NO_CONTROL_CHARS = /^[^\r\n\t]*$/;

/** A bounded, single-line free-text field (a team name). */
function boundedText(label: string, max: number) {
  return z
    .string()
    .max(max, `${label} exceeds ${max} characters`)
    .regex(NO_CONTROL_CHARS, `${label} must not contain line breaks or tabs`)
    .optional();
}

/**
 * A bounded identifier or enum-ish value. 200 is generous for a ULID, a role name or an invite
 * code and still refuses a payload that is trying to be a document.
 */
function boundedId(label: string) {
  return z
    .string()
    .max(200, `${label} exceeds 200 characters`)
    .regex(NO_CONTROL_CHARS, `${label} must not contain line breaks or tabs`)
    .optional();
}

export const inviteBodySchema = z
  .object({
    /**
     * ⚠ UNIQUE, NOT JUST BOUNDED, AND THE ABSENCE OF THIS WAS THE FINDING.
     *
     * `.max(MAX_BULK_ROWS)` bounds how many addresses arrive; it says nothing about how many are
     * the SAME address. The handler's lookup Maps are keyed on the lower-cased address so they
     * LOOK deduplicated, but every list that drives a side effect is derived from the original
     * array and filtered with `.has()`, which is true for every copy. So a body carrying one
     * address 80 times survived every filter 80 times and produced, per request: 80 Cognito
     * `AdminCreateUser` attempts against the pool-wide admin quota ("the same throttle that would
     * block a real user's sign-in", `rate-limit.ts`), and 80 separate invitation emails to that
     * one address, each from the platform's verified SES sender and each carrying a LIVE join
     * link.
     *
     * Refused HERE rather than only collapsed in the handler because this is the cheapest point:
     * an oversized-by-repetition request never reaches the invitation write. The handler
     * additionally builds its work list from a unique set, so neither layer relies on the other.
     *
     * ⚠ CASE-INSENSITIVE, because that is the identity the rest of the flow uses. `tokenByEmail`
     * and `provisionByEmail` are both keyed `.toLowerCase()`, so `A@example.com` and `a@example.com` are one
     * recipient everywhere downstream and must be one here too. This is the same rule the sibling
     * CSV path already enforces, `bulk-invite/validate.ts` fails the whole file with a
     * `DUPLICATE` code on a repeated (team, email) pair, so the two doors now agree.
     */
    emails: z
      .array(emailSchema)
      .max(MAX_BULK_ROWS, `emails exceeds maximum of ${MAX_BULK_ROWS}`)
      .superRefine((list, ctx) => {
        const seen = new Set(list.map((e) => e.toLowerCase()));
        if (seen.size !== list.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "emails contains duplicate addresses",
          });
        }
      })
      .optional(),
    email: emailSchema.optional(),
    /**
     * ⚠ BOUNDED AND CONTROL-CHARACTER-FREE, WHICH IS A SECOND FINDING AND NOT TIDINESS.
     *
     * `teamName` is caller-controlled and reaches `console.warn` message text below, and
     * `console.*` writes ONE CLOUDWATCH RECORD PER LINE, so a name containing CRLF plus a
     * fabricated `[INVITE] …` prefix injects extra attacker-authored records into the same
     * stream an investigator would use to reconstruct who invited whom. That is log-record
     * FORGERY: it cannot alter existing records, but it can manufacture new ones.
     *
     * `noControlChars` is the fix at the source; the two message-text uses were additionally
     * changed to structured fields (see `scopeLabel`), so neither layer relies on the other.
     *
     * The identifiers are bounded for the plainer reason that an unbounded string reaching a URL
     * path or a store key has no upper cost. MAX_CELL_CHARS is the bulk path's own ceiling for
     * a free-text cell, reused so the two invite paths cannot disagree.
     */
    teamId: boundedId("teamId"),
    teamName: boundedText("teamName", MAX_CELL_CHARS),
    inviteCode: boundedId("inviteCode"),
    platformRole: boundedId("platformRole"),
    teamRole: boundedId("teamRole"),
    workshopId: z.union([boundedId("workshopId"), z.number()]).optional(),
  })
  .strict();

/** The parsed shape, for the route handler's local. */
export type InviteBody = z.infer<typeof inviteBodySchema>;
