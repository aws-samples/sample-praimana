import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";

/**
 * Cross-service communication is via events, not synchronous cross-database
 * reads. A service publishes a domain event; other services subscribe (via
 * EventBridge rules → SQS → their consumer) and update their own data / read-models.
 *
 * This is the mechanism that lets us untangle the monolith's shared data:
 *   - Identity publishes `user.updated` → services holding a users read-model refresh it.
 *   - Evaluation subscribes to `task.created`, `ai.response-generated`, etc. to build
 *     its scoring read-model instead of scanning 8 tables.
 *
 * The interface (EventPublisher) is what domain code depends on (DIP) — the
 * EventBridge implementation is swappable for an in-memory bus in tests.
 */
export interface DomainEvent<T = unknown> {
  source: string; // e.g. "identity-service"
  type: string; // e.g. "user.updated"
  detail: T;
  /**
   * The BUS's own unique id for this delivery, when the event arrived from one.
   *
   * Optional because an in-process publisher has no bus and no id — but a consumer that
   * mutates a counter NEEDS it. EventBridge is at-least-once: it may deliver twice, or
   * deliver once, have the write succeed, lose the response, and retry. Without a stable
   * id per delivery there is nothing to deduplicate against, so a blind `+ 1` silently
   * over-counts and no later pass can tell.
   *
   * Consumers that are naturally idempotent (a full-item upsert) can ignore it. Consumers
   * that increment must not.
   */
  id?: string;
}

export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

/** EventBridge-backed publisher. Fire-and-forget; failures are logged, not thrown,
 *  so a bus hiccup never fails the originating write (the write is the source of
 *  truth; consumers reconcile via retries/DLQ). */
export class EventBridgePublisher implements EventPublisher {
  private readonly client: EventBridgeClient;
  private readonly busName: string;

  constructor(busName = process.env.EVENT_BUS_NAME || "praimana-events") {
    this.client = new EventBridgeClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
    this.busName = busName;
  }

  async publish(event: DomainEvent): Promise<void> {
    try {
      await this.client.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: this.busName,
              Source: event.source,
              DetailType: event.type,
              Detail: JSON.stringify(event.detail ?? {}),
            },
          ],
        })
      );
    } catch (err) {
      // Structured logging: constant message + discrete fields, so the event
      // type (application-set, but kept out of the format string regardless)
      // can never be interpreted as a format specifier.
      console.error("[event-bus] failed to publish", {
        type: event.type,
        source: event.source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** In-memory publisher for tests and local single-service dev. Records what was
 *  published so tests can assert on it (Liskov-substitutable for the real one). */
export class InMemoryPublisher implements EventPublisher {
  readonly published: DomainEvent[] = [];
  async publish(event: DomainEvent): Promise<void> {
    this.published.push(event);
  }
}
