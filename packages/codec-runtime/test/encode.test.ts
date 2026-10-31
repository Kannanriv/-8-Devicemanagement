import { describe, it, expect } from "vitest";
import { encode, decode } from "../src";
import { mk, hex, toHex, u, i } from "./helpers";

function enc(spec: unknown, data: Record<string, unknown>, message = "m") {
  const r = encode(spec, message, data);
  if (!r.ok) throw new Error("encode failed: " + JSON.stringify(r.errors));
  return toHex(r.bytes);
}
function encErr(spec: unknown, data: Record<string, unknown>, message = "m") {
  const r = encode(spec, message, data);
  if (r.ok) throw new Error("expected failure, got " + toHex(r.bytes));
  return r.errors;
}

describe("encode scalars", () => {
  it("uint big endian", () => expect(enc(mk([u("a", 16)]), { a: 258 })).toBe("0102"));
  it("uint little endian default", () => expect(enc(mk([u("a", 32)], { defaults: { endian: "little" } }), { a: 0x12345678 })).toBe("78563412"));
  it("negative int two's complement", () => expect(enc(mk([i("a", 16)]), { a: -2 })).toBe("fffe"));
  it("bit-packed fields MSB-first", () => expect(enc(mk([u("a", 4), i("b", 4)]), { a: 10, b: -1 })).toBe("af"));
  it("pads final partial byte with zero bits", () => expect(enc(mk([u("a", 12)]), { a: 0xabc })).toBe("abc0"));
  it("bool", () => expect(enc(mk([{ name: "a", type: "bool" }, { name: "b", type: "bool" }, u("r", 6)]), { a: true, b: false, r: 1 })).toBe("81"));
  it("float32 / float64", () => {
    expect(enc(mk([{ name: "f", type: "float" }]), { f: 20.5 })).toBe("41a40000");
    expect(enc(mk([{ name: "f", type: "float", bits: 64, endian: "little" }]), { f: Math.PI })).toBe("182d4454fb210940");
  });
  it("scale inverse with rounding", () => expect(enc(mk([i("t", 16, { scale: 0.1 })]), { t: 21.3 })).toBe("00d5"));
  it("scale + offset inverse", () => expect(enc(mk([u("t", 8, { scale: 0.5, offset: -40 })]), { t: 10 })).toBe("64"));
  it("enum label to raw", () => expect(enc(mk([u("e", 8, { enum: { "0": "off", "1": "on" } })]), { e: "on" })).toBe("01"));
  it("enum field accepts unknown numeric raw", () => expect(enc(mk([u("e", 8, { enum: { "0": "off" }, scale: 10 })]), { e: 5 })).toBe("05"));
  it("unknown enum label is out of range", () =>
    expect(encErr(mk([u("e", 8, { enum: { "0": "off" } })]), { e: "nope" })[0]!.code).toBe("ENCODE_OUT_OF_RANGE"));
  it("uint64 from decimal string", () => expect(enc(mk([u("a", 64)]), { a: "18446744073709551615" })).toBe("ffffffffffffffff"));
  it("int64 negative string", () => expect(enc(mk([i("a", 64)]), { a: "-9223372036854775808" })).toBe("8000000000000000"));
  it("uint64 little from number", () => expect(enc(mk([u("a", 64, { endian: "little" })]), { a: 258 })).toBe("0201000000000000"));
  it("bytes hex", () => expect(enc(mk([{ name: "b", type: "bytes", length: 3 }]), { b: "0AFF10" })).toBe("0aff10"));
  it("bytes wrong length is out of range", () =>
    expect(encErr(mk([{ name: "b", type: "bytes", length: 3 }]), { b: "0a" })[0]!.code).toBe("ENCODE_OUT_OF_RANGE"));
  it("string padded with NULs", () => expect(enc(mk([{ name: "s", type: "string", length: 4 }]), { s: "AB" })).toBe("41420000"));
  it("string too long is out of range", () =>
    expect(encErr(mk([{ name: "s", type: "string", length: 1 }]), { s: "AB" })[0]!.code).toBe("ENCODE_OUT_OF_RANGE"));
  it("bcd padded with F", () => expect(enc(mk([{ name: "n", type: "bcd", length: 3 }]), { n: "35123" })).toBe("35123f"));
  it("remaining-length bytes and string", () =>
    expect(enc(mk([u("a", 8), { name: "s", type: "string", length: "remaining" }]), { a: 1, s: "hi" })).toBe("016869"));
});

