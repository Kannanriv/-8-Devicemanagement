import { describe, it, expect, beforeAll } from "vitest";
import { parseSpec, type DeviceCodecSpec } from "@hash8/dcs-schema";
import { loadSpecs, loadFixture, diff } from "./helpers";
import { tsAdapter, ts013Adapter, pythonAdapter, javaAdapter, hasJava, type Adapter, type Op } from "./adapters";

const specs = loadSpecs();
const targets: { name: string; make: (s: DeviceCodecSpec) => Adapter | Promise<Adapter>; hasMessage: boolean }[] = [
  { name: "ts", make: tsAdapter, hasMessage: true },
  { name: "ts013", make: ts013Adapter, hasMessage: false },
  { name: "python", make: pythonAdapter, hasMessage: true },
  // Java runs when a JDK is available (JAVA_HOME or Android Studio's bundled JBR); CI always has one.
  ...(hasJava ? [{ name: "java", make: javaAdapter, hasMessage: true }] : []),
];

describe.each(targets)("$name plugin — vector conformance", ({ make, hasMessage }) => {
  describe.each(specs)("$name", ({ spec }) => {
    it("passes every vector and the round-trip law", async () => {
      const codec = await make(spec);
      const ops: Op[] = [];
      for (const v of spec.vectors) {
        if (v.direction === "downlink") ops.push({ op: "encode", message: v.message, data: v.data });
        else ops.push({ op: "decode", hex: v.hex, port: v.port, topic: v.topic });
      }
      const res = await codec.run(ops);
      // round-trip: encode(msg, decode(hex).data) == hex
      const rt: Op[] = [];
      const rtIdx: number[] = [];
      spec.vectors.forEach((v, i) => {
        const r = res[i]!;
        if (v.direction !== "downlink" && r.ok) {
          const msg = r.message ?? v.message;
          if (msg) { rt.push({ op: "encode", message: msg, data: r.data as any }); rtIdx.push(i); }
        }
      });
      const rtRes = await codec.run(rt);
      const failures: string[] = [];
      spec.vectors.forEach((v, i) => {
        const r = res[i]!;
        const want = v.hex.replace(/[\s:-]/g, "").toLowerCase();
        if (!r.ok) { failures.push(`${v.name}: failed ${r.codes?.join(",")}`); return; }
        if (v.direction === "downlink") {
          if (r.hex !== want) failures.push(`${v.name}: encoded ${r.hex} != ${want}`);
          return;
        }
        if (hasMessage && v.message && r.message !== v.message) failures.push(`${v.name}: message ${r.message} != ${v.message}`);
        for (const d of diff(v.data, r.data)) failures.push(`${v.name}: ${d}`);
        const k = rtIdx.indexOf(i);
        if (k >= 0) {
          const e = rtRes[k]!;
          if (!e.ok || e.hex !== want) failures.push(`${v.name}: round-trip ${e.ok ? e.hex : e.codes?.join(",")} != ${want}`);
        }
      });
      expect(failures).toEqual([]);
    });
  });
});

const badref = parseSpec({
  dcs: "1.0", id: "test.badref", version: "1.0.0", device: { vendor: "T", model: "B" },
  uplink: [{ name: "m", fields: [{ name: "x", type: "uint" }, { kind: "repeat", name: "r", count: { ref: "nope" }, fields: [{ name: "y", type: "uint" }] }] }],
});

