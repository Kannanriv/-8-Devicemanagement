import type { Integration } from "@hash8/sdk-ts";
import { DeliveryQueue, signWebhook, type Delivery } from "@hash8/ops-engine";
import type { Core } from "../context";
import type { DeliveryRecord } from "../db/repos";
import { newId } from "../util/ids";

export interface DeliveryJob {
  integration: Integration;
  event: string;
  payload: unknown;
  attempt: number;
}

export function eventMatches(patterns: string[], event: string): boolean {
  return patterns.some((p) => p === "*" || p === event || (p.endsWith(".*") && event.startsWith(p.slice(0, -1))));
}

const MAX_ATTEMPTS = 5;

/**
 * Fans platform events out to integrations. Deliveries run off the request path on
 * a bounded in-process queue with retry/backoff; HTTP targets receive an HMAC-SHA256
 * signature. Integrations without a URL (hash8-* kinds in dev) deliver to a local
 * in-process sink so the whole flow is observable with zero infrastructure.
 */
export class IntegrationService {
  private dq = new DeliveryQueue({ maxAttempts: MAX_ATTEMPTS });
  private running = 0;
  private inflight = new Set<string>();
  private idle: (() => void)[] = [];
  private statLocks = new Map<string, Promise<unknown>>();
  private retryTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  /** usage metering for hash8-crm: tenant → counter */
  private usage = new Map<string, { messages: number; bytes: number; devices: Set<string> }>();
  concurrency = 4;

  constructor(private core: Core) {}

  private async ancestors(tenantId: string): Promise<string[]> {
    const all = await this.core.tenants();
    const out: string[] = [];
    let cur = all.find((t) => t.id === tenantId);
    while (cur) {
      out.push(cur.id);
      cur = cur.parentId ? all.find((t) => t.id === cur!.parentId) : undefined;
    }
    return out.length ? out : [tenantId];
  }

  /** Emit an event to every enabled, subscribed integration of the tenant (and its parents). */
  async dispatch(tenantId: string, event: string, payload: unknown, only?: string): Promise<number> {
    const tenants = await this.ancestors(tenantId);
    const integrations = await this.core.repos.integrations.list({ tenantIds: tenants });
    let n = 0;
    for (const i of integrations) {
      if (!i.enabled || (only && i.id !== only)) continue;
      if (!eventMatches(i.events, event)) continue;
      this.enqueue({ integration: i, event, payload, attempt: 1 });
      n++;
    }
    return n;
  }

  meter(tenantId: string, deviceId: string, bytes: number) {
    let u = this.usage.get(tenantId);
    if (!u) this.usage.set(tenantId, (u = { messages: 0, bytes: 0, devices: new Set() }));
    u.messages++;
    u.bytes += bytes;
    u.devices.add(deviceId);
  }

  /** Flush aggregated usage to hash8-crm integrations as `usage.metered`. */
  async flushUsage(): Promise<number> {
    const entries = [...this.usage.entries()];
    this.usage.clear();
    let n = 0;
    const at = this.core.now().toISOString();
    for (const [tenantId, u] of entries) {
      n += await this.dispatch(tenantId, "usage.metered", {
        account: tenantId,
        period: at,
        meters: { messages: u.messages, payloadBytes: u.bytes, activeDevices: u.devices.size },
      });
    }
    return n;
  }

  /** Sign + enqueue one delivery on the ops-engine DeliveryQueue, then kick the pump. */
  enqueue(job: DeliveryJob) {
    const now = this.core.now();
    const i = job.integration;
    const envelope = { id: newId("evt"), event: job.event, at: now.toISOString(), tenantId: i.tenantId, data: job.payload };
    const body = JSON.stringify(envelope);
    const ts = Math.floor(now.getTime() / 1000);
    const signature = signWebhook(this.secretFor(i), body, ts);
    this.dq.enqueue(
      {
        integrationId: i.id,
        event: job.event,
        body,
        headers: { "content-type": "application/json", "x-hash8-event": job.event, "x-hash8-timestamp": String(ts), "x-hash8-signature": signature },
      },
      now,
    );
    this.pump();
  }

