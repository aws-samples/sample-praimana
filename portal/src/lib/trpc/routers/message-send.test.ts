// ── ⚠ THE SEND MUTATION HAD NO CALLER FOR ITS ENTIRE EXISTENCE ───────────────────────────
//
// REPORTED as "on portal executives cant send team chat messages". They could not, and neither could
// anyone else: the portal's team chat page rendered a transcript and nothing more, while
// `message.send` sat in this router with ZERO call sites. The executive write grant in the
// collaboration service was complete and deployed the whole time, there was simply no UI.
//
// So the composer is new, and these pin the contract it now depends on. The schema IS the bug surface
// (a bound the UI cannot see is a bound discovered by hitting it), so it is tested directly rather
// than through a mocked tRPC caller, which would prove the mock.

import { describe, it, expect } from "vitest";
import { messageRouter } from "./message";
import { MAX_TEAM_MESSAGE_CHARS, SHOW_REMAINING_WITHIN } from "@/lib/chat-limits";

/** The zod object tRPC built for `message.send`. */
function sendSchema() {
  const proc = (messageRouter as unknown as {
    _def: { procedures: Record<string, { _def: { inputs: unknown[] } }> };
  })._def.procedures.send;
  return proc._def.inputs[0] as {
    safeParse: (v: unknown) => { success: boolean };
  };
}

const send = (over: Record<string, unknown> = {}) =>
  sendSchema().safeParse({ teamId: "t1", content: "hello team", ...over });

describe("the bound the composer shows is the bound the server enforces", () => {
  /**
   * ⚠ THE WHOLE POINT OF THE SHARED CONSTANT. The schema carried a bare `4000` and the textarea knew
   * nothing about it, so the only way to learn the limit was to write a long message and have it
   * refused after the fact. A `maxLength` typed independently is the second copy of a number that must
   * agree, which is how a client that truncates at 4,096 talks to a server that refuses at 4,000.
   */
  it("accepts a message exactly at the limit", () => {
    expect(send({ content: "x".repeat(MAX_TEAM_MESSAGE_CHARS) }).success).toBe(true);
  });

  it("rejects one character past it", () => {
    expect(send({ content: "x".repeat(MAX_TEAM_MESSAGE_CHARS + 1) }).success).toBe(false);
  });

  /**
   * ⚠ AND THE COMPOSER'S `maxLength` IS A COURTESY, NOT THE BOUNDARY. This schema is what a caller
   * cannot bypass, the page is reachable by anyone with a session, and the collaboration service
   * checks membership independently. The constant exists so the two agree, not so the client is
   * trusted.
   */
  it("the courtesy threshold is inside the limit, or the counter would never appear", () => {
    expect(SHOW_REMAINING_WITHIN).toBeGreaterThan(0);
    expect(SHOW_REMAINING_WITHIN).toBeLessThan(MAX_TEAM_MESSAGE_CHARS);
  });
});

describe("⚠ an empty message is refused, so a stray Enter cannot post nothing", () => {
  /**
   * The composer trims before sending and disables the button on an empty draft, but Enter is bound
   * to submit, and a keystroke race or a future refactor must not be able to post whitespace. The
   * schema is the backstop.
   */
  it("rejects an empty string", () => {
    expect(send({ content: "" }).success).toBe(false);
  });

  it("requires a teamId, a message with no team has nowhere to go", () => {
    expect(sendSchema().safeParse({ content: "hello" }).success).toBe(false);
  });
});

describe("the shape the composer actually submits", () => {
  it("accepts teamId + content alone, with no type or parentId", () => {
    // The composer sends exactly this. `type` defaults to TEXT and `parentId` is for threading,
    // which this UI does not offer, so both must be optional or the mutation would reject every
    // message the page sends.
    expect(send().success).toBe(true);
  });

  it("still accepts the optional fields, so threading is not foreclosed", () => {
    expect(send({ type: "CODE_SNIPPET", parentId: "m-1" }).success).toBe(true);
  });

  it("rejects an unknown message type rather than storing it", () => {
    expect(send({ type: "VIDEO" }).success).toBe(false);
  });
});
