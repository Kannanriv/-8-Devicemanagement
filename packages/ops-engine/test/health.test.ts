import { describe, it, expect } from "vitest";
import { computeHealth } from "../src/index";
import { NOW } from "./fixtures";

const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000).toISOString();

describe("computeHealth", () => {
  it("never_seen when no lastSeenAt, score 0", () => {
    const h = computeHealth({ now: NOW, expectedIntervalSec: 60 });
    expect(h.connectivity).toBe("never_seen");
    expect(h.score).toBe(0);
    expect(h.issues).toContain("Never seen");
  });
  it("healthy device scores 100 with no issues", () => {
    const h = computeHealth({ lastSeenAt: ago(10), now: NOW, expectedIntervalSec: 60, battery: 95, signal: -60, errorRate: 0, msgCount1h: 60 });
    expect(h.connectivity).toBe("online");
    expect(h.score).toBe(100);
    expect(h.issues).toEqual([]);
    expect(h.msgRatePerHour).toBe(60);
    expect(h.battery).toBe(95);
    expect(h.signal).toBe(-60);
    expect(h.lastSeenAt).toBe(ago(10));
  });
  it("stays online up to exactly 3x expected interval", () => {
    expect(computeHealth({ lastSeenAt: ago(180), now: NOW, expectedIntervalSec: 60 }).connectivity).toBe("online");
  });
  it("goes offline after 3x expected interval", () => {
    const h = computeHealth({ lastSeenAt: ago(181), now: NOW, expectedIntervalSec: 60 });
    expect(h.connectivity).toBe("offline");
    expect(h.score).toBeLessThanOrEqual(50);
    expect(h.issues.some((i) => /offline/i.test(i))).toBe(true);
  });
  it("missing optional metrics are neutral", () => {
    expect(computeHealth({ lastSeenAt: ago(0), now: NOW, expectedIntervalSec: 60 }).score).toBe(100);
  });
  it("low battery reduces score and reports issue", () => {
    const h = computeHealth({ lastSeenAt: ago(0), now: NOW, expectedIntervalSec: 60, battery: 10 });
    expect(h.score).toBeLessThan(100);
    expect(h.issues.some((i) => /battery/i.test(i) && i.includes("10%"))).toBe(true);
  });
  it("weak signal reduces score and reports issue", () => {
    const h = computeHealth({ lastSeenAt: ago(0), now: NOW, expectedIntervalSec: 60, signal: -118 });
    expect(h.score).toBeLessThan(100);
    expect(h.issues.some((i) => /signal/i.test(i))).toBe(true);
  });
  it("high error rate reduces score and reports issue", () => {
    const h = computeHealth({ lastSeenAt: ago(0), now: NOW, expectedIntervalSec: 60, errorRate: 0.25 });
    expect(h.score).toBeLessThan(100);
    expect(h.issues.some((i) => /error rate/i.test(i) && i.includes("25%"))).toBe(true);
  });
  it("stale-but-online data reduces freshness", () => {
    const fresh = computeHealth({ lastSeenAt: ago(30), now: NOW, expectedIntervalSec: 60 }).score;
    const stale = computeHealth({ lastSeenAt: ago(150), now: NOW, expectedIntervalSec: 60 }).score;
    expect(stale).toBeLessThan(fresh);
    expect(stale).toBeGreaterThan(50);
  });
  it("score is an integer clamped to 0..100", () => {
    const h = computeHealth({ lastSeenAt: ago(99999), now: NOW, expectedIntervalSec: 60, battery: -5, signal: -200, errorRate: 3 });
    expect(Number.isInteger(h.score)).toBe(true);
    expect(h.score).toBeGreaterThanOrEqual(0);
    expect(h.score).toBeLessThanOrEqual(100);
  });
  it("future lastSeenAt (clock skew) is treated as just seen", () => {
    expect(computeHealth({ lastSeenAt: new Date(NOW.getTime() + 60000).toISOString(), now: NOW, expectedIntervalSec: 60 }).connectivity).toBe("online");
  });
  it("unparseable lastSeenAt is treated as never seen", () => {
    expect(computeHealth({ lastSeenAt: "garbage", now: NOW, expectedIntervalSec: 60 }).connectivity).toBe("never_seen");
  });
  it("online with zero messages in the last hour is flagged", () => {
    const h = computeHealth({ lastSeenAt: ago(0), now: NOW, expectedIntervalSec: 60, msgCount1h: 0 });
    expect(h.issues.some((i) => /no messages/i.test(i))).toBe(true);
  });
});