  private pump() {
    if (this.stopped) return;
    const due = this.dq.due(this.core.now(), Math.max(0, this.concurrency - this.running)).filter((d) => !this.inflight.has(d.id));
    for (const d of due) {
      this.running++;
      this.inflight.add(d.id);
      void this.attempt(d)
        .catch((err) => this.core.log.warn({ err }, "delivery crashed"))
        .finally(() => {
          this.running--;
          this.inflight.delete(d.id);
          this.pump();
          this.checkIdle();
        });
    }
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this.retryTimer || this.stopped) return;
    if (this.dq.stats().pending <= this.inflight.size) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.pump();
    }, 1000);
    this.retryTimer.unref?.();
  }

  private checkIdle() {
    if (this.running) return;
    if (this.dq.due(this.core.now(), 1).length) return;
    for (const r of this.idle.splice(0)) r();
  }

  /** Resolves when no delivery is currently due or in flight (future retries are not awaited). */
  async drain(): Promise<void> {
    if (!this.running && !this.dq.due(this.core.now(), 1).length) return;
    await new Promise<void>((r) => this.idle.push(r));
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const r of this.idle.splice(0)) r();
  }

  queueStats() {
    return { ...this.dq.stats(), deadLetters: this.dq.deadLetters().length };
  }

  private secretFor(i: Integration): string {
    const ref = i.config.secretRef;
    if (typeof ref === "string" && process.env[ref]) return process.env[ref]!;
    return `dev-${i.id}`;
  }

  /** One delivery attempt; records it and updates integration stats on final outcome. */
  private async attempt(d: Delivery): Promise<DeliveryRecord | undefined> {
    const i = await this.core.repos.integrations.get(d.integrationId);
    const now = this.core.now();
    if (!i) {
      this.dq.markFailed(d.id, "integration deleted", now);
      return undefined;
    }
    const url = typeof i.config.url === "string" && i.config.url ? i.config.url : undefined;
    let ok = false;
    let response: unknown;
    if (url) {
      try {
        const res = await fetch(url, { method: "POST", headers: d.headers ?? {}, body: d.body, signal: AbortSignal.timeout(5000) });
        ok = res.ok;
        response = { status: res.status };
      } catch (err) {
        response = { error: (err as Error).message };
      }
    } else {
      response = this.localSink(i, d.event, (JSON.parse(d.body) as { data: unknown }).data);
      ok = true;
    }
    const after = ok ? this.dq.markDelivered(d.id, now) : this.dq.markFailed(d.id, JSON.stringify(response), now);
    const record: DeliveryRecord = {
      id: newId("dlv"),
      integrationId: i.id,
      tenantId: i.tenantId,
      event: d.event,
      status: after.status === "delivered" ? "delivered" : after.status === "dead" ? "failed" : "pending",
      attempts: after.attempts,
      target: url ?? `local://${i.kind}`,
      body: JSON.parse(d.body),
      response,
      at: now.toISOString(),
    };
    const sig = d.headers?.["x-hash8-signature"];
    if (sig) record.signature = sig;
    await this.core.repos.deliveries.insert(record);
    if (after.status !== "pending") await this.bumpStats(i.id, ok, now.toISOString());
    return record;
  }

  /** Synchronous test delivery (POST /integrations/:id/test). */
  async testDelivery(i: Integration): Promise<DeliveryRecord | undefined> {
    const now = this.core.now();
    const envelope = { id: newId("evt"), event: "integration.test", at: now.toISOString(), tenantId: i.tenantId, data: { message: "Test delivery from #8 Device Management" } };
    const body = JSON.stringify(envelope);
    const ts = Math.floor(now.getTime() / 1000);
    const d = this.dq.enqueue(
      { integrationId: i.id, event: "integration.test", body, headers: { "content-type": "application/json", "x-hash8-event": "integration.test", "x-hash8-timestamp": String(ts), "x-hash8-signature": signWebhook(this.secretFor(i), body, ts) } },
      now,
    );
    this.inflight.add(d.id);
    try {
      return await this.attempt(d);
    } finally {
      this.inflight.delete(d.id);
    }
  }

  /** Simulated hash8 product endpoints (dev). */
  private localSink(i: Integration, event: string, payload: unknown): unknown {
    switch (i.kind) {
      case "hash8-ticketing": {
        const ticketId = `TCK-${Math.floor(10000 + Math.random() * 89999)}`;
        return { status: 201, ticketId, queue: (i.config.queue as string) ?? "field-ops" };
      }
      case "hash8-crm":
        return { status: 202, accepted: event === "usage.metered" ? (payload as { meters?: unknown }).meters : 1 };
      default:
        return { status: 200, sink: "local" };
    }
  }

  private async bumpStats(id: string, ok: boolean, at: string) {
    const prev = this.statLocks.get(id) ?? Promise.resolve();
    const next = prev.then(async () => {
      const cur = await this.core.repos.integrations.get(id);
      if (!cur) return;
      cur.stats = {
        delivered: cur.stats.delivered + (ok ? 1 : 0),
        failed: cur.stats.failed + (ok ? 0 : 1),
        lastDeliveryAt: at,
      };
      await this.core.repos.integrations.update(cur);
    });
    this.statLocks.set(id, next.catch(() => {}));
    await next;
  }
}
