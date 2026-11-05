import { EventEmitter } from "node:events";

/**
 * In-process pub/sub for real-time fan-out to connected SSE clients. Replicates
 * the monolith's subscribeTeamEvents/publishTeamEvent (apps/backend/src/lib/pubsub.ts)
 * in-process for this service.
 *
 * This is deliberately separate from the EventPublisher (EventBridge): EventBridge
 * is fire-and-forget to external consumers and can't be read back in-process to
 * push to a live HTTP stream. This bus lets route handlers notify the SSE endpoint
 * in the same Node process.
 *
 * NOTE: single-process only. If the Collaboration service is ever scaled
 * horizontally, connected SSE clients would only see events produced by the same
 * instance — replace this with a shared broker (Redis pub/sub, etc.) so every
 * instance fans out to every client.
 */
const bus = new EventEmitter();
// Many concurrent SSE listeners per team are expected; lift the default cap.
bus.setMaxListeners(0);

// A single stream carries every team-scoped update. `kind` lets the client route
// each event to the right surface (chat / board). `actorId` is whoever caused the
// event, so a client can skip badging its own actions.
export type TeamEvent =
  | {
      kind: "message";
      teamId: string;
      actorId: string;
      createdAt: string;
      id: string;
      content: string;
      type: string;
    }
  | {
      kind: "task";
      teamId: string;
      actorId: string;
      createdAt: string;
      action: "created" | "updated" | "deleted";
      taskId: string;
      title?: string;
      status?: string;
    };

const teamKey = (teamId: string) => `team:${teamId}`;

export function publishTeamEvent(event: TeamEvent): void {
  bus.emit(teamKey(event.teamId), event);
}

export function subscribeTeamEvents(
  teamId: string,
  handler: (event: TeamEvent) => void
): () => void {
  const key = teamKey(teamId);
  bus.on(key, handler);
  return () => bus.off(key, handler);
}
