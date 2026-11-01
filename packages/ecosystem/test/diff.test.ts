import { describe, expect, it } from "vitest";
import type { DeviceCodecSpec, Field } from "@hash8/dcs-schema";
import { diffSpecs } from "../src";
import { acmeSpec, envioSpec, voltixSpec } from "./fixtures";

function field(spec: DeviceCodecSpec, msg: string, name: string): Field & Record<string, unknown> {
  const m = [...spec.uplink, ...(spec.downlink ?? [])].find((x) => x.name === msg)!;
  return m.fields.find((f) => f.name === name)! as Field & Record<string, unknown>;
}

describe("diffSpecs", () => {
  it("identical specs → patch with no changes", () => {
    const r = diffSpecs(envioSpec(), envioSpec());
    expect(r).toEqual({ breaking: false, changes: [], suggestedBump: "patch" });
  });

  it("description / unit / vector edits are patch-level", () => {
    const next = envioSpec();
    next.version = "1.1.1";
    field(next, "periodic", "battery").description = "Battery voltage (mV)";
    field(next, "periodic", "humidity").unit = "%RH";
    next.vectors = next.vectors.slice(1);
    const r = diffSpecs(envioSpec(), next);
    expect(r.breaking).toBe(false);
    expect(r.suggestedBump).toBe("patch");
    expect(r.changes).toContain("PATCH uplink periodic.humidity: unit % → %RH");
    expect(r.changes.some((c) => c.startsWith("PATCH uplink periodic.battery: description"))).toBe(true);
    expect(r.changes.some((c) => c.startsWith("PATCH vectors"))).toBe(true);
  });

  it("an added message, a trailing field and a new enum value are minor", () => {
    const prev = envioSpec();
    prev.uplink = prev.uplink.filter((m) => m.name !== "history");
    const next = envioSpec();
    (field(next, "config_ack", "command").enum as Record<string, string>)["3"] = "factory_reset";
    next.uplink.find((m) => m.name === "config_ack")!.fields.push({ kind: "scalar", name: "fw_build", type: "uint", bits: 8 });
    const r = diffSpecs(prev, next);
    expect(r.breaking).toBe(false);
    expect(r.suggestedBump).toBe("minor");
    expect(r.changes).toContain("MINOR uplink history: message added");
    expect(r.changes).toContain("MINOR uplink config_ack.command: enum value 3=factory_reset added");
    expect(r.changes).toContain("MINOR uplink config_ack.fw_build: field added (uint, 8 bits)");
  });

  it("removed message, removed field, retype, bits, endian, offset and when changes are breaking", () => {
    const next = envioSpec();
    next.downlink = next.downlink!.filter((m) => m.name !== "request_history");
    next.uplink.find((m) => m.name === "periodic")!.when = { port: 5 };
    field(next, "periodic", "temperature").type = "uint";
    field(next, "periodic", "battery").endian = "little";
    field(next, "config_ack", "interval").bits = 24;
    const ack = next.uplink.find((m) => m.name === "config_ack")!;
    ack.fields = ack.fields.filter((f) => f.name !== "result");
    const r = diffSpecs(envioSpec(), next);
    expect(r.breaking).toBe(true);
    expect(r.suggestedBump).toBe("major");
    expect(r.changes).toContain("BREAKING downlink request_history: message removed");
    expect(r.changes).toContain('BREAKING uplink periodic: when {"port":1} → {"port":5}');
    expect(r.changes).toContain("BREAKING uplink periodic.temperature: type int → uint");
    expect(r.changes).toContain("BREAKING uplink periodic.battery: endian big → little");
    expect(r.changes).toContain("BREAKING uplink config_ack.result: field removed");
    expect(r.changes).toContain("BREAKING uplink config_ack.interval: bits 16 → 24");
    // removing `result` shifts `interval` from bit 16 to bit 8
    expect(r.changes).toContain("BREAKING uplink config_ack.interval: offset bit 16 → bit 8");
  });

  it("walks into switch cases, groups and repeats", () => {
    const next = acmeSpec();
    const report = next.uplink[0]!;
    const sw = report.fields.find((f) => f.kind === "switch")!;
    if (sw.kind !== "switch") throw new Error("expected switch");
    const loc = sw.cases["0x01"]!;
    const speed = loc.find((f) => f.name === "speed")!;
    if (speed.kind === "scalar") speed.scale = 0.01;
    const prevV = voltixSpec();
    const nextV = voltixSpec();
    const phases = nextV.uplink[0]!.fields.find((f) => f.name === "phases")!;
    if (phases.kind === "repeat") phases.count = 2;
    const r1 = diffSpecs(acmeSpec(), next);
    expect(r1.changes).toContain("BREAKING uplink report.body[0x01].speed: scale 0.1 → 0.01");
    const r2 = diffSpecs(prevV, nextV);
    expect(r2.breaking).toBe(true);
    expect(r2.changes.some((c) => c.startsWith("BREAKING uplink realtime.phases: count"))).toBe(true);
  });

  it("removing an enum value is breaking", () => {
    const next = envioSpec();
    delete (field(next, "config_ack", "result").enum as Record<string, string>)["2"];
    const r = diffSpecs(envioSpec(), next);
    expect(r.breaking).toBe(true);
    expect(r.changes).toContain("BREAKING uplink config_ack.result: enum value 2=invalid_param removed");
  });
});
