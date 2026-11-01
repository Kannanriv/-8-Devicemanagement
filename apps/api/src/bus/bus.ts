/**
 * Event bus abstraction. Dev: in-memory (synchronous fan-out, async handlers).
 * Prod: Kafka/Redpanda with the same topic names (see README.md).
 */
export type Topic = "raw.v1" | "decoded.v1" | "unknown.v1" | "events.v1";

export interface BusEvent<T = unknown> {
  topic: Topic;
  key: string; // partition key (device id) — preserves per-device ordering in Kafka
  value: T;
  at: string;
}

export type Handler<T = unknown> = (e: BusEvent<T>) => void | Promise<void>;

export interface EventBus {
  publish<T>(topic: Topic, key: string, value: T): void;
  subscribe<T>(topic: Topic, handler: Handler<T>): () => void;
  /** Resolves once all in-flight handler promises settle (tests / shutdown). */
  drain(): Promise<void>;
}

export class InMemoryBus implements EventBus {
  private handlers = new Map<Topic, Set<Handler>>();
  private inflight = new Set<Promise<unknown>>();
  constructor(private onError: (err: unknown, topic: Topic) => void = () => {}) {}

  publish<T>(topic: Topic, key: string, value: T): void {
    const e: BusEvent<T> = { topic, key, value, at: new Date().toISOString() };
    for (const h of this.handlers.get(topic) ?? []) {
      try {
        const r = (h as Handler<T>)(e);
        if (r && typeof (r as Promise<void>).then === "function") {
          const p = (r as Promise<void>).catch((err) => this.onError(err, topic));
          this.inflight.add(p);
          void p.finally(() => this.inflight.delete(p));
        }
      } catch (err) {
        this.onError(err, topic);
      }
    }
  }

  subscribe<T>(topic: Topic, handler: Handler<T>) {
    if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
    this.handlers.get(topic)!.add(handler as Handler);
    return () => void this.handlers.get(topic)?.delete(handler as Handler);
  }

  async drain() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }
}
