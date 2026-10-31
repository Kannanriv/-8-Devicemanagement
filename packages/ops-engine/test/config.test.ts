import { describe, it, expect } from "vitest";
import { diffConfig, applyTemplate, buildDeviceConfig } from "../src/index";
import type { ConfigTemplate } from "@hash8/sdk-ts";
import { NOW } from "./fixtures";

describe("diffConfig", () => {
  it("returns empty for equal configs", () => {
    expect(diffConfig({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } })).toEqual([]);
  });
  it("reports differing leaves with dot paths", () => {
    expect(diffConfig({ a: 1, net: { apn: "x", port: 5 } }, { a: 1, net: { apn: "y", port: 5 } })).toEqual(["net.apn"]);
  });
  it("reports desired keys missing from reported", () => {
    expect(diffConfig({ a: 1, b: { c: 2 } }, {})).toEqual(["a", "b.c"]);
  });
  it("ignores extra reported-only keys", () => {
    expect(diffConfig({ a: 1 }, { a: 1, firmware: "1.0" })).toEqual([]);
  });
  it("compares arrays as whole values", () => {
    expect(diffConfig({ ch: [1, 2, 3] }, { ch: [1, 2] })).toEqual(["ch"]);
    expect(diffConfig({ ch: [{ a: 1 }] }, { ch: [{ a: 1 }] })).toEqual([]);
  });
  it("reports type mismatch at the object path", () => {
    expect(diffConfig({ net: { apn: "x" } }, { net: 5 })).toEqual(["net"]);
  });
  it("treats 1 and '1' as different and returns sorted paths", () => {
    expect(diffConfig({ z: 1, a: 1 }, { z: "1", a: 2 })).toEqual(["a", "z"]);
  });
});

describe("applyTemplate", () => {
  const tpl: ConfigTemplate = {
    id: "tpl-1", tenantId: "t", modelId: "m", name: "default", version: 3,
    values: { interval: 60, net: { apn: "iot", port: 5683 }, channels: [1, 2] },
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  it("returns a deep copy of template values with no overrides", () => {
    const v = applyTemplate(tpl);
    expect(v).toEqual(tpl.values);
    (v.net as Record<string, unknown>).apn = "mutated";
    expect((tpl.values.net as Record<string, unknown>).apn).toBe("iot");
  });
  it("deep merges overrides; arrays replaced", () => {
    expect(applyTemplate(tpl, { net: { port: 1 }, channels: [9] })).toEqual({ interval: 60, net: { apn: "iot", port: 1 }, channels: [9] });
  });
  it("ignores prototype-pollution keys", () => {
    const v = applyTemplate(tpl, JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(v)).not.toContain("__proto__");
  });
});

describe("buildDeviceConfig", () => {
  it("assembles DeviceConfig with drift", () => {
    expect(buildDeviceConfig("dev-1", { a: 1, b: 2 }, { a: 1, b: 3 }, NOW)).toEqual({
      deviceId: "dev-1", desired: { a: 1, b: 2 }, reported: { a: 1, b: 3 }, drift: ["b"], updatedAt: NOW.toISOString(),
    });
  });
});
