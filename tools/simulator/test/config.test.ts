import { describe, it, expect } from "vitest";
import { parseArgs, projectCores, PEAK_FACTOR } from "../src/config";
import { percentile, Stats } from "../src/stats";
import { parseDownlink, serialFromDownTopic, upTopic } from "../src/transports";

describe("parseArgs", () => {
  it("has sensible defaults", () => {
    const c = parseArgs([]);
    expect(c).toMatchObject({ mode: "run", devices: 100, rate: 10, transport: "http", duration: 60, api: "http://localhost:4000" });
    expect(c.mqttUrl).toBe("mqtt://localhost:1883");
    expect(c.udpPort).toBe(5684);
    expect(c.fromApi).toBe(true);
  });

  it("parses the documented flags (space and = forms)", () => {
    const c = parseArgs([
      "--devices", "500", "--rate=50", "--transport", "mqtt", "--duration", "0",
      "--api", "http://10.0.0.5:4000/api/v1", "--specs", "x/specs", "--no-api", "--quiet",
    ]);
    expect(c).toMatchObject({ devices: 500, rate: 50, transport: "mqtt", duration: 0, api: "http://10.0.0.5:4000", specs: "x/specs", fromApi: false, quiet: true });
    expect(c.mqttUrl).toBe("mqtt://10.0.0.5:1883");
    expect(c.udpHost).toBe("10.0.0.5");
  });

  it("rejects bad input", () => {
    expect(() => parseArgs(["--transport", "coap"])).toThrow(/mqtt\|http\|udp/);
    expect(() => parseArgs(["--rate", "fast"])).toThrow(/number/);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown option/);
  });
});

describe("projectCores", () => {
  it("projects cores for 1M devices and 1B msgs/day", () => {
    const [m, b] = projectCores(10_000);
    expect(m!.avgMsgPerSec).toBeCloseTo(3333.33, 1);
    expect(b!.avgMsgPerSec).toBeCloseTo(11574.07, 1);
    expect(b!.peakMsgPerSec).toBeCloseTo(11574.07 * PEAK_FACTOR, 1);
    // 57,870 / (10,000 × 0.6) = 9.6 → 10
    expect(b!.coresPeak).toBe(10);
    expect(m!.coresAvg).toBe(1);
  });
  it("rejects zero throughput", () => {
    expect(() => projectCores(0)).toThrow();
  });
});

describe("stats", () => {
  it("percentiles", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 99)).toBe(99);
    expect(percentile([], 50)).toBe(0);
  });
  it("windowed rate and summary", () => {
    const s = new Stats();
    for (let i = 1; i <= 10; i++) s.record(i);
    s.error(new Error("boom"));
    const w = s.tick(Date.now() + 1000);
    expect(w.p50).toBe(5);
    expect(s.summary().sent).toBe(10);
    expect(s.summary().errors).toBe(1);
    expect(s.lastError).toBe("boom");
  });
});

describe("mqtt helpers", () => {
  it("builds uplink topics and parses downlink topics", () => {
    expect(upTopic("GT200-1", 3)).toBe("dev/GT200-1/up/3");
    expect(upTopic("GT200-1")).toBe("dev/GT200-1/up");
    expect(serialFromDownTopic("dev/GT200-1/down")).toBe("GT200-1");
    expect(serialFromDownTopic("dev/GT200-1/up/1")).toBeUndefined();
  });
  it("parses JSON and binary downlinks", () => {
    expect(parseDownlink(Buffer.from(JSON.stringify({ id: "cmd_1", hex: "0A0B", port: 9 })))).toEqual({ commandId: "cmd_1", hex: "0a0b", port: 9 });
    expect(parseDownlink(Buffer.from([0x01, 0xff]))).toEqual({ hex: "01ff" });
  });
});
