export type LiveType = "message" | "alert" | "device" | "ota" | "command" | "audit";
export interface LiveEvent {
  type: LiveType;
  tenantId?: string;
  payload: unknown;
}

interface Client {
  send(data: string): void;
  tenantId?: string;
  readyState?: number;
}

/** Fan-out of live events to WS `/live` subscribers, filtered by tenant when the client sent one. */
export class LiveHub {
  private clients = new Set<Client>();
  private listeners = new Set<(e: LiveEvent) => void>();
  sent = 0;

  add(c: Client) {
    this.clients.add(c);
    return () => this.clients.delete(c);
  }
  /** In-process listeners (tests, SSE adapters). */
  on(fn: (e: LiveEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  get size() {
    return this.clients.size;
  }

  broadcast(e: LiveEvent) {
    for (const l of this.listeners) l(e);
    if (!this.clients.size) return;
    const data = JSON.stringify({ type: e.type, payload: e.payload });
    for (const c of this.clients) {
      if (c.readyState !== undefined && c.readyState !== 1) continue;
      if (c.tenantId && e.tenantId && c.tenantId !== e.tenantId) continue;
      try {
        c.send(data);
        this.sent++;
      } catch {
        this.clients.delete(c);
      }
    }
  }
}
