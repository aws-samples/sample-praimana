import { describe, it, expect } from "vitest";
import { isClientErrorContent, CLIENT_ERROR_PLACEHOLDER } from "./cli-error-content.js";

/**
 * FILTERING A CLIENT'S OWN FAILURE OUTPUT OUT OF A TRANSCRIPT.
 *
 * ── THE REPORTED BUG ──
 *
 * A participant's local CLI could not reach Bedrock, printed the raw IAM refusal as its reply, and
 * the desktop app synced that text as an ASSISTANT MESSAGE. The portal then rendered an account id,
 * a role ARN and an action name to an executive who can do nothing about it.
 *
 * ── THE RISK THIS SUITE IS REALLY ABOUT ──
 *
 * ⚠ A FALSE POSITIVE SILENTLY DESTROYS A REAL ANSWER. This platform's whole purpose is participants
 * working with a coding assistant, and "help me fix this IAM error" is an ordinary thing to ask. If
 * the filter eats the assistant's explanation, the transcript loses content nobody can recover, and
 * the loss is invisible — no error, no log, just a placeholder where an answer used to be.
 *
 * So the negative cases below are the important half of this file, not the padding. The bar is "this
 * text is a TOOL reporting its own inability to run", not "this text is about a failure".
 */

/** The exact failure message that reached the portal, abbreviated only in the resource ARN. */
const REPORTED = `Failed to authenticate. API Error: 403 {"Message":"User: arn:aws:sts::111122223333:assumed-role/ExampleFederatedRole/example-user is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: arn:aws:bedrock:us-east-1:111122223333:inference-profile/global.anthropic.claude-opus-5 because no identity-based policy allows the bedrock:InvokeModelWithResponseStream action"}`;  // nosemgrep: missing-template-string-indicator

describe("the reported failure is caught", () => {
  it("catches the exact message that reached the portal", () => {
    expect(isClientErrorContent(REPORTED)).toBe(true);
  });

  it("catches it on EVERY pattern it should match, not just one", () => {
    /**
     * Defence in depth on purpose: the reported text trips the STS-identity pattern, the
     * "Failed to authenticate" banner AND the "API Error: 403" banner. A CLI that reworded one of
     * the three would still be caught by the others.
     */
    expect(isClientErrorContent('Failed to authenticate. API Error: 403 {"x":1}')).toBe(true);
    expect(
      isClientErrorContent(
        'API Error: 429 {"Message":"Too many requests"}'
      )
    ).toBe(true);
    expect(
      isClientErrorContent(
        'User: arn:aws:sts::1234:assumed-role/Some/role is not authorized to perform: bedrock:Converse'
      )
    ).toBe(true);
  });

  for (const [label, text] of [
    ["expired credentials", "ExpiredTokenException: The security token included in the request is expired"],
    ["no credentials", "Unable to locate credentials"],
    ["stale token, prose form", "The security token included in the request is expired"],
    ["access denied", "AccessDeniedException: User is not authorized"],
    ["bad client id", "InvalidClientTokenId: The security token included in the request is invalid"],
    ["throttled", "ThrottlingException: Rate exceeded"],
    ["quota", "ServiceQuotaExceededException: Too many tokens"],
    ["unrecognized client", "UnrecognizedClientException: The security token is invalid"],
  ] as const) {
    it(`catches ${label}`, () => {
      expect(isClientErrorContent(text)).toBe(true);
    });
  }

  it("is case-insensitive and tolerates leading whitespace", () => {
    expect(isClientErrorContent("   failed to authenticate")).toBe(true);
    expect(isClientErrorContent("\n\nAPI ERROR: 500\n")).toBe(true);
  });
});

