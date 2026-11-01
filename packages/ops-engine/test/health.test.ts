import { describe, it, expect } from "vitest";
import { computeHealth } from "../src/index";
import { NOW } from "./fixtures";

const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000).toISOString();

describe("computeHealth: connectivity", () => {
  it("never_seen when no lastSeenAt, score 0", () => {
    const h = computeHealth({ now: NOW, expectedIntervalSec: 60 });
    expect(h.connectivity).toBe("never_seen");
    expect(h.score).toBe(0);
    expect(h.issues).toContain("Never seen");
  });
  it("online up to exactly 1x expected interval", () => {
    expect(computeHealth({ lastSeenAt: ago(60), now: NOW, expectedIntervalSec: 60 }).connectivity).toBe("online");
  });
  it("stale between 1x and 3x expected interval", () => {
    const h = computeHealth({ lastSeenAt: ago(61), now: NOW, expectedIntervalSec: 60 });
    expect(h.connectivity).toBe("stale");
    expect(h.issues.some((i) => /stale/i.test(i))).toBe(true);
    expect(computeHealth({ lastSeenAt: ago(180), now: NOW, expectedIntervalSec: 60 }).connectivity).toBe("stale");
  });
  it("offline after 3x expected interval", () => {
    const h = computeHealth({ lastSeenAt: ago(181), now: NOW, expectedIntervalSec: 60 });
    expect(h.connectivity).toBe("offline");
    expect(h.score).toBeLessThanOrEqual(50);
    expect(h.issues.some((i) => /offline/i.test(i))).toBe(true);
  });
  it("a recent heartbeat counts as contact", () => {
    const h = computeHealth({ lastSeenAt: ago(9999), lastHeartbeatAt: ago(10), now: NOW, expectedIntervalSec: 60 });
    expect(h.connectivity).toBe("online");
    expect(h.lastHeartbeatAt).toBe(ago(10));
  });
  it("heartbeat alone (no lastSeenAt) is enough to be seen", () => {
    expect(computeHealth({ lastHeartbeatAt: ago(10), now: NOW, expectedIntervalSec: 60 }).connectivity).toBe("online");
  });
  it("fresh contact but old telemetry is stale", () => {
    const h = computeHealth({ lastSeenAt: ago(5), newestTelemetryAt: ago(600), now: NOW, expectedIntervalSec: 60 });
    expect(h.connectivity).toBe("stale");
    expect(h.dataFreshnessSec).toBe(600);
  });
  it("future lastSeenAt (clock skew) is treated as just seen", () => {
    expect(computeHealth({ lastSeenAt: new Date(NOW.getTime() + 60000).toISOString(), now: NOW, expectedIntervalSec: 60 }).connectivity).toBe("online");
  });
  it("unparseable lastSeenAt is treated as never seen", () => {
    expect(computeHealth({ lastSeenAt: "garbage", now: NOW, expectedIntervalSec: 60 }).connectivity).toBe("never_seen");
  });
});

describe("computeHealth: score and issues", () => {
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
  it("stale data reduces freshness but stays above 50", () => {
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
  it("online with zero messages in the last hour is flagged", () => {
    const h = computeHealth({ lastSeenAt: ago(0), now: NOW, expectedIntervalSec: 60, msgCount1h: 0 });
    expect(h.issues.some((i) => /no messages/i.test(i))).toBe(true);
  });
});

describe("computeHealth: level", () => {
  it("normal at >= 70", () => {
    expect(computeHealth({ lastSeenAt: ago(0), now: NOW, expectedIntervalSec: 60 }).level).toBe("normal");
  });
  it("warning between 40 and 69", () => {
    // online, battery 0 (−20), signal −120 (−15) → 65
    const h = computeHealth({ lastSeenAt: ago(0), now: NOW, expectedIntervalSec: 60, battery: 0, signal: -120 });
    expect(h.score).toBe(65);
    expect(h.level).toBe("warning");
  });
  it("critical below 40", () => {
    // stale at 3x (freshness 0) + flat battery, no signal, all errors → 35
    const h = computeHealth({ lastSeenAt: ago(180), now: NOW, expectedIntervalSec: 60, battery: 0, signal: -120, errorRate: 1 });
    expect(h.connectivity).toBe("stale");
    expect(h.score).toBe(35);
    expect(h.level).toBe("critical");
  });
  it("critical whenever offline, even with a decent score", () => {
    const h = computeHealth({ lastSeenAt: ago(181), now: NOW, expectedIntervalSec: 60 });
    expect(h.score).toBe(50);
    expect(h.level).toBe("critical");
  });
  it("never_seen is critical (score 0)", () => {
    expect(computeHealth({ now: NOW, expectedIntervalSec: 60 }).level).toBe("critical");
  });
});

describe("computeHealth: pass-through fields", () => {
  it("passes gps, engineHours, heartbeat and computes dataFreshnessSec", () => {
    const gps = { lat: 12.97, lng: 77.59, at: ago(30), fix: true };
    const h = computeHealth({ lastSeenAt: ago(5), lastHeartbeatAt: ago(3), newestTelemetryAt: ago(42), gps, engineHours: 1234.5, now: NOW, expectedIntervalSec: 60 });
    expect(h.gps).toEqual(gps);
    expect(h.engineHours).toBe(1234.5);
    expect(h.lastHeartbeatAt).toBe(ago(3));
    expect(h.dataFreshnessSec).toBe(42);
  });
  it("passes through fields even for never-seen devices", () => {
    const h = computeHealth({ now: NOW, expectedIntervalSec: 60, engineHours: 7 });
    expect(h.engineHours).toBe(7);
  });
  it("omits absent optional fields", () => {
    const h = computeHealth({ lastSeenAt: ago(5), now: NOW, expectedIntervalSec: 60 });
    expect("gps" in h).toBe(false);
    expect("dataFreshnessSec" in h).toBe(false);
  });
});
