import { describe, it, expect } from "vitest";
import { cronMatches, evaluateAutomation, OpsError } from "../src/index";
import type { Automation } from "@hash8/sdk-ts";
import { makeDevice, NOW } from "./fixtures";

const d = (iso: string) => new Date(iso);

describe("cronMatches (UTC)", () => {
  it.each([
    ["* * * * *", "2026-10-31T12:00:00Z", true],
    ["0 12 * * *", "2026-10-31T12:00:00Z", true],
    ["0 12 * * *", "2026-10-31T12:01:00Z", false],
    ["*/15 * * * *", "2026-10-31T12:45:00Z", true],
    ["*/15 * * * *", "2026-10-31T12:46:00Z", false],
    ["0 9-17 * * *", "2026-10-31T17:00:00Z", true],
    ["0 9-17 * * *", "2026-10-31T18:00:00Z", false],
    ["0 9-17/4 * * *", "2026-10-31T13:00:00Z", true],
    ["0 9-17/4 * * *", "2026-10-31T14:00:00Z", false],
    ["5,10,15 * * * *", "2026-10-31T00:10:00Z", true],
    ["0 0 1 * *", "2026-11-01T00:00:00Z", true],
    ["0 0 * 10 *", "2026-10-31T00:00:00Z", true],
    ["0 0 * * 6", "2026-10-31T00:00:00Z", true], // Saturday
    ["0 0 * * 0", "2026-11-01T00:00:00Z", true], // Sunday
    ["0 0 * * 7", "2026-11-01T00:00:00Z", true], // 7 = Sunday
    ["0 0 * * MON-FRI", "2026-11-02T00:00:00Z", true],
    ["0 0 * JAN *", "2026-10-31T00:00:00Z", false],
    // dom and dow both restricted: OR semantics
    ["0 0 13 * 5", "2026-11-13T00:00:00Z", true],
    ["0 0 13 * 5", "2026-11-06T00:00:00Z", true],
    ["0 0 13 * 5", "2026-11-07T00:00:00Z", false],
  ])("%s at %s → %s", (expr, at, out) => {
    expect(cronMatches(expr, d(at))).toBe(out);
  });
  it.each(["* * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "5-1 * * * *", "a b c d e"])("rejects %j", (expr) => {
    expect(() => cronMatches(expr, NOW)).toThrow(OpsError);
  });
});

const auto = (over: Partial<Automation>): Automation => ({
  id: "a-1", tenantId: "t-1", name: "hot", enabled: true,
  trigger: { type: "message" },
  actions: [{ type: "alert", severity: "warning", title: "Too hot" }],
  stats: { runs: 0, failures: 0 }, createdAt: "2026-01-01T00:00:00Z", ...over,
});
const device = makeDevice({}, { battery: 15 });

describe("evaluateAutomation", () => {
  it("matches message trigger with condition", () => {
    const a = auto({ condition: "data.temperature > 30 && device.health.battery < 20" });
    const r = evaluateAutomation(a, { type: "message", data: { temperature: 35 }, device }, NOW);
    expect(r).toEqual({ matched: true, actions: a.actions });
  });
  it("condition false → not matched, no actions", () => {
    const r = evaluateAutomation(auto({ condition: "data.temperature > 30" }), { type: "message", data: { temperature: 20 }, device }, NOW);
    expect(r).toEqual({ matched: false, actions: [] });
  });
  it("no condition → matched on trigger", () => {
    expect(evaluateAutomation(auto({}), { type: "message", data: {}, device }, NOW).matched).toBe(true);
  });
  it("disabled automations never match", () => {
    expect(evaluateAutomation(auto({ enabled: false }), { type: "message", data: {}, device }, NOW).matched).toBe(false);
  });
  it("filters on codecId and message name", () => {
    const a = auto({ trigger: { type: "message", codecId: "acme", message: "uplink" } });
    expect(evaluateAutomation(a, { type: "message", codecId: "acme", message: "uplink", data: {}, device }, NOW).matched).toBe(true);
    expect(evaluateAutomation(a, { type: "message", codecId: "other", message: "uplink", data: {}, device }, NOW).matched).toBe(false);
    expect(evaluateAutomation(a, { type: "message", codecId: "acme", message: "status", data: {}, device }, NOW).matched).toBe(false);
  });
  it("event type must match trigger type", () => {
    expect(evaluateAutomation(auto({}), { type: "offline", minutes: 99, device }, NOW).matched).toBe(false);
  });
  it("lifecycle trigger matches target state", () => {
    const a = auto({ trigger: { type: "lifecycle", to: "suspended" } });
    expect(evaluateAutomation(a, { type: "lifecycle", to: "suspended", device }, NOW).matched).toBe(true);
    expect(evaluateAutomation(a, { type: "lifecycle", to: "activated", device }, NOW).matched).toBe(false);
  });
  it("offline trigger matches when offline at least N minutes", () => {
    const a = auto({ trigger: { type: "offline", minutes: 30 }, condition: "minutes >= 30 && device.modelId == 'm-1'" });
    expect(evaluateAutomation(a, { type: "offline", minutes: 45, device }, NOW).matched).toBe(true);
    expect(evaluateAutomation(a, { type: "offline", minutes: 10, device }, NOW).matched).toBe(false);
  });
  it("schedule trigger uses cron", () => {
    const a = auto({ trigger: { type: "schedule", cron: "0 * * * *" } });
    expect(evaluateAutomation(a, { type: "schedule", at: d("2026-10-31T12:00:30Z") }, NOW).matched).toBe(true);
    expect(evaluateAutomation(a, { type: "schedule", at: d("2026-10-31T12:30:00Z") }, NOW).matched).toBe(false);
  });
  it("exposes now/time in scope", () => {
    const a = auto({ condition: "time.hour == 12 && time.weekday == 6" });
    expect(evaluateAutomation(a, { type: "message", data: {}, device }, NOW).matched).toBe(true);
  });
  it("returns error instead of throwing on bad condition", () => {
    const r = evaluateAutomation(auto({ condition: "data.x >" }), { type: "message", data: {}, device }, NOW);
    expect(r.matched).toBe(false);
    expect(r.actions).toEqual([]);
    expect(r.error).toMatch(/position/);
  });
  it("returns error on bad cron", () => {
    const r = evaluateAutomation(auto({ trigger: { type: "schedule", cron: "nope" } }), { type: "schedule", at: NOW }, NOW);
    expect(r.matched).toBe(false);
    expect(r.error).toBeDefined();
  });
  it("returns actions as copies", () => {
    const a = auto({});
    const r = evaluateAutomation(a, { type: "message", data: {}, device }, NOW);
    expect(r.actions).not.toBe(a.actions);
  });
  it("OpsError is exported for consumers", () => {
    expect(new OpsError("X", "y").code).toBe("X");
  });
});