describe("⚠ REAL ASSISTANT CONTENT IS NEVER FILTERED", () => {
  it("leaves an assistant EXPLAINING an IAM error alone", () => {
    /**
     * THE MOST IMPORTANT TEST HERE. This is a participant getting exactly the help the platform
     * exists to provide, and the reply quotes the very words the filter looks for. Eating it would
     * be worse than the bug being fixed.
     */
    // nosemgrep: missing-template-string-indicator  -- reviewed; the construct is not the vulnerability this rule describes
    const helpful = `That error means your role lacks the Bedrock permission. The message
"is not authorized to perform: bedrock:InvokeModel" tells you the action, and the ARN after
"resource:" tells you what it was denied on. Add an identity-based policy like:

    {
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel"],
      "Resource": "arn:aws:bedrock:us-east-1:123456789012:inference-profile/*"
    }

Then re-run \`aws sts get-caller-identity\` to confirm which role you are actually using.`;

    expect(isClientErrorContent(helpful)).toBe(false);
  });

  it("leaves prose that merely MENTIONS a 403 alone", () => {
    expect(
      isClientErrorContent(
        "The API returned a 403 earlier, which usually means the token expired. Let's check."
      )
    ).toBe(false);
  });

  it("leaves an ARN discussed mid-sentence alone", () => {
    /**
     * The STS pattern requires an authorization verb ALONGSIDE the identity, so an assistant
     * explaining what an assumed-role ARN looks like is not caught.
     */
    expect(
      isClientErrorContent(
        "Your caller identity will look like arn:aws:sts::123456789012:assumed-role/Admin/alice — the last segment is your session name."
      )
    ).toBe(false);
  });

  it("leaves an error name QUOTED inside a sentence alone", () => {
    // The SDK-exception patterns are anchored to a line start, so a mid-sentence mention survives.
    expect(
      isClientErrorContent(
        "If you see AccessDeniedException here, the fix is usually a missing policy rather than a bad token."
      )
    ).toBe(false);
  });

  it("leaves ordinary code and prose alone", () => {
    expect(isClientErrorContent("Here is the function you asked for:\n\nfunction add(a, b) { return a + b; }")).toBe(false);
    expect(isClientErrorContent("Done — I've updated the README.")).toBe(false);
    expect(isClientErrorContent("error handling is now in place")).toBe(false);
  });

  it("does not filter a LONG message that quotes a failure", () => {
    /**
     * The length ceiling as a false-positive guard. A tool's failure output is short; a long message
     * containing the same words is far more likely to be an assistant working ON the error.
     *
     * The trade-off is stated rather than hidden: a pathologically long failure dump gets through.
     * That is the safe direction — one ugly message beats a deleted answer.
     */
    const long = REPORTED + "\n\n" + "Here is how to fix it. ".repeat(300);
    expect(long.length).toBeGreaterThan(4_000);
    expect(isClientErrorContent(long)).toBe(false);
  });

  it("handles empty and whitespace content without matching", () => {
    expect(isClientErrorContent("")).toBe(false);
    expect(isClientErrorContent("   ")).toBe(false);
  });
});

describe("the placeholder discloses nothing", () => {
  it("names no account, ARN, action or role", () => {
    /**
     * The whole point of the replacement. An operator who needs the detail has the participant's own
     * terminal and CloudWatch; nobody reading a transcript in the portal needs an IAM policy name.
     */
    for (const leak of ["arn:", "aws", "111122223333", "bedrock", "assumed-role", "policy", "403"]) {
      expect(
        CLIENT_ERROR_PLACEHOLDER.toLowerCase(),
        `placeholder must not contain ${leak}`
      ).not.toContain(leak);
    }
  });

  it("says a client error occurred, so the gap is legible", () => {
    // A blank or omitted reply would read as an unanswered question rather than a broken tool.
    expect(CLIENT_ERROR_PLACEHOLDER.toLowerCase()).toContain("client error");
    expect(CLIENT_ERROR_PLACEHOLDER.length).toBeLessThan(120);
  });

  it("is not itself caught by the filter — it must survive a re-sync", () => {
    /**
     * A subtle one. The desktop can re-sync a batch it has already sent, and the stored placeholder
     * could come back around. If the filter matched its own output the content would be stable
     * anyway, but a pattern that matched it would signal the patterns are too loose.
     */
    expect(isClientErrorContent(CLIENT_ERROR_PLACEHOLDER)).toBe(false);
  });
});
