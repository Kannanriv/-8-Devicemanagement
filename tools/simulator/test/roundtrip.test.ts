import { describe, it, expect } from "vitest";
import { createCodec } from "@hash8/codec-runtime";
import { parseSpec } from "@hash8/dcs-schema";
import { DeviceSimulator, mulberry32 } from "../src/generators";

const spec = parseSpec({
  dcs: "1.0",
  id: "test.rt",
  version: "1.0.0",
  device: { vendor: "Test", model: "RT" },
  uplink: [
    {
      name: "position",
      when: { port: 1 },
      fields: [
        { kind: "const", name: "magic", bits: 8, value: 0xa1 },
        { name: "latitude", type: "int", bits: 32, scale: 0.000001, decimals: 6 },
        { name: "longitude", type: "int", bits: 32, scale: 0.000001, decimals: 6 },
        { name: "speed", type: "uint", bits: 8 },
        { name: "battery", type: "uint", bits: 7, min: 0, max: 100 },
        { name: "moving", type: "bool", bits: 1 },
        { name: "temperature", type: "int", bits: 16, scale: 0.1, min: -40, max: 85 },
        { name: "alarm", type: "uint", bits: 8, enum: { "0": "none", "1": "sos" } },
        { name: "count", type: "uint", bits: 8 },
        { kind: "repeat", name: "cells", count: { ref: "count" }, fields: [{ name: "rssi", type: "int", bits: 8, min: -120, max: -30 }] },
        { kind: "checksum", name: "crc", algo: "crc16-ccitt" },
      ],
    },
    {
      name: "status",
      when: { port: 2 },
      fields: [
        { name: "kind", type: "uint", bits: 8, enum: { "1": "boot", "2": "heartbeat" } },
        { kind: "switch", name: "body", on: "kind", cases: { "1": [{ name: "fw", type: "string", length: 6 }], "2": [{ name: "uptime", type: "uint", bits: 32 }] } },
      ],
    },
  ],
});

describe("generated values round-trip through the codec runtime", () => {
  it("encode → decode reproduces the generated data (bit-exact payloads)", () => {
    const codec = createCodec(spec);
    const sim = new DeviceSimulator(spec, { serial: "RT-1", rng: mulberry32(4), alarmRate: 0.1 });
    let t = Date.now();
    for (let i = 0; i < 500; i++) {
      const up = sim.next((t += 30_000));
      const enc = codec.encode(up.message, up.data);
      if (!enc.ok) throw new Error(JSON.stringify(enc.errors));
      expect(enc.port).toBe(up.port);
      const dec = codec.decode(enc.bytes, { port: enc.port });
      if (!dec.ok) throw new Error(JSON.stringify(dec.errors));
      expect(dec.message).toBe(up.message);
      const { count: _c, ...decoded } = dec.data as Record<string, unknown>;
      const { count: _g, ...generated } = up.data;
      expect(decoded).toEqual(generated);
    }
  });
});
