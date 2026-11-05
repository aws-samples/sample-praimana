/**
 * IS THIS "ASSISTANT REPLY" ACTUALLY A TOOL FAILURE?
 *
 * ── THE REPORTED BUG ──
 *
 * A participant's local CLI failed to reach Bedrock and printed its error as the turn's output:
 *
 *     Failed to authenticate. API Error: 403 {"Message":"User: arn:aws:sts::<acct>:assumed-role/
 *     <Role>/<alias> is not authorized to perform: bedrock:InvokeModelWithResponseStream on
 *     resource: arn:aws:bedrock:...:inference-profile/... because no identity-based policy allows..."}
 *
 * The desktop app synced that text as an ASSISTANT MESSAGE, so it landed in the transcript and the
 * portal rendered it to an executive — a raw IAM message naming an account id, a role ARN and a
 * resource ARN, shown to someone who can do nothing about it and should not be reading it.
 *
 * ── WHY THIS IS FILTERED SERVER-SIDE, NOT IN THE PORTAL ──
 *
 * Three reasons, and the third is the one that decides it:
 *
 *   1. The desktop app is not the only client, and a portal-side filter protects only the portal.
 *      The rule belongs where the data enters the platform.
 *   2. Hiding it in the UI leaves the disclosure in the DATABASE, where the next reader — a
 *      support script, an export, a future page — finds it again.
 *   3. ⚠ A FAILURE IS NOT AI USAGE. A stored failure counts as an assistant turn, so it increments
 *      `aiTurns` and inflates the activity counters that RANK PEOPLE. Filtering at the boundary is
 *      the only place that fixes the numbers as well as the display; a presentation-only fix would
 *      leave a member credited for turns that never produced anything.
 *
 * ── WHAT IS REPLACED, AND WHY NOT REFUSED ──
 *
 * The message is stored with its content replaced by `CLIENT_ERROR_PLACEHOLDER`, NOT rejected with a
 * 400 and NOT dropped. The turn genuinely happened — the participant asked something and their tool
 * failed — so erasing it would leave a user message with no reply, which reads as an unanswered
 * question rather than a broken tool. Refusing the whole batch would be worse: it would also discard
 * the user's own message, which is legitimate content.
 *
 * The replacement is deliberately terse. It says a client-side error occurred and nothing else: no
 * account, no ARN, no action name. An operator who needs the detail has the participant's own
 * terminal and CloudWatch; nobody reading a transcript in the portal needs an IAM policy name.
 */

/** What a filtered assistant turn says instead. Terse on purpose — see the note above. */
export const CLIENT_ERROR_PLACEHOLDER = "_[Client error — the assistant did not return a reply.]_";

/**
 * Failure shapes, matched case-insensitively against the WHOLE message.
 *
 * ⚠ EVERY PATTERN HERE IS A TRADE-OFF AGAINST FALSE POSITIVES, because a false positive silently
 * destroys legitimate content. An assistant discussing IAM, or pasting an error it is helping to
 * debug, must NOT be filtered — that is a real and common use of a coding assistant on this
 * platform, and it would be the worst possible outcome of this fix.
 *
 * So the patterns are anchored on things a TOOL says about ITSELF failing, not on error vocabulary:
 *
 *   · a leaked AWS caller identity (`arn:aws:sts::...:assumed-role/...`) alongside an authorization
 *     verb — the exact reported shape, and the one that discloses an account id
 *   · a CLI's own top-line failure banners ("Failed to authenticate", "API Error: <3-digit>")
 *   · AWS SDK exception names that only appear when the SDK itself refused the caller
 *   · credential-expiry and quota messages, which are the other two ways a local CLI dies
 *
 * A message that merely CONTAINS the word "error", or a stack trace, or a 403 in prose, is left
 * alone. The bar is "this text is a tool reporting its own inability to run", not "this text is
 * about a failure".
 */
const FAILURE_PATTERNS: readonly RegExp[] = [
  // The reported shape: an STS caller identity plus an authorization refusal. Both halves are
  // required, so an assistant EXPLAINING an ARN is not caught.
  /arn:aws:sts::\d+:assumed-role\/[^\s"]+[\s\S]*?(?:is not authorized to perform|no identity-based policy)/i,
  // A CLI's own authentication banner. Anchored at the start of a line so "the error 'Failed to
  // authenticate' means…" inside a longer explanation is not caught.
  /^\s*failed to authenticate\b/im,
  // "API Error: 403" / "API Error: 429" — a status-code banner, not prose.
  /^\s*api error:\s*\d{3}\b/im,
  // SDK exception names. These appear verbatim only when the SDK refused the caller; an assistant
  // discussing them would normally quote them inside a sentence, so a line start is required.
  /^\s*(?:AccessDenied(?:Exception)?|UnrecognizedClientException|ExpiredTokenException|InvalidClientTokenId|CredentialsError|UnauthorizedException)\b/im,
  // Credentials missing or stale — the second most common way a local CLI dies mid-workshop.
  /^\s*(?:the security token included in the request is (?:expired|invalid)|unable to locate credentials|could not load credentials)/im,
  // Throttling / quota refusals from the provider.
  /^\s*(?:ThrottlingException|TooManyRequestsException|ServiceQuotaExceededException|ModelNotReadyException)\b/im,
];

/**
 * True when an assistant message is the client's own failure output rather than a model reply.
 *
 * ONLY EVER APPLIED TO `role: "assistant"` by the caller. A USER message is the participant's own
 * words, and if they paste an IAM error to ask about it that is exactly the conversation this
 * platform exists to host — rewriting it would be both a data loss and an insult.
 */
export function isClientErrorContent(content: string): boolean {
  if (!content) return false;
  /**
   * A LENGTH CEILING, because it is the cheapest false-positive guard available.
   *
   * A tool's failure output is short — a banner and a JSON blob. A long message containing one of
   * these patterns is far more likely to be an assistant WORKING ON the error: quoting it, then
   * explaining the fix. 4000 characters is generous for a failure and modest for an explanation.
   *
   * The consequence is stated plainly: a pathologically long failure dump would get through. That is
   * the safe direction — showing one ugly message beats deleting a real answer.
   */
  if (content.length > 4_000) return false;
  return FAILURE_PATTERNS.some((re) => re.test(content));
}
