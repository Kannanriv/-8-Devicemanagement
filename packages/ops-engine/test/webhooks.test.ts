import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signWebhook, verifyWebhook, retryDelayMs, DeliveryQueue, RETRY_CAP_MS } from "../src/index";
import { NOW } from "./fixtures";

const secret = "whsec_test";
const body = '{"event":"device.lifecycle","id":"dev-1"}';
const ts = 1_790_000_000;

describe("signWebhook / verifyWebhook", () => {
  it("produces t=<ts>,v1=<hex hmac of ts.body>", () => {
    const expected = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    expect(signWebhook(secret, body, ts)).toBe(`t=${ts},v1=${expected}`);
  });
  it("verifies a valid signature within tolerance", () => {
    expect(verifyWebhook(secret, body, signWebhook(secret, body, ts), ts + 100)).toBe(true);
  });
  it("rejects tampered body, wrong secret, and stale timestamps", () => {
    const h = signWebhook(secret, body, ts);
    expect(verifyWebhook(secret, body + " ", h, ts)).toBe(false);
    expect(verifyWebhook("other", body, h, ts)).toBe(false);
    expect(verifyWebhook(secret, body, h, ts + 301)).toBe(false);
    expect(verifyWebhook(secret, body, h, ts - 301)).toBe(false);
    expect(verifyWebhook(secret, body, h, ts + 1000, 2000)).toBe(true);
  });
  it("rejects malformed headers without throwing", () => {
    for (const h of ["", "garbage", "t=abc,v1=00", `t=${ts}`, `t=${ts},v1=zz`, `v1=${"a".repeat(64)}`]) {
      expect(verifyWebhook(secret, body, h, ts)).toBe(false);
    }
  });
  it("accepts any matching v1 among several (secret rotation)", () => {
    const good = signWebhook(secret, body, ts).split("v1=")[1]!;
    expect(verifyWebhook(secret, body, `t=${ts},v1=${"0".repeat(64)},v1=${good}`, ts)).toBe(true);
  });
});

describe("retryDelayMs", () => {
  it("full jitter: 0 .. base*2^(attempt-1)", () => {
    expect(retryDelayMs(1, () => 0.999999)).toBeLessThan(1000);
    expect(retryDelayMs(1, () => 0)).toBe(0);
    expect(retryDelayMs(3, () => 0.5)).toBe(2000);
    expect(retryDelayMs(4, () => 0.999999)).toBeGreaterThanOrEqual(7999);
  });
  it("caps at 15 minutes and survives huge attempts", () => {
    expect(RETRY_CAP_MS).toBe(15 * 60 * 1000);
    expect(retryDelayMs(30, () => 0.999999)).toBeLessThanOrEqual(RETRY_CAP_MS);
    expect(retryDelayMs(10_000, () => 0.5)).toBe(RETRY_CAP_MS / 2);
  });
  it("treats attempt < 1 as first attempt and returns integers", () => {
    expect(retryDelayMs(0, () => 0.5)).toBe(500);
    expect(Number.isInteger(retryDelayMs(5))).toBe(true);
  });
});

describe("DeliveryQueue", () => {
  const later = (ms: number) => new Date(NOW.getTime() + ms);
  const mk = () => new DeliveryQueue({ rand: () => 0.5 });

  it("enqueue makes item due immediately", () => {
    const q = mk();
    const d = q.enqueue({ integrationId: "int-1", event: "device.lifecycle", body }, NOW);
    expect(d).toMatchObject({ attempts: 0, status: "pending", integrationId: "int-1" });
    expect(q.due(NOW).map((x) => x.id)).toEqual([d.id]);
    expect(q.stats()).toMatchObject({ pending: 1, delivered: 0, dead: 0 });
  });
  it("markDelivered removes from due and counts", () => {
    const q = mk();
    const d = q.enqueue({ integrationId: "i", event: "e", body }, NOW);
    q.markDelivered(d.id, NOW);
    expect(q.due(later(1e9))).toEqual([]);
    expect(q.stats()).toMatchObject({ pending: 0, delivered: 1 });
  });
  it("markFailed reschedules with backoff and records error", () => {
    const q = mk();
    const d = q.enqueue({ integrationId: "i", event: "e", body }, NOW);
    const f = q.markFailed(d.id, "HTTP 503", NOW);
    expect(f).toMatchObject({ attempts: 1, status: "pending", lastError: "HTTP 503" });
    expect(f.nextAttemptAt).toBe(later(500).toISOString());
    expect(q.due(later(499))).toEqual([]);
    expect(q.due(later(500))).toHaveLength(1);
  });
  it("dead-letters after maxAttempts (8)", () => {
    const q = mk();
    const d = q.enqueue({ integrationId: "i", event: "e", body }, NOW);
    let last;
    for (let i = 0; i < 8; i++) last = q.markFailed(d.id, "boom", NOW);
    expect(last!.status).toBe("dead");
    expect(q.due(later(1e10))).toEqual([]);
    expect(q.deadLetters().map((x) => x.id)).toEqual([d.id]);
    expect(q.stats()).toMatchObject({ pending: 0, dead: 1, failedAttempts: 8 });
  });
  it("due returns oldest first and honours limit", () => {
    const q = mk();
    const a = q.enqueue({ integrationId: "i", event: "e", body }, later(10));
    const b = q.enqueue({ integrationId: "i", event: "e", body }, NOW);
    expect(q.due(later(20)).map((x) => x.id)).toEqual([b.id, a.id]);
    expect(q.due(later(20), 1)).toHaveLength(1);
  });
  it("retryDead requeues a dead letter", () => {
    const q = new DeliveryQueue({ maxAttempts: 1, rand: () => 0 });
    const d = q.enqueue({ integrationId: "i", event: "e", body }, NOW);
    q.markFailed(d.id, "x", NOW);
    q.retryDead(d.id, NOW);
    expect(q.due(NOW)).toHaveLength(1);
    expect(q.stats().dead).toBe(0);
  });
  it("throws on unknown ids", () => {
    expect(() => mk().markDelivered("nope", NOW)).toThrow();
  });
  it("uses injected id factory", () => {
    let n = 0;
    const q = new DeliveryQueue({ idFactory: () => `del-${++n}` });
    expect(q.enqueue({ integrationId: "i", event: "e", body }, NOW).id).toBe("del-1");
  });
});