describe("encode defaults, errors, ranges", () => {
  it("default used when missing", () => expect(enc(mk([u("a", 8, { default: 7 }), u("b", 8)]), { b: 1 })).toBe("0701"));
  it("default label for enum", () => expect(enc(mk([u("a", 8, { enum: { "3": "x" }, default: "x" })]), {})).toBe("03"));
  it("hidden missing -> 0", () => expect(enc(mk([u("a", 4), u("rsv", 4, { hidden: true })]), { a: 15 })).toBe("f0"));
  it("missing field -> ENCODE_MISSING_FIELD with path", () => {
    const e = encErr(mk([{ kind: "group", name: "g", fields: [u("a", 8)] }]), {});
    expect(e[0]).toMatchObject({ code: "ENCODE_MISSING_FIELD", path: "g.a" });
  });
  it("uint8 256 out of range", () => expect(encErr(mk([u("a", 8)]), { a: 256 })[0]!.code).toBe("ENCODE_OUT_OF_RANGE"));
  it("uint negative out of range", () => expect(encErr(mk([u("a", 8)]), { a: -1 })[0]!.code).toBe("ENCODE_OUT_OF_RANGE"));
  it("int8 -129 out of range", () => expect(encErr(mk([i("a", 8)]), { a: -129 })[0]!.code).toBe("ENCODE_OUT_OF_RANGE"));
  it("int8 128 out of range", () => expect(encErr(mk([i("a", 8)]), { a: 128 })[0]!.code).toBe("ENCODE_OUT_OF_RANGE"));
  it("scaled value out of range", () => expect(encErr(mk([u("a", 8, { scale: 0.1 })]), { a: 25.6 })[0]!.code).toBe("ENCODE_OUT_OF_RANGE"));
  it("uint64 too large out of range", () =>
    expect(encErr(mk([u("a", 64)]), { a: "18446744073709551616" })[0]!.code).toBe("ENCODE_OUT_OF_RANGE"));
  it("non-numeric value out of range", () => expect(encErr(mk([u("a", 8)]), { a: "abc" })[0]!.code).toBe("ENCODE_OUT_OF_RANGE"));
  it("collects multiple errors", () => expect(encErr(mk([u("a", 8), u("b", 8)]), {}).length).toBe(2));
  it("unknown message", () => expect(encErr(mk([u("a", 8)]), {}, "nope")[0]!.code).toBe("NO_MATCHING_MESSAGE"));
});

