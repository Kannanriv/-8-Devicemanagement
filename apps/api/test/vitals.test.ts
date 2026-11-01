import { describe, expect, it } from "vitest";
import { extractVitals, flattenData, expectedIntervalSec } from "../src/services/vitals";

describe("extractVitals", () => {
  it("reads battery percent and rssi", () => {
    expect(extractVitals({ battery: 76, rssi: -91 })).toEqual({ battery: 76, signal: -91 });
  });
  it("converts battery volts to percent and CSQ to dBm", () => {
    const v = extractVitals({ battery_v: 3.6, csq: 20 });
    expect(v.battery).toBe(50);
    expect(extractVitals({ battery: 3912 }).battery).toBe(76);
    expect(v.signal).toBe(-73);
  });
  it("finds nested values", () => {
    expect(extractVitals({ status: { batteryLevel: 12 }, radio: { signal_dbm: -100 } })).toEqual({ battery: 12, signal: -100 });
  });
  it("ignores non-numeric", () => {
    expect(extractVitals({ battery: "low" })).toEqual({});
  });
});

describe("flattenData", () => {
  it("flattens nested objects with dot paths and skips arrays", () => {
    expect(flattenData({ a: 1, b: { c: 2 }, d: [1, 2] })).toEqual({ a: 1, "b.c": 2, d: [1, 2] });
  });
});

describe("expectedIntervalSec", () => {
  it("defaults by category", () => {
    expect(expectedIntervalSec("tracker")).toBe(300);
    expect(expectedIntervalSec("unknown")).toBe(900);
  });
});
