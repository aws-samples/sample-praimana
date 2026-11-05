// ── ⚠ THE EVENT STREAM FOLLOWS THE TENANT ─────────────────────────────────────────────────────
//
// `startTeamEventStream` reads `team_id` ONCE, remembers it in `eventStreamTeamId`, and builds
// `ws(s)://…/v1/teams/{teamId}/events` from that captured value. It never re-reads the setting, so the
// socket is bound to the team it was started for — and the only two places that re-bound it were
// `events:subscribe` and `auth:switchAccount`, which stops and restarts it explicitly.
//
// The two handlers that ACTUALLY change the tenant did neither. `ai:joinTeam` and `ai:selectTeam` both
// write all four tenant rows through `writeTeamContext` and left the socket alone, and the renderer's
// only trigger is `useTeamUnread`, whose subscribe sits in a `[]`-dependency effect inside a hook
// mounted once at the top of `App` — so nothing re-subscribed either.
//
// ⚠ TWO BUGS FROM ONE OMISSION, and the functional one is worse than the isolation one: the NEW team
// received no events at all until the app was restarted, while the OLD team's frames kept arriving and
// were badged and chimed as the new team's activity.
//
// ⚠ WHAT IS ASSERTED HOW. The frame filter is a pure function and is tested as one. The re-bind is a
// property of a function whose effects need a WebSocket server, so it is asserted against the source —
// the same technique event-stream-auth.test.ts uses for the header carrier, and for the same reason.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const AI = readFileSync(local("./handlers/ai.ts"), "utf8");
/** Comments discuss these calls at length; only code counts for an ordering claim. */
const code = AI.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

describe("⚠ writeTeamContext re-binds the stream", () => {
  const body = (() => {
    const start = code.indexOf("function writeTeamContext");
    expect(start, "writeTeamContext must exist").toBeGreaterThan(-1);
    // To the end of the function: the next top-level declaration.
    const end = code.indexOf("\nexport function isFrameForCurrentTenant", start);
    return code.slice(start, end > -1 ? end : start + 2_000);
  })();

  it("stops and starts the stream", () => {
    expect(body).toContain("stopTeamEventStream()");
    expect(body).toContain("startTeamEventStream()");
  });

  /**
   * ⚠ STOP BEFORE START. `startTeamEventStream` no-ops when it is already streaming the team it reads
   * from settings, so the order is what guarantees the old socket is torn down rather than left to the
   * reconnect loop. It is also what `auth:switchAccount` does.
   */
  it("stops BEFORE it starts", () => {
    expect(body.indexOf("stopTeamEventStream()")).toBeLessThan(
      body.indexOf("startTeamEventStream()")
    );
  });

  /**
   * ⚠ AFTER THE FOUR ROWS ARE WRITTEN, not before. `startTeamEventStream` reads `team_id` from
   * settings, so re-binding first would re-open the socket on the OLD team and the change would do
   * nothing at all — the failure mode being fixed, reintroduced with extra steps.
   */
  it("re-binds AFTER the tenant rows are written", () => {
    expect(body.indexOf('writeSetting("team_id"')).toBeLessThan(
      body.indexOf("stopTeamEventStream()")
    );
  });

  /**
   * ⚠ THE POINT OF PUTTING IT HERE. Both tenant-changing handlers go through this function, so neither
   * has to remember — and a third will inherit it. Asserted as "the handlers do NOT do it themselves",
   * because a copy at each call site is the shape that rots.
   */
  it("is the single place that does it, so both handlers inherit it", () => {
    for (const handler of ['"ai:joinTeam"', '"ai:selectTeam"']) {
      const at = code.indexOf(handler);
      expect(at, `${handler} must exist`).toBeGreaterThan(-1);
      const handlerBody = code.slice(at, at + 3_000);
      expect(handlerBody, `${handler} calls writeTeamContext`).toContain("writeTeamContext({");
      expect(
        handlerBody.slice(0, handlerBody.indexOf("writeTeamContext({")),
        `${handler} must not re-bind on its own`
      ).not.toContain("startTeamEventStream()");
    }
  });
});

/**
 * ── ⚠ THE BACKSTOP ────────────────────────────────────────────────────────────────────────────
 *
 * The re-bind is the fix. This covers what the re-bind cannot: the window before an aborted socket
 * actually closes, and membership revoked server-side — where authorisation was checked at handshake
 * only, so frames keep arriving for the life of the connection.
 */
describe("⚠ isFrameForCurrentTenant", () => {
  it("forwards a frame for the current team", async () => {
    const { isFrameForCurrentTenant } = await import("./handlers/ai");
    expect(isFrameForCurrentTenant("team-a", "team-a")).toBe(true);
  });

  it("⚠ drops a frame for a team the app has left", async () => {
    const { isFrameForCurrentTenant } = await import("./handlers/ai");
    expect(isFrameForCurrentTenant("team-a", "team-b")).toBe(false);
  });

  /**
   * ⚠ THE DEFAULT THAT MATTERS MOST. Not every event shape carries `teamId`, so dropping unlabelled
   * frames would silently break whichever event type omits it — a tenant filter must not become a
   * feature gate. Only a frame that POSITIVELY names a different team is refused.
   */
  it("forwards a frame that does not name a team at all", async () => {
    const { isFrameForCurrentTenant } = await import("./handlers/ai");
    for (const absent of [undefined, null, "", 0, false, {}, []]) {
      expect(
        isFrameForCurrentTenant(absent, "team-b"),
        `an unlabelled frame (${JSON.stringify(absent)}) must still be delivered`
      ).toBe(true);
    }
  });

  /**
   * ⚠ AND EVERY FRAME IS FORWARDED WHEN THE APP IS ON NO TEAM. Signed in but not yet joined is a real
   * state, and in it there is nothing for a frame to disagree with.
   */
  it("forwards everything when there is no current tenant", async () => {
    const { isFrameForCurrentTenant } = await import("./handlers/ai");
    expect(isFrameForCurrentTenant("team-a", null)).toBe(true);
    expect(isFrameForCurrentTenant("team-a", "")).toBe(true);
    expect(isFrameForCurrentTenant("team-a", undefined)).toBe(true);
  });

  it("is used by the message handler, before the broadcast", () => {
    const handler = code.slice(code.indexOf('ws.on("message"'));
    const check = handler.indexOf("isFrameForCurrentTenant(");
    const forward = handler.indexOf('broadcast("team:event"');
    expect(check, "the filter must be applied").toBeGreaterThan(-1);
    expect(check, "and before the frame reaches the renderer").toBeLessThan(forward);
  });

  /**
   * ⚠ COMPARED AGAINST THE SETTING, NOT THE CAPTURED `teamId`. The captured value is what the socket
   * was opened for, so comparing a frame to it would always agree and assert nothing.
   */
  it("compares against the live setting rather than the captured id", () => {
    const handler = code.slice(code.indexOf('ws.on("message"'));
    const window = handler.slice(0, handler.indexOf('broadcast("team:event"'));
    expect(window).toContain('getSetting("team_id")');
    expect(window, "eventStreamTeamId would be a tautology here").not.toContain("eventStreamTeamId");
  });
});
