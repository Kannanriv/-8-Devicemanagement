import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { OpsError } from "./errors";

/** Header value `t=<ts>,v1=<hex hmac-sha256 of "<ts>.<body>">`. */
export function signWebhook(secret: string, body: string, timestampSec: number): string {
  const sig = createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex");
  return `t=${timestampSec},v1=${sig}`;
}

/** Constant-time verification; accepts any of several v1 signatures (key rotation). Never throws. */
export function verifyWebhook(secret: string, body: string, header: string, nowSec: number, toleranceSec = 300): boolean {
  let ts: number | undefined;
  const sigs: string[] = [];
  for (const part of (header ?? "").split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t" && /^\d+$/.test(v)) ts = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) sigs.push(v.toLowerCase());
  }
  if (ts === undefined || !sigs.length) return false;
  if (Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = Buffer.from(signWebhook(secret, body, ts).slice(`t=${ts},v1=`.length), "hex");
  let ok = false;
  for (const s of sigs) {
    const got = Buffer.from(s, "hex");
    if (got.length === expected.length && timingSafeEqual(got, expected)) ok = true;
  }
  return ok;
}

export const RETRY_BASE_MS = 1000;
export const RETRY_CAP_MS = 15 * 60 * 1000;

/** Exponential backoff with full jitter: uniform in [0, min(cap, base·2^(attempt-1))). attempt is 1-based. */
export function retryDelayMs(attempt: number, rand: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (n - 1));
  return Math.floor(Math.min(1, Math.max(0, rand())) * ceiling);
}

export interface DeliveryInput {
  integrationId: string;
  event: string;
  body: string;
  headers?: Record<string, string>;
}

export interface Delivery extends DeliveryInput {
  id: string;
  status: "pending" | "delivered" | "dead";
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  lastError?: string;
  deliveredAt?: string;
}

export interface DeliveryQueueOptions {
  maxAttempts?: number;
  rand?: () => number;
  idFactory?: () => string;
}

export interface DeliveryStats {
  pending: number;
  delivered: number;
  dead: number;
  failedAttempts: number;
  total: number;
}

/**
 * In-memory webhook delivery queue. Delivered items are counted then dropped to
 * bound memory; dead letters are retained for inspection / manual retry.
 */
export class DeliveryQueue {
  readonly maxAttempts: number;
  private readonly rand: () => number;
  private readonly idFactory: () => string;
  private readonly pending = new Map<string, Delivery>();
  private readonly dead = new Map<string, Delivery>();
  private deliveredCount = 0;
  private failedAttempts = 0;

  constructor(opts: DeliveryQueueOptions = {}) {
    this.maxAttempts = opts.maxAttempts ?? 8;
    this.rand = opts.rand ?? Math.random;
    this.idFactory = opts.idFactory ?? (() => randomUUID());
  }

  enqueue(input: DeliveryInput, now: Date): Delivery {
    const at = now.toISOString();
    const d: Delivery = { ...input, id: this.idFactory(), status: "pending", attempts: 0, nextAttemptAt: at, createdAt: at };
    this.pending.set(d.id, d);
    return { ...d };
  }

  /** Pending deliveries whose nextAttemptAt ≤ now, earliest first. */
  due(now: Date, limit = Infinity): Delivery[] {
    const t = now.getTime();
    return [...this.pending.values()]
      .filter((d) => Date.parse(d.nextAttemptAt) <= t)
      .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt) || a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((d) => ({ ...d }));
  }

  private get(id: string): Delivery {
    const d = this.pending.get(id);
    if (!d) throw new OpsError("DELIVERY_NOT_FOUND", `No pending delivery ${id}`);
    return d;
  }

  markDelivered(id: string, now: Date): Delivery {
    const d = this.get(id);
    this.pending.delete(id);
    this.deliveredCount++;
    return { ...d, status: "delivered", attempts: d.attempts + 1, deliveredAt: now.toISOString() };
  }

  markFailed(id: string, error: string, now: Date): Delivery {
    const d = this.get(id);
    this.failedAttempts++;
    d.attempts++;
    d.lastError = error;
    if (d.attempts >= this.maxAttempts) {
      d.status = "dead";
      this.pending.delete(id);
      this.dead.set(id, d);
    } else {
      d.nextAttemptAt = new Date(now.getTime() + retryDelayMs(d.attempts, this.rand)).toISOString();
    }
    return { ...d };
  }

  deadLetters(): Delivery[] {
    return [...this.dead.values()].map((d) => ({ ...d }));
  }

  /** Move a dead letter back to pending with a fresh attempt budget. */
  retryDead(id: string, now: Date): Delivery {
    const d = this.dead.get(id);
    if (!d) throw new OpsError("DELIVERY_NOT_FOUND", `No dead letter ${id}`);
    this.dead.delete(id);
    const again: Delivery = { ...d, status: "pending", attempts: 0, nextAttemptAt: now.toISOString() };
    this.pending.set(id, again);
    return { ...again };
  }

  stats(): DeliveryStats {
    return {
      pending: this.pending.size,
      delivered: this.deliveredCount,
      dead: this.dead.size,
      failedAttempts: this.failedAttempts,
      total: this.pending.size + this.deliveredCount + this.dead.size,
    };
  }
}