describe("encode structure", () => {
  it("const and checksum", () =>
    expect(enc(mk([{ kind: "const", name: "m", bits: 8, value: 0xa5 }, u("a", 8), { kind: "checksum", name: "c", algo: "sum8" }]), { a: 0x30 })).toBe("a530d5"));
  it("crc16-ccitt checksum little endian", () =>
    expect(enc(mk([{ name: "s", type: "string", length: 9 }, { kind: "checksum", name: "c", algo: "crc16-ccitt", endian: "little" }]), { s: "123456789" })).toBe(
      "313233343536373839b129",
    ));
  it("group", () => expect(enc(mk([{ kind: "group", name: "g", fields: [u("a", 8), u("b", 8)] }]), { g: { a: 1, b: 2 } })).toBe("0102"));
  it("repeat fixed", () => expect(enc(mk([{ kind: "repeat", name: "r", count: 2, fields: [u("a", 8)] }]), { r: [{ a: 1 }, { a: 2 }] })).toBe("0102"));
  it("repeat fixed count mismatch", () =>
    expect(encErr(mk([{ kind: "repeat", name: "r", count: 2, fields: [u("a", 8)] }]), { r: [{ a: 1 }] })[0]!.code).toBe("ENCODE_OUT_OF_RANGE"));
  it("repeat ref count auto-set when omitted", () =>
    expect(enc(mk([u("n", 8), { kind: "repeat", name: "r", count: { ref: "n" }, fields: [u("a", 8)] }]), { r: [{ a: 7 }, { a: 8 }] })).toBe("020708"));
  it("repeat ref count auto-set for hidden count", () =>
    expect(enc(mk([u("n", 8, { hidden: true }), { kind: "repeat", name: "r", count: { ref: "n" }, fields: [u("a", 8)] }]), { r: [{ a: 7 }] })).toBe("0107"));
  it("repeat ref count auto-set via dot path", () =>
    expect(
      enc(mk([{ kind: "group", name: "h", fields: [u("count", 8)] }, { kind: "repeat", name: "r", count: { ref: "h.count" }, fields: [u("a", 8)] }]), {
        h: {},
        r: [{ a: 9 }],
      }),
    ).toBe("0109"));
  it("repeat remaining", () =>
    expect(enc(mk([{ kind: "repeat", name: "r", count: "remaining", fields: [u("a", 8)] }]), { r: [{ a: 1 }, { a: 2 }, { a: 3 }] })).toBe("010203"));
  it("missing repeat array", () =>
    expect(encErr(mk([{ kind: "repeat", name: "r", count: "remaining", fields: [u("a", 8)] }]), {})[0]!.code).toBe("ENCODE_MISSING_FIELD"));
  it("switch case chosen by raw value of enum field", () => {
    const spec = mk([u("t", 8, { enum: { "1": "one", "2": "two" } }), { kind: "switch", name: "s", on: "t", cases: { "1": [u("a", 8)], "0x02": [u("b", 16)] } }]);
    expect(enc(spec, { t: "two", b: 258 })).toBe("020102");
    expect(enc(spec, { t: "one", a: 9 })).toBe("0109");
  });
  it("switch default case", () =>
    expect(enc(mk([u("t", 8), { kind: "switch", name: "s", on: "t", cases: { "1": [u("a", 8)] }, default: [u("d", 8)] }]), { t: 5, d: 6 })).toBe("0506"));
  it("port from when", () => {
    const spec = { ...mk([u("a", 8)]), downlink: [{ name: "cmd", when: { port: [10, 11] }, fields: [u("x", 8)] }] };
    const r = encode(spec, "cmd", { x: 1 });
    expect(r.ok && r.port).toBe(10);
  });
  it("downlink takes precedence over uplink of the same name", () => {
    const spec = { ...mk([u("a", 8)]), downlink: [{ name: "m", fields: [u("a", 16)] }] };
    expect(enc(spec, { a: 1 })).toBe("0001");
  });
  it("can encode uplink messages for simulators", () => expect(enc(mk([u("a", 8)]), { a: 3 })).toBe("03"));
});

describe("round-trip law", () => {
  const spec = mk([
    { kind: "const", name: "magic", bits: 8, value: 0x7e },
    u("type", 8, { enum: { "1": "a", "2": "b" } }),
    { kind: "group", name: "flags", fields: [{ name: "x", type: "bool" }, u("lvl", 3), u("rsv", 4, { hidden: true })] },
    { kind: "switch", name: "body", on: "type", cases: {
      "1": [i("temp", 16, { scale: 0.01 }), u("hum", 8, { scale: 0.5 })],
      "2": [u("n", 8), { kind: "repeat", name: "items", count: { ref: "n" }, fields: [i("v", 24, { endian: "little" }), { name: "f", type: "float" }] }],
    } },
    { kind: "checksum", name: "crc", algo: "crc32" },
  ]);
  for (const data of [
    { type: "a", flags: { x: true, lvl: 5 }, temp: -12.34, hum: 55.5 },
    { type: "b", flags: { x: false, lvl: 0 }, n: 2, items: [{ v: -5, f: 1.5 }, { v: 70000, f: -0.25 }] },
  ]) {
    it(`encode -> decode -> encode is identity (${data.type})`, () => {
      const h = enc(spec, data);
      const d = decode(spec, hex(h));
      expect(d.ok).toBe(true);
      if (d.ok) {
        expect(d.data).toEqual(data);
        expect(enc(spec, d.data)).toBe(h);
      }
    });
  }
});
