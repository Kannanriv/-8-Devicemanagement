import { describe, it, expect } from "vitest";
import { decode, createCodec } from "../src";
import { mk, hex, u, i } from "./helpers";

function ok(spec: unknown, h: string, ctx?: { port?: number; topic?: string }) {
  const r = decode(spec, hex(h), ctx);
  if (!r.ok) throw new Error("decode failed: " + JSON.stringify(r.errors));
  return r;
}
function fail(spec: unknown, h: string, ctx?: { port?: number; topic?: string }) {
  const r = decode(spec, hex(h), ctx);
  if (r.ok) throw new Error("expected failure, got " + JSON.stringify(r.data));
  return r.errors.map((e) => e.code);
}

describe("integers & cursor", () => {
  it("uint8 default width", () => expect(ok(mk([{ name: "a", type: "uint" }]), "2a").data).toEqual({ a: 42 }));
  it("uint16 big-endian by default", () => expect(ok(mk([u("a", 16)]), "0102").data).toEqual({ a: 258 }));
  it("uint16 field-level little endian", () => expect(ok(mk([u("a", 16, { endian: "little" })]), "0102").data).toEqual({ a: 513 }));
  it("spec defaults.endian little applies", () =>
    expect(ok(mk([u("a", 32)], { defaults: { endian: "little" } }), "78563412").data).toEqual({ a: 0x12345678 }));
  it("field endian overrides default", () =>
    expect(ok(mk([u("a", 16, { endian: "big" })], { defaults: { endian: "little" } }), "0102").data).toEqual({ a: 258 }));
  it("MSB-first: 4-bit uints split 0xA5", () => expect(ok(mk([u("a", 4), u("b", 4)]), "a5").data).toEqual({ a: 10, b: 5 }));
  it("non-aligned field ignores little endian", () =>
    expect(ok(mk([u("a", 4), u("b", 12, { endian: "little" })]), "1234").data).toEqual({ a: 1, b: 0x234 }));
  it("bits crossing bytes", () => expect(ok(mk([u("a", 3), u("b", 10), u("c", 3)]), "b5a7").data).toEqual({ a: 5, b: 0b1010110100, c: 7 }));
  it("uint32 max is unsigned", () => expect(ok(mk([u("a", 32)]), "ffffffff").data).toEqual({ a: 4294967295 }));
  it("uint24 little", () => expect(ok(mk([u("a", 24, { endian: "little" })]), "010203").data).toEqual({ a: 0x030201 }));
  it("uint48 max", () => expect(ok(mk([u("a", 48)]), "ffffffffffff").data).toEqual({ a: 281474976710655 }));
  it("uint64 small stays number", () => expect(ok(mk([u("a", 64)]), "0000000000000001").data).toEqual({ a: 1 }));
  it("uint64 = 2^53 stays number", () => expect(ok(mk([u("a", 64)]), "0020000000000000").data).toEqual({ a: 9007199254740992 }));
  it("uint64 > 2^53 becomes decimal string", () =>
    expect(ok(mk([u("a", 64)]), "0020000000000001").data).toEqual({ a: "9007199254740993" }));
  it("uint64 max as string", () => expect(ok(mk([u("a", 64)]), "ffffffffffffffff").data).toEqual({ a: "18446744073709551615" }));
  it("uint64 little endian", () => expect(ok(mk([u("a", 64, { endian: "little" })]), "0100000000000000").data).toEqual({ a: 1 }));
  it("uint 56-bit unaligned", () =>
    expect(ok(mk([u("p", 4), u("a", 56), u("q", 4)]), "f00000000000001f").data).toEqual({ p: 15, a: 1, q: 15 }));
  it("int8 two's complement", () => expect(ok(mk([i("a", 8)]), "ff").data).toEqual({ a: -1 }));
  it("int16 min", () => expect(ok(mk([i("a", 16)]), "8000").data).toEqual({ a: -32768 }));
  it("int4 two's complement", () => expect(ok(mk([i("a", 4), i("b", 4)]), "f7").data).toEqual({ a: -1, b: 7 }));
  it("int24 little", () => expect(ok(mk([i("a", 24, { endian: "little" })]), "feffff").data).toEqual({ a: -2 }));
  it("int32 negative", () => expect(ok(mk([i("a", 32)]), "fffffc18").data).toEqual({ a: -1000 }));
  it("int64 -1", () => expect(ok(mk([i("a", 64)]), "ffffffffffffffff").data).toEqual({ a: -1 }));
  it("int64 min as string", () => expect(ok(mk([i("a", 64)]), "8000000000000000").data).toEqual({ a: "-9223372036854775808" }));
});

