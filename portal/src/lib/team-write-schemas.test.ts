// ── ⚠ TWO DOORS ONTO ONE SINK, AND ONLY ONE USED TO VALIDATE ──────────────────────────────────
//
// A code review found `POST /api/desktop/send-message` and `POST /api/desktop/create-task`
// destructuring `req.json()`, checking only that `teamId` was a non-empty string, and forwarding
// the rest verbatim to the SAME backend paths that `message.send` and `task.create` guard with
// bounded, enumerated Zod schemas.
//
// WHY THAT IS A HOLE AND NOT A MISSING SECOND COPY: `shared/constants/chat-limits.ts` records that
// the 4,000-character message ceiling is "ENFORCED IN tRPC, NOT IN THE SERVICE, that service still
// stores `content: body.content` with no length check". So the tRPC schema was the only bound in
// the whole system, and the REST door bypassed it.
//
// Reachable consequences, both verified in the repo at the time: unbounded message and task bodies
// stored per request, cost borne by every later reader of that team's chat; and a `status` outside
// the five board columns producing a task that renders in NO column (`board/page.tsx` filters
// `t.status === col.status`) while still existing in the store and counting in activity
// denominators, board state a writer could hide from every portal reader.
//
// These schemas are now the single definition both doors parse. The routers `.extend()` them, so a
// field added to the rich tRPC door cannot silently open on the bare REST one.

import { describe, it, expect } from "vitest";
import { MAX_TEAM_MESSAGE_CHARS } from "@praimana/shared";
import {
  createTaskSchema,
  joinTeamSchema,
  sendMessageSchema,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from "./team-write-schemas";

describe("sendMessageSchema, the bound the REST door used to skip", () => {
  it("accepts what the desktop client actually sends", () => {
    expect(sendMessageSchema.safeParse({ teamId: "t1", content: "hello" }).success).toBe(true);
    expect(
      sendMessageSchema.safeParse({ teamId: "t1", content: "x", type: "CODE_SNIPPET" }).success
    ).toBe(true);
  });

  it(`enforces MAX_TEAM_MESSAGE_CHARS (${MAX_TEAM_MESSAGE_CHARS}), the system's ONLY length bound`, () => {
    const at = sendMessageSchema.safeParse({ teamId: "t1", content: "x".repeat(MAX_TEAM_MESSAGE_CHARS) });
    const over = sendMessageSchema.safeParse({ teamId: "t1", content: "x".repeat(MAX_TEAM_MESSAGE_CHARS + 1) });
    expect(at.success).toBe(true);
    expect(over.success).toBe(false);
  });

  it("refuses an empty message, and a missing or non-string one", () => {
    expect(sendMessageSchema.safeParse({ teamId: "t1", content: "" }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ teamId: "t1" }).success).toBe(false);
    // The old handler forwarded whatever arrived, so a nested object reached a field typed string.
    expect(sendMessageSchema.safeParse({ teamId: "t1", content: { $ne: null } }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ teamId: "t1", content: 42 }).success).toBe(false);
  });

  it("refuses a type outside the two the renderer knows", () => {
    expect(sendMessageSchema.safeParse({ teamId: "t1", content: "x", type: "HTML" }).success).toBe(false);
  });

  it("defaults type to TEXT, matching what the old handler did with `type || \"TEXT\"`", () => {
    const parsed = sendMessageSchema.parse({ teamId: "t1", content: "x" });
    expect(parsed.type).toBe("TEXT");
  });

  it("refuses an empty teamId, which would build `/v1/teams//messages`", () => {
    expect(sendMessageSchema.safeParse({ teamId: "", content: "x" }).success).toBe(false);
  });

  it("refuses a null body, which is what a malformed-JSON request now parses as", () => {
    // The route passes `await req.json().catch(() => null)`, so this branch is what turns malformed
    // JSON into a 400 instead of the 500 it used to throw from outside the try.
    expect(sendMessageSchema.safeParse(null).success).toBe(false);
  });
});

describe("createTaskSchema, the enum the REST door used to skip", () => {
  it("accepts a minimal and a full task", () => {
    expect(createTaskSchema.safeParse({ teamId: "t1", title: "Do it" }).success).toBe(true);
    expect(
      createTaskSchema.safeParse({
        teamId: "t1",
        title: "Do it",
        description: "why",
        status: "REVIEW",
        priority: "URGENT",
      }).success
    ).toBe(true);
  });

  it("refuses a status outside the five board columns, the invisible-task defect", () => {
    // This is the exact value that produced a task rendering in no column while still counting.
    expect(createTaskSchema.safeParse({ teamId: "t1", title: "x", status: "SECRET" }).success).toBe(false);
    for (const status of TASK_STATUSES) {
      expect(createTaskSchema.safeParse({ teamId: "t1", title: "x", status }).success, status).toBe(true);
    }
  });

  it("refuses a priority outside the four", () => {
    expect(createTaskSchema.safeParse({ teamId: "t1", title: "x", priority: "WHENEVER" }).success).toBe(false);
    for (const priority of TASK_PRIORITIES) {
      expect(createTaskSchema.safeParse({ teamId: "t1", title: "x", priority }).success, priority).toBe(true);
    }
  });

  it("bounds title at 200 and description at 2000, the tRPC door's ceilings", () => {
    expect(createTaskSchema.safeParse({ teamId: "t1", title: "x".repeat(200) }).success).toBe(true);
    expect(createTaskSchema.safeParse({ teamId: "t1", title: "x".repeat(201) }).success).toBe(false);
    expect(
      createTaskSchema.safeParse({ teamId: "t1", title: "x", description: "y".repeat(2000) }).success
    ).toBe(true);
    expect(
      createTaskSchema.safeParse({ teamId: "t1", title: "x", description: "y".repeat(2001) }).success
    ).toBe(false);
  });

  it("refuses an empty or absent title", () => {
    expect(createTaskSchema.safeParse({ teamId: "t1", title: "" }).success).toBe(false);
    expect(createTaskSchema.safeParse({ teamId: "t1" }).success).toBe(false);
  });

  it("defaults status and priority the same way the tRPC door did", () => {
    const parsed = createTaskSchema.parse({ teamId: "t1", title: "x" });
    expect(parsed.status).toBe("TODO");
    expect(parsed.priority).toBe("MEDIUM");
  });
});

describe("joinTeamSchema, the membership write", () => {
  it("accepts a code and refuses an empty or absent one", () => {
    // `.min(1)` is what preserves the route's original "Invite code required" refusal.
    expect(joinTeamSchema.safeParse({ inviteCode: "ABC123" }).success).toBe(true);
    expect(joinTeamSchema.safeParse({ inviteCode: "" }).success).toBe(false);
    expect(joinTeamSchema.safeParse({}).success).toBe(false);
    expect(joinTeamSchema.safeParse(null).success).toBe(false);
  });

  it("bounds the code, since an unbounded string reaching a request body has no upper cost", () => {
    expect(joinTeamSchema.safeParse({ inviteCode: "c".repeat(200) }).success).toBe(true);
    expect(joinTeamSchema.safeParse({ inviteCode: "c".repeat(201) }).success).toBe(false);
  });

  it("refuses a non-string code", () => {
    expect(joinTeamSchema.safeParse({ inviteCode: { $gt: "" } }).success).toBe(false);
  });
});
