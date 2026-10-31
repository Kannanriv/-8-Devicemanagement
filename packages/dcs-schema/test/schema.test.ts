import { describe, it, expect } from "vitest";
import { safeParseSpec, fromHex, toHex } from "../src";

describe("DCS schema", () => {
  it("accepts a minimal spec and defaults scalar kind + endian", () => {
    const r = safeParseSpec({
      dcs: "1.0", id: "acme.th1", version: "1.0.0",
      device: { vendor: "Acme", model: "TH1" },
      uplink: [{ name: "status", when: { port: 1 }, fields: [
        { name: "temperature", type: "int", bits: 16, scale: 0.1, unit: "Cel" },
        { kind: "repeat", name: "rows", count: 2, fields: [{ name: "v", type: "uint" }] },
      ] }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.defaults.endian).toBe("big");
      expect(r.data.uplink[0]!.fields[0]!.kind).toBe("scalar");
    }
  });
  it("rejects bad ids and versions", () => {
    expect(safeParseSpec({ dcs: "1.0", id: "Bad Id", version: "1", device: { vendor: "a", model: "b" }, uplink: [] }).success).toBe(false);
  });
  it("round-trips hex", () => {
    expect(toHex(fromHex("0A ff:10"))).toBe("0aff10");
    expect(() => fromHex("abc")).toThrow();
  });
});
