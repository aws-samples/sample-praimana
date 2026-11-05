import { describe, it, expect } from "vitest";
import { publishTeamEvent, subscribeTeamEvents, type TeamEvent } from "./live-bus.js";

/**
 * The live bus is what makes the board and chat feel real-time: mutation routes
 * publish, the WebSocket layer subscribes. It is process-local and untyped at the
 * EventEmitter boundary, so the two properties worth pinning are (a) events reach
 * every listener for THAT team and (b) they reach no listener for any other team —
 * a leak here would push one team's chat into another team's socket.
 */

const message = (teamId: string, over: Partial<TeamEvent> = {}): TeamEvent =>
  ({
    kind: "message",
    teamId,
    actorId: "u1",
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "m1",
    content: "hello",
    type: "TEXT",
    ...over,
  }) as TeamEvent;

describe("publishTeamEvent / subscribeTeamEvents", () => {
  it("delivers an event to a subscriber of the same team", () => {
    const seen: TeamEvent[] = [];
    const unsub = subscribeTeamEvents("t1", (e) => seen.push(e));

    publishTeamEvent(message("t1"));

    expect(seen).toEqual([message("t1")]);
    unsub();
  });

  it("fans out to every subscriber of the team", () => {
    // Multiple browser tabs / teammates are each a separate subscription.
    const a: TeamEvent[] = [];
    const b: TeamEvent[] = [];
    const unsubA = subscribeTeamEvents("t1", (e) => a.push(e));
    const unsubB = subscribeTeamEvents("t1", (e) => b.push(e));

    publishTeamEvent(message("t1"));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    unsubA();
    unsubB();
  });

  it("does NOT deliver another team's events", () => {
    // The isolation property. A regression here is a cross-team data leak over a
    // live socket, which no request-level authorization would catch.
    const seen: TeamEvent[] = [];
    const unsub = subscribeTeamEvents("t1", (e) => seen.push(e));

    publishTeamEvent(message("t2"));

    expect(seen).toHaveLength(0);
    unsub();
  });

  it("stops delivering after the returned unsubscribe is called", () => {
    // Every closed socket calls this. If it did not actually detach, each
    // connection would leak a listener for the lifetime of the process.
    const seen: TeamEvent[] = [];
    const unsub = subscribeTeamEvents("t1", (e) => seen.push(e));

    publishTeamEvent(message("t1"));
    unsub();
    publishTeamEvent(message("t1", { id: "m2" }));

    expect(seen).toHaveLength(1);
  });

  it("unsubscribes only the handler it was returned for", () => {
    const a: TeamEvent[] = [];
    const b: TeamEvent[] = [];
    const unsubA = subscribeTeamEvents("t1", (e) => a.push(e));
    const unsubB = subscribeTeamEvents("t1", (e) => b.push(e));

    unsubA();
    publishTeamEvent(message("t1"));

    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
    unsubB();
  });

  it("publishing with no subscribers is a no-op, not a throw", () => {
    // Mutation routes publish unconditionally; nobody may be connected.
    expect(() => publishTeamEvent(message("nobody-listening"))).not.toThrow();
  });

  it("carries both event kinds through unchanged", () => {
    // `kind` is how the client routes an event to chat vs. the board, and `actorId`
    // is how it skips badging the user's own action. Both must survive the hop.
    const seen: TeamEvent[] = [];
    const unsub = subscribeTeamEvents("t1", (e) => seen.push(e));

    const task: TeamEvent = {
      kind: "task",
      teamId: "t1",
      actorId: "u2",
      createdAt: "2026-01-01T00:00:01.000Z",
      action: "updated",
      taskId: "task-1",
      title: "Ship it",
      status: "DONE",
    };
    publishTeamEvent(message("t1"));
    publishTeamEvent(task);

    expect(seen.map((e) => e.kind)).toEqual(["message", "task"]);
    expect(seen[1]).toEqual(task);
    unsub();
  });
});
