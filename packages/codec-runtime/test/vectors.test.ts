import { describe, it, expect } from "vitest";
import { runVectors, describeSpec } from "../src";
import { mk, u } from "./helpers";

describe("runVectors", () => {
  const base = mk([u("a", 8), u("t", 16, { scale: 0.1 })], {
    downlink: [{ name: "cmd", when: { port: 10 }, fields: [u("x", 8)] }],
  });

  it("passes matching uplink and downlink vectors", () => {
    const r = runVectors({
      ...base,
      vectors: [
        { name: "up", hex: "01 00D5", message: "m", data: { a: 1, t: 21.3 } },
        { name: "down", direction: "downlink", hex: "05", message: "cmd", data: { x: 5 } },
      ],
    });
    expect(r.map((v) => v.pass)).toEqual([true, true]);
  });
  it("numbers compared with 1e-9 tolerance", () => {
    const r = runVectors({ ...base, vectors: [{ name: "up", hex: "0100d5", data: { a: 1, t: 21.3 + 1e-11 } }] });
    expect(r[0]!.pass).toBe(true);
  });
  it("reports data diffs", () => {
    const r = runVectors({ ...base, vectors: [{ name: "up", hex: "0100d5", data: { a: 2, t: 21.3 } }] });
    expect(r[0]!.pass).toBe(false);
    expect(r[0]!.diff!.some((d) => d.includes("a"))).toBe(true);
    expect(r[0]!.actual).toEqual({ a: 1, t: 21.3 });
  });
  it("reports missing and extra keys", () => {
    const r = runVectors({ ...base, vectors: [{ name: "up", hex: "0100d5", data: { a: 1, z: 1 } }] });
    expect(r[0]!.pass).toBe(false);
    expect(r[0]!.diff!.length).toBeGreaterThanOrEqual(2);
  });
  it("message mismatch fails", () => {
    const r = runVectors({ ...base, vectors: [{ name: "up", hex: "0100d5", message: "other", data: { a: 1, t: 21.3 } }] });
    expect(r[0]!.pass).toBe(false);
  });
  it("decode failure fails with error diff", () => {
    const r = runVectors({ ...base, vectors: [{ name: "up", hex: "01", data: {} }] });
    expect(r[0]!.pass).toBe(false);
    expect(r[0]!.diff!.join(" ")).toContain("PAYLOAD_TOO_SHORT");
  });
  it("round-trip failure reported as separate diff entry", () => {
    // hidden reserved bits non-zero: decode drops them, encode writes zeros
    const spec = mk([u("rsv", 4, { hidden: true }), u("b", 4)], { vectors: [{ name: "rt", hex: "ff", data: { b: 15 } }] });
    const r = runVectors(spec);
    expect(r[0]!.pass).toBe(false);
    expect(r[0]!.diff!.some((d) => d.startsWith("round-trip"))).toBe(true);
  });
  it("downlink mismatch fails", () => {
    const r = runVectors({ ...base, vectors: [{ name: "down", direction: "downlink", hex: "06", message: "cmd", data: { x: 5 } }] });
    expect(r[0]!.pass).toBe(false);
    expect(r[0]!.actual).toBe("05");
  });
  it("downlink without message fails", () => {
    const r = runVectors({ ...base, vectors: [{ name: "down", direction: "downlink", hex: "05", data: { x: 5 } }] });
    expect(r[0]!.pass).toBe(false);
  });
  it("downlink port mismatch fails", () => {
    const r = runVectors({ ...base, vectors: [{ name: "down", direction: "downlink", port: 3, hex: "05", message: "cmd", data: { x: 5 } }] });
    expect(r[0]!.pass).toBe(false);
  });
  it("invalid hex fails gracefully", () => {
    const r = runVectors({ ...base, vectors: [{ name: "bad", hex: "zz", data: {} }] });
    expect(r[0]!.pass).toBe(false);
  });
});

describe("describeSpec", () => {
  it("flattens fields with paths", () => {
    const d = describeSpec(
      mk(
        [
          { kind: "const", name: "magic", bits: 8, value: 1 },
          u("type", 8, { description: "msg type" }),
          { kind: "group", name: "g", fields: [{ name: "on", type: "bool" }, u("rsv", 7, { hidden: true })] },
          { kind: "repeat", name: "r", count: 2, fields: [u("v", 16, { unit: "V" })] },
          { kind: "switch", name: "s", on: "type", cases: { "1": [{ name: "f", type: "float" }], "2": [{ name: "b", type: "bytes", length: 3 }] } },
          { kind: "checksum", name: "c", algo: "xor8" },
        ],
        { downlink: [{ name: "cmd", when: { port: [5, 6] }, fields: [u("x", 8)] }] },
      ),
    );
    expect(d.messages).toHaveLength(2);
    expect(d.messages[0]).toMatchObject({ name: "m", direction: "uplink" });
    expect(d.messages[0]!.fields).toEqual([
      { path: "type", type: "uint", bits: 8, description: "msg type" },
      { path: "g.on", type: "bool", bits: 1 },
      { path: "r[].v", type: "uint", bits: 16, unit: "V" },
      { path: "f", type: "float", bits: 32 },
      { path: "b", type: "bytes", bits: 24 },
    ]);
    expect(d.messages[1]).toMatchObject({ name: "cmd", direction: "downlink", port: 5 });
    expect(d.fieldCount).toBe(6);
  });
});