describe("other scalar types", () => {
  it("bool 1 bit default", () =>
    expect(ok(mk([{ name: "a", type: "bool" }, { name: "b", type: "bool" }, u("r", 6)]), "80").data).toEqual({ a: true, b: false, r: 0 }));
  it("bool wider than 1 bit", () => expect(ok(mk([{ name: "a", type: "bool", bits: 8 }]), "02").data).toEqual({ a: true }));
  it("bool ignores scale and enum", () =>
    expect(ok(mk([{ name: "a", type: "bool", bits: 8, scale: 10, enum: { "1": "x" } }]), "01").data).toEqual({ a: true }));
  it("float32 big", () => expect(ok(mk([{ name: "f", type: "float" }]), "41a40000").data).toEqual({ f: 20.5 }));
  it("float32 little", () => expect(ok(mk([{ name: "f", type: "float", endian: "little" }]), "0000a441").data).toEqual({ f: 20.5 }));
  it("float64", () => expect(ok(mk([{ name: "f", type: "float", bits: 64 }]), "400921fb54442d18").data).toEqual({ f: Math.PI }));
  it("float with scale", () => expect(ok(mk([{ name: "f", type: "float", scale: 2 }]), "41a40000").data).toEqual({ f: 41 }));
  it("bytes as lowercase hex", () => expect(ok(mk([{ name: "b", type: "bytes", length: 3 }]), "0AFF10").data).toEqual({ b: "0aff10" }));
  it("string strips trailing NULs", () => expect(ok(mk([{ name: "s", type: "string", length: 4 }]), "41420000").data).toEqual({ s: "AB" }));
  it("string utf-8", () => expect(ok(mk([{ name: "s", type: "string", length: 2 }]), "c3a9").data).toEqual({ s: "é" }));
  it("bcd drops F filler", () => expect(ok(mk([{ name: "imei", type: "bcd", length: 3 }]), "35123f").data).toEqual({ imei: "35123" }));
  it("bytes length remaining", () =>
    expect(ok(mk([u("a", 8), { name: "b", type: "bytes", length: "remaining" }]), "01aabbcc").data).toEqual({ a: 1, b: "aabbcc" }));
  it("remaining excludes trailing checksum", () =>
    expect(ok(mk([{ name: "s", type: "string", length: "remaining" }, { kind: "checksum", name: "x", algo: "xor8" }]), "414243" + "40").data).toEqual({ s: "ABC" }));
  it("remaining may be empty", () =>
    expect(ok(mk([u("a", 8), { name: "b", type: "bytes", length: "remaining" }]), "01").data).toEqual({ a: 1, b: "" }));
  it("float with bits 16 is an invalid spec", () => expect(() => createCodec(mk([{ name: "f", type: "float", bits: 16 }]))).toThrow());
  it("bytes without length is an invalid spec", () => expect(() => createCodec(mk([{ name: "b", type: "bytes" }]))).toThrow());
  it("invalid spec via decode wrapper yields INVALID_SPEC", () => {
    const r = decode({ nope: 1 }, hex("00"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("INVALID_SPEC");
  });
});

describe("semantics pipeline", () => {
  it("scale kills float noise", () => expect(ok(mk([i("t", 16, { scale: 0.1 })]), "00d5").data).toEqual({ t: 21.3 }));
  it("scale + offset", () => expect(ok(mk([u("t", 8, { scale: 0.5, offset: -40 })]), "64").data).toEqual({ t: 10 }));
  it("integer scale stays exact", () => expect(ok(mk([u("t", 8, { scale: 10 })]), "07").data).toEqual({ t: 70 }));
  it("decimals rounding", () => expect(ok(mk([u("v", 16, { scale: 0.001, decimals: 1 })]), "04d2").data).toEqual({ v: 1.2 }));
  it("decimals 0", () => expect(ok(mk([u("v", 16, { scale: 0.01, decimals: 0 })]), "04d2").data).toEqual({ v: 12 }));
  it("enum label and stop", () => expect(ok(mk([u("e", 8, { enum: { "2": "two" }, scale: 10 })]), "02").data).toEqual({ e: "two" }));
  it("unknown enum keeps raw with warning", () => {
    const r = ok(mk([u("e", 8, { enum: { "2": "two" }, scale: 10 })]), "05");
    expect(r.data).toEqual({ e: 5 });
    expect(r.warnings).toEqual(["e: unknown enum value 5"]);
  });
  it("min/max warning but still ok", () => {
    const r = ok(mk([u("v", 8, { min: 0, max: 100 })]), "c8");
    expect(r.data).toEqual({ v: 200 });
    expect(r.warnings).toEqual(["v: value 200 outside [0,100]"]);
  });
  it("in-range has no warnings", () => expect(ok(mk([u("v", 8, { min: 0, max: 100 })]), "32").warnings).toEqual([]));
  it("warning paths include group", () => {
    const r = ok(mk([{ kind: "group", name: "g", fields: [u("v", 8, { max: 1 })] }]), "05");
    expect(r.warnings).toEqual(["g.v: value 5 outside [-Infinity,1]"]);
  });
  it("warning paths include repeat index", () => {
    const r = ok(mk([{ kind: "repeat", name: "r", count: 2, fields: [u("v", 8, { max: 1 })] }]), "0105");
    expect(r.warnings).toEqual(["r[1].v: value 5 outside [-Infinity,1]"]);
  });
});

describe("output shape", () => {
  it("hidden, const and checksum are not emitted", () => {
    const spec = mk([
      { kind: "const", name: "magic", bits: 8, value: 0xa5 },
      u("a", 4),
      u("rsv", 4, { hidden: true }),
      { kind: "checksum", name: "cs", algo: "sum8" },
    ]);
    expect(ok(spec, "a5" + "30" + "d5").data).toEqual({ a: 3 });
  });
  it("const mismatch fails", () => expect(fail(mk([{ kind: "const", name: "m", bits: 8, value: 1 }]), "02")).toContain("CONST_MISMATCH"));
  it("group nests", () =>
    expect(ok(mk([{ kind: "group", name: "g", fields: [u("a", 8), u("b", 8)] }]), "0102").data).toEqual({ g: { a: 1, b: 2 } }));
  it("repeat fixed count", () =>
    expect(ok(mk([{ kind: "repeat", name: "r", count: 2, fields: [u("a", 8)] }]), "0102").data).toEqual({ r: [{ a: 1 }, { a: 2 }] }));
  it("repeat count from ref", () =>
    expect(ok(mk([u("n", 8), { kind: "repeat", name: "r", count: { ref: "n" }, fields: [u("a", 8)] }]), "020708").data).toEqual({
      n: 2,
      r: [{ a: 7 }, { a: 8 }],
    }));
  it("repeat ref to hidden field", () =>
    expect(ok(mk([u("n", 8, { hidden: true }), { kind: "repeat", name: "r", count: { ref: "n" }, fields: [u("a", 8)] }]), "0107").data).toEqual({
      r: [{ a: 7 }],
    }));
  it("repeat ref dot path from root", () =>
    expect(
      ok(mk([{ kind: "group", name: "h", fields: [u("count", 8)] }, { kind: "repeat", name: "r", count: { ref: "h.count" }, fields: [u("a", 8)] }]), "0109").data,
    ).toEqual({ h: { count: 1 }, r: [{ a: 9 }] }));
  it("ref resolves outward from nested scope", () =>
    expect(
      ok(mk([u("n", 8), { kind: "group", name: "g", fields: [{ kind: "repeat", name: "r", count: { ref: "n" }, fields: [u("a", 8)] }] }]), "0105").data,
    ).toEqual({ n: 1, g: { r: [{ a: 5 }] } }));
  it("ref prefers inner scope", () =>
    expect(
      ok(
        mk([u("n", 8), { kind: "repeat", name: "outer", count: 1, fields: [u("n", 8), { kind: "repeat", name: "r", count: { ref: "n" }, fields: [u("a", 8)] }] }]),
        "0501aa",
      ).data,
    ).toEqual({ n: 5, outer: [{ n: 1, r: [{ a: 0xaa }] }] }));
  it("bad repeat ref is BAD_REFERENCE", () =>
    expect(fail(mk([{ kind: "repeat", name: "r", count: { ref: "zz" }, fields: [u("a", 8)] }]), "01")).toContain("BAD_REFERENCE"));
  it("negative ref count is BAD_REFERENCE", () =>
    expect(fail(mk([i("n", 8), { kind: "repeat", name: "r", count: { ref: "n" }, fields: [u("a", 8)] }]), "ff")).toContain("BAD_REFERENCE"));
  it("repeat remaining", () =>
    expect(ok(mk([{ kind: "repeat", name: "r", count: "remaining", fields: [u("a", 8), u("b", 8)] }]), "01020304").data).toEqual({
      r: [{ a: 1, b: 2 }, { a: 3, b: 4 }],
    }));
  it("repeat remaining stops before trailing checksum", () =>
    expect(
      ok(mk([{ kind: "repeat", name: "r", count: "remaining", fields: [u("a", 8)] }, { kind: "checksum", name: "c", algo: "xor8" }]), "010203" + "00").data,
    ).toEqual({ r: [{ a: 1 }, { a: 2 }, { a: 3 }] }));
  it("repeat remaining with zero items", () =>
    expect(ok(mk([u("x", 8), { kind: "repeat", name: "r", count: "remaining", fields: [u("a", 8)] }]), "01").data).toEqual({ x: 1, r: [] }));
  it("repeat remaining partial item is PAYLOAD_TOO_SHORT", () =>
    expect(fail(mk([{ kind: "repeat", name: "r", count: "remaining", fields: [u("a", 16)] }]), "010203")).toContain("PAYLOAD_TOO_SHORT"));
});

describe("switch", () => {
  const sw = (cases: Record<string, unknown[]>, def?: unknown[]) =>
    mk([u("t", 8, { enum: { "1": "one", "16": "sixteen" } }), { kind: "switch", name: "body", on: "t", cases, ...(def ? { default: def } : {}) }]);
  it("merges case fields into current object", () => expect(ok(sw({ "1": [u("a", 8)] }), "0107").data).toEqual({ t: "one", a: 7 }));
  it("matches raw value not enum label, 0x keys", () =>
    expect(ok(sw({ "1": [u("a", 8)], "0x10": [u("b", 16)] }), "100102").data).toEqual({ t: "sixteen", b: 258 }));
  it("default case", () => expect(ok(sw({ "1": [u("a", 8)] }, [u("d", 8)]), "0309").data).toEqual({ t: 3, d: 9 }));
  it("no case and no default warns", () => {
    const r = ok(sw({ "1": [u("a", 8)] }), "03");
    expect(r.data).toEqual({ t: 3 });
    expect(r.warnings).toContain("body: no case for 3");
  });
  it("unresolvable on is BAD_REFERENCE", () =>
    expect(fail(mk([{ kind: "switch", name: "s", on: "missing", cases: { "1": [] } }]), "")).toContain("BAD_REFERENCE"));
  it("switch inside group sees outer field", () =>
    expect(ok(mk([u("t", 8), { kind: "group", name: "g", fields: [{ kind: "switch", name: "s", on: "t", cases: { "2": [u("x", 8)] } }] }]), "0204").data).toEqual({
      t: 2,
      g: { x: 4 },
    }));
  it("fields merged by switch are referenceable later", () =>
    expect(
      ok(
        mk([u("t", 8), { kind: "switch", name: "s", on: "t", cases: { "1": [u("n", 8)] } }, { kind: "repeat", name: "r", count: { ref: "n" }, fields: [u("v", 8)] }]),
        "010105",
      ).data,
    ).toEqual({ t: 1, n: 1, r: [{ v: 5 }] }));
});

describe("length & checksum errors", () => {
  it("PAYLOAD_TOO_SHORT", () => expect(fail(mk([u("a", 16)]), "01")).toContain("PAYLOAD_TOO_SHORT"));
  it("PAYLOAD_TOO_SHORT for bytes", () => expect(fail(mk([{ name: "b", type: "bytes", length: 4 }]), "0102")).toContain("PAYLOAD_TOO_SHORT"));
  it("TRAILING_BYTES", () => expect(fail(mk([u("a", 8)]), "0102")).toContain("TRAILING_BYTES"));
  it("trailing pad bits < 8 allowed", () => expect(ok(mk([u("a", 12)]), "abc0").data).toEqual({ a: 0xabc }));
  it("checksum mismatch", () => expect(fail(mk([u("a", 8), { kind: "checksum", name: "c", algo: "crc8" }]), "0100")).toContain("CHECKSUM_MISMATCH"));
  it("crc16 little-endian checksum validates", () => {
    const spec = mk([{ name: "s", type: "string", length: 9 }, { kind: "checksum", name: "c", algo: "crc16-ccitt", endian: "little" }]);
    expect(ok(spec, "313233343536373839b129").data).toEqual({ s: "123456789" });
  });
  it("crc32 big-endian checksum validates", () => {
    const spec = mk([{ name: "s", type: "string", length: 9 }, { kind: "checksum", name: "c", algo: "crc32" }]);
    expect(ok(spec, "313233343536373839cbf43926").data).toEqual({ s: "123456789" });
  });
  it("crc16-modbus checksum validates", () => {
    const spec = mk([{ name: "s", type: "string", length: 9 }, { kind: "checksum", name: "c", algo: "crc16-modbus", endian: "little" }]);
    expect(ok(spec, "313233343536373839374b").data).toEqual({ s: "123456789" });
  });
  it("errors carry a path", () => {
    const r = decode(mk([{ kind: "group", name: "g", fields: [u("a", 16)] }]), hex("01"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.find((e) => e.code === "PAYLOAD_TOO_SHORT")!.path).toBe("g.a");
  });
});

describe("message selection", () => {
  const spec = {
    ...mk([]),
    uplink: [
      { name: "p1", when: { port: 1 }, fields: [u("a", 8)] },
      { name: "p23", when: { port: [2, 3] }, fields: [u("b", 8)] },
      { name: "tele", when: { topic: "dev/+/telemetry" }, fields: [{ kind: "const", name: "k", bits: 8, value: 1 }, u("c", 8)] },
      { name: "tele2", when: { topic: "dev/#" }, fields: [{ kind: "const", name: "k", bits: 8, value: 2 }, u("d", 8)] },
    ],
  };
  it("selects by port", () => expect(ok(spec, "05", { port: 1 }).message).toBe("p1"));
  it("selects by port list", () => expect(ok(spec, "05", { port: 3 })).toMatchObject({ message: "p23", data: { b: 5 } }));
  it("selects by topic with + wildcard", () => expect(ok(spec, "0109", { topic: "dev/abc/telemetry" })).toMatchObject({ message: "tele", data: { c: 9 } }));
  it("falls through on const mismatch to # wildcard", () =>
    expect(ok(spec, "0209", { topic: "dev/abc/telemetry" })).toMatchObject({ message: "tele2", data: { d: 9 } }));
  it("# matches the parent level", () => expect(ok(spec, "0209", { topic: "dev" }).message).toBe("tele2"));
  it("+ does not match multiple levels", () => {
    const r = decode(spec, hex("0109"), { topic: "dev/a/b/telemetry" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.message.startsWith("tele:"))).toBe(false);
      expect(r.errors.some((e) => e.message.startsWith("tele2:"))).toBe(true);
    }
  });
  it("no ctx: first decodable in declaration order", () => expect(ok(spec, "07").message).toBe("p1"));
  it("NO_MATCHING_MESSAGE lists prefixed candidate errors", () => {
    const r = decode(spec, hex("0303"), { topic: "dev/x/telemetry" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]!.code).toBe("NO_MATCHING_MESSAGE");
      expect(r.errors.some((e) => e.code === "CONST_MISMATCH" && e.message.startsWith("tele:"))).toBe(true);
      expect(r.errors.some((e) => e.code === "CONST_MISMATCH" && e.message.startsWith("tele2:"))).toBe(true);
    }
  });
  it("no candidates for port and topic", () => {
    const r = decode(spec, hex("01"), { port: 99, topic: "zzz" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("NO_MATCHING_MESSAGE");
  });
  it("codec instance decodes", () => {
    const c = createCodec(spec);
    expect(c.spec.id).toBe("test.dev");
    expect(c.decode(hex("05"), { port: 2 })).toMatchObject({ ok: true, message: "p23" });
  });
});