describe.each(targets)("$name plugin — behaviour", ({ make, hasMessage }) => {
  let tracker: Adapter, meter: Adapter, bits: Adapter, bad: Adapter;
  beforeAll(async () => {
    tracker = await make(loadFixture("tracker.json"));
    meter = await make(loadFixture("meter.json"));
    bits = await make(loadFixture("bits.json"));
    bad = await make(badref);
  });

  it("reports decode error codes", async () => {
    const [short, crc, magic, trailing, noport] = await tracker.run([
      { op: "decode", hex: "a5381f3351", port: 1 },
      { op: "decode", hex: "a5381f335115ffed29794b01c7e5", port: 1 },
      { op: "decode", hex: "a4381f335115ffed29794b01c7e4", port: 1 },
      { op: "decode", hex: "313233343536373839f400", port: 9 },
      { op: "decode", hex: "00", port: 5 },
    ]);
    expect(short!.codes).toEqual(["NO_MATCHING_MESSAGE", "PAYLOAD_TOO_SHORT"]);
    expect(crc!.codes).toEqual(["NO_MATCHING_MESSAGE", "CHECKSUM_MISMATCH"]);
    expect(magic!.codes).toEqual(["NO_MATCHING_MESSAGE", "CONST_MISMATCH"]);
    expect(trailing!.codes).toEqual(["NO_MATCHING_MESSAGE", "TRAILING_BYTES"]);
    expect(noport!.codes).toEqual(["NO_MATCHING_MESSAGE"]);
    const [badr] = await bad.run([{ op: "decode", hex: "0101" }]);
    expect(badr!.codes).toEqual(["NO_MATCHING_MESSAGE", "BAD_REFERENCE"]);
  });

  it("emits warnings for range, unknown enum and missing switch case", async () => {
    const [range, nocase, topicMiss] = await bits.run([
      { op: "decode", hex: "28ff10ffffffffffffffffffffffffffffffff123456789abcb5", topic: "devices/abc/up" },
      { op: "decode", hex: "01034007", topic: "devices/x" },
      { op: "decode", hex: "01034007", topic: "other/x" },
    ]);
    expect(range!.warnings).toEqual(["hum: value 120 outside [-Infinity,100]"]);
    expect(nocase!.ok).toBe(true);
    expect(nocase!.data).toEqual({ header: { n: 1, kind: "multi" }, items: [{ tag: 64 }], last: 3.5 });
    expect(nocase!.warnings).toEqual(["items[0].payload: no case for 64"]);
    if (hasMessage) expect(topicMiss!.codes).toEqual(["NO_MATCHING_MESSAGE"]); // TS013 has no topic
    const [unk] = await tracker.run([{ op: "decode", hex: "a5381f335115ffed29794b07a722", port: 1 }]);
    expect(unk!.warnings).toEqual(["status: unknown enum value 7"]);
  });

  it("encodes downlinks with port, defaults and range errors", async () => {
    const [ok, missing, badEnum, range] = await tracker.run([
      { op: "encode", message: "setMode", data: { mode: "eco", interval: 120 } },
      { op: "encode", message: "setMode", data: { mode: "eco" } },
      { op: "encode", message: "setMode", data: { mode: "turbo", interval: 60 } },
      { op: "encode", message: "setMode", data: { mode: "eco", interval: 60 * 70000 } },
    ]);
    expect(ok!.ok).toBe(true);
    expect(ok!.hex!.slice(0, 8)).toBe("01010002");
    expect(ok!.port).toBe(20);
    expect(missing!.codes).toEqual(["ENCODE_MISSING_FIELD"]);
    expect(badEnum!.codes).toEqual(["ENCODE_OUT_OF_RANGE"]);
    expect(range!.codes).toEqual(["ENCODE_OUT_OF_RANGE"]);
    const [iv, reboot, unknown] = await meter.run([
      { op: "encode", message: "setInterval", data: { minutes: 2, flags: 0 } },
      { op: "encode", message: "reboot", data: { delay: 256 } },
      { op: "encode", message: "nope", data: {} },
    ]);
    expect(iv!.port).toBe(30);
    expect(iv!.hex!.slice(0, 8)).toBe("02000500");
    expect(reboot!.codes).toEqual(["ENCODE_OUT_OF_RANGE"]);
    expect(unknown!.codes).toEqual(["NO_MATCHING_MESSAGE"]);
  });

  it("collects every encode error and reports repeat paths as name[i].field", async () => {
    const [both, noArr] = await tracker.run([
      { op: "encode", message: "setMode", data: { mode: "turbo" } },
    ]).then(async (a) => [...a, ...(await meter.run([{ op: "encode", message: "reading", data: { seq: 1, energy: { import: 0, power: 0 } } }]))]);
    expect(both!.codes).toEqual(["ENCODE_OUT_OF_RANGE", "ENCODE_MISSING_FIELD"]);
    expect(noArr!.codes).toContain("ENCODE_MISSING_FIELD");
    const [w] = await bits.run([{ op: "decode", hex: "02034011000107" + "07", topic: "devices/x" }]);
    expect(w!.warnings).toEqual(["items[0].payload: no case for 64", "items[1].g.k: unknown enum value 7"]);
  });

  it("auto-sets repeat ref counts and encodes 64-bit values", async () => {
    const [rep, big] = await meter.run([
      { op: "encode", message: "reading", data: { seq: 1, energy: { import: 0, power: 0 }, channels: [{ id: 9, value: 1 }] } },
    ]).then(async (a) => [...a, ...(await bits.run([{ op: "encode", message: "sensor", data: { temp: 25.5, hum: 1, alarm: false, s64: "-9007199254740993", u64: "18446744073709551614", u48: 1, small: -16, tiny: 0 } }]))]);
    expect(rep!.ok).toBe(true);
    expect(rep!.hex!.slice(0, 20)).toBe("0100000000000000" + "0109");
    expect(big!.ok).toBe(true);
    expect(big!.hex!.slice(6, 38)).toBe("ffdfffffffffffff" + "fffffffffffffffe");
    if (hasMessage) {
      const [dec] = await bits.run([{ op: "decode", hex: big!.hex!, topic: "devices/a/up" }]);
      expect((dec!.data as any).s64).toBe("-9007199254740993");
    }
  });

  it("decodes downlink payloads", async () => {
    const [d] = await meter.run([{ op: "decodeDownlink", hex: "ff0a", port: 32 }]);
    expect(d!.ok).toBe(true);
    expect(d!.data).toEqual({ delay: 10 });
  });
});
