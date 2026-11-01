import { describe, it, expect } from "vitest";
import { parseSpec, type ScalarField } from "@hash8/dcs-schema";
import {
  DeviceSimulator,
  GpsTrack,
  INDIAN_CITIES,
  decayBattery,
  haversineKm,
  mulberry32,
  physicalRange,
  quantize,
  randomWalk,
  referencedNames,
  roleOf,
  synthesize,
} from "../src/generators";

const scalar = (f: Partial<ScalarField> & { name: string; type: ScalarField["type"] }) =>
  ({ kind: "scalar", ...f }) as ScalarField;

const tracker = parseSpec({
  dcs: "1.0",
  id: "test.tracker",
  version: "1.0.0",
  device: { vendor: "Test", model: "T1" },
  uplink: [
    {
      name: "position",
      when: { port: 1 },
      fields: [
        { kind: "const", name: "magic", bits: 8, value: 0xa1 },
        { name: "latitude", type: "int", bits: 32, scale: 0.000001, decimals: 6, unit: "deg" },
        { name: "longitude", type: "int", bits: 32, scale: 0.000001, decimals: 6, unit: "deg" },
        { name: "speed", type: "uint", bits: 8, unit: "km/h" },
        { name: "battery", type: "uint", bits: 8, unit: "%", min: 0, max: 100 },
        { name: "temperature", type: "int", bits: 16, scale: 0.1, unit: "Cel", min: -40, max: 85 },
        { name: "alarm", type: "uint", bits: 8, enum: { "0": "none", "1": "sos", "2": "tamper" } },
        { name: "odometer", type: "uint", bits: 32, unit: "km" },
        { name: "count", type: "uint", bits: 8 },
        { kind: "repeat", name: "cells", count: { ref: "count" }, fields: [{ name: "rssi", type: "int", bits: 8 }] },
        { kind: "checksum", name: "crc", algo: "crc8" },
      ],
    },
    {
      name: "status",
      when: { port: 2 },
      fields: [
        { name: "kind", type: "uint", bits: 8, enum: { "1": "boot", "2": "heartbeat" } },
        {
          kind: "switch",
          name: "body",
          on: "kind",
          cases: { "1": [{ name: "fw", type: "string", length: 6 }], "2": [{ name: "uptime", type: "uint", bits: 32 }] },
        },
      ],
    },
  ],
});

describe("rng", () => {
  it("is deterministic per seed and in [0,1)", () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("ranges", () => {
  it("maps bits through scale/offset and intersects min/max", () => {
    expect(physicalRange(scalar({ name: "t", type: "int", bits: 16, scale: 0.1, min: -40, max: 85 }))).toEqual({
      min: -40,
      max: 85,
      quantum: 0.1,
    });
    expect(physicalRange(scalar({ name: "u", type: "uint", bits: 8 }))).toEqual({ min: 0, max: 255, quantum: 1 });
    const off = physicalRange(scalar({ name: "o", type: "uint", bits: 8, scale: 0.5, offset: -20 }))!;
    expect(off.min).toBe(-20);
    expect(off.max).toBe(107.5);
    expect(physicalRange(scalar({ name: "s", type: "string", length: 4 }))).toBeUndefined();
  });

  it("quantizes to representable values", () => {
    const f = scalar({ name: "t", type: "int", bits: 16, scale: 0.1, min: -40, max: 85 });
    const r = physicalRange(f)!;
    expect(quantize(21.2999999, r, f)).toBe(21.3);
    expect(quantize(999, r, f)).toBe(85);
    expect(quantize(-1000, r, f)).toBe(-40);
  });
});

describe("randomWalk", () => {
  it("stays within bounds and actually moves", () => {
    const rng = mulberry32(7);
    const r = { min: -40, max: 85, quantum: 0.1 };
    let v = 20;
    const seen = new Set<number>();
    for (let i = 0; i < 10_000; i++) {
      v = randomWalk(v, r, rng);
      expect(v).toBeGreaterThanOrEqual(r.min);
      expect(v).toBeLessThanOrEqual(r.max);
      seen.add(Math.round(v));
    }
    expect(seen.size).toBeGreaterThan(20);
  });

  it("small steps: consecutive values are close", () => {
    const rng = mulberry32(3);
    const r = { min: 0, max: 100, quantum: 0 };
    let v = 50;
    for (let i = 0; i < 1000; i++) {
      const n = randomWalk(v, r, rng);
      expect(Math.abs(n - v)).toBeLessThanOrEqual(2 + 1e-9);
      v = n;
    }
  });
});

describe("battery", () => {
  it("decays monotonically until it is swapped", () => {
    const rng = mulberry32(11);
    const r = { min: 0, max: 100, quantum: 1 };
    let level = 100;
    let drops = 0;
    let swaps = 0;
    for (let i = 0; i < 20_000; i++) {
      const n = decayBattery(level, r, rng);
      if (n < level) drops++;
      if (n > level) swaps++;
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(100);
      level = n;
    }
    expect(drops).toBeGreaterThan(swaps * 100);
    expect(swaps).toBeGreaterThan(0);
  });
});

describe("GpsTrack", () => {
  it("starts near an Indian city and drives toward another at plausible speed", () => {
    const g = new GpsTrack(mulberry32(5), INDIAN_CITIES, 60);
    const start = { lat: g.lat, lng: g.lng };
    expect(INDIAN_CITIES.some((c) => haversineKm(c, start) < 15)).toBe(true);
    let prev = start;
    let travelled = 0;
    for (let i = 0; i < 600; i++) {
      const fix = g.step(1);
      // 1 real s × 60 = 60 simulated s at ≤110 km/h ⇒ ≤ ~1.9 km per step (+ jitter)
      const d = haversineKm(prev, fix);
      travelled += d;
      expect(d).toBeLessThan(2.2);
      expect(fix.speedKmh).toBeLessThanOrEqual(110);
      expect(fix.lat).toBeGreaterThan(6);
      expect(fix.lat).toBeLessThan(37);
      expect(fix.lng).toBeGreaterThan(68);
      expect(fix.lng).toBeLessThan(98);
      prev = fix;
    }
    expect(travelled).toBeGreaterThan(200);
  });
});

describe("roles", () => {
  it("classifies by field name", () => {
    expect(roleOf(scalar({ name: "latitude", type: "int" }))).toBe("lat");
    expect(roleOf(scalar({ name: "lon", type: "int" }))).toBe("lng");
    expect(roleOf(scalar({ name: "battery_pct", type: "uint" }))).toBe("battery");
    expect(roleOf(scalar({ name: "alarm_flags", type: "uint" }))).toBe("alarm");
    expect(roleOf(scalar({ name: "energy_kwh", type: "uint" }))).toBe("counter");
    expect(roleOf(scalar({ name: "timestamp", type: "uint", bits: 32 }))).toBe("timestamp");
    expect(roleOf(scalar({ name: "humidity", type: "uint" }))).toBe("walk");
  });

  it("finds switch/repeat reference names", () => {
    const all = tracker.uplink.flatMap((m) => [...referencedNames(m.fields)]);
    expect(all.sort()).toEqual(["count", "kind"]);
  });
});

describe("synthesize", () => {
  it("builds an object for every emitted field; omits const/checksum and the repeat ref", () => {
    const data = synthesize(tracker.uplink[0]!.fields, mulberry32(1), "T1-0001");
    expect(Object.keys(data).sort()).toEqual(
      ["alarm", "battery", "cells", "latitude", "longitude", "odometer", "speed", "temperature"].sort(),
    );
    expect(data.alarm).toBe("none");
    expect(Array.isArray(data.cells)).toBe(true);
  });

  it("selects a switch case and sets the discriminator", () => {
    const data = synthesize(tracker.uplink[1]!.fields, mulberry32(1));
    expect(data.kind).toBe("boot");
    expect(typeof data.fw).toBe("string");
    expect((data.fw as string).length).toBe(6);
  });
});

describe("DeviceSimulator", () => {
  it("produces evolving, in-range, quantized values with GPS in India", () => {
    const sim = new DeviceSimulator(tracker, { serial: "T1-0001", rng: mulberry32(9), alarmRate: 0.05 });
    let t = Date.now();
    let alarms = 0;
    let lastBattery = Infinity;
    let batteryUps = 0;
    const temps = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const up = sim.next((t += 60_000), "position");
      expect(up.port).toBe(1);
      const d = up.data as Record<string, number | string>;
      expect(d.latitude as number).toBeGreaterThan(6);
      expect(d.latitude as number).toBeLessThan(37);
      expect(d.longitude as number).toBeGreaterThan(68);
      expect(d.longitude as number).toBeLessThan(98);
      expect(Number.isInteger(Math.round((d.latitude as number) * 1e6))).toBe(true);
      expect(d.temperature as number).toBeGreaterThanOrEqual(-40);
      expect(d.temperature as number).toBeLessThanOrEqual(85);
      expect(Math.abs((d.temperature as number) * 10 - Math.round((d.temperature as number) * 10))).toBeLessThan(1e-6);
      expect(d.battery as number).toBeGreaterThanOrEqual(0);
      expect(d.battery as number).toBeLessThanOrEqual(100);
      expect(d.speed as number).toBeLessThanOrEqual(255);
      if ((d.battery as number) > lastBattery) batteryUps++;
      lastBattery = d.battery as number;
      if (d.alarm !== "none") alarms++;
      temps.add(d.temperature as number);
    }
    expect(alarms).toBeGreaterThan(20);
    expect(alarms).toBeLessThan(300);
    expect(temps.size).toBeGreaterThan(10);
    expect(batteryUps).toBeLessThan(20);
  });

  it("uses templates from vectors as the baseline and never mutates ref/switch keys", () => {
    const sim = new DeviceSimulator(tracker, {
      serial: "T1-0002",
      templates: { status: { kind: "heartbeat", uptime: 1000 } },
    });
    let t = Date.now();
    let prevUptime = 1000;
    for (let i = 0; i < 50; i++) {
      const up = sim.next((t += 1000), "status");
      expect(up.data.kind).toBe("heartbeat");
      expect(up.data.uptime as number).toBeGreaterThanOrEqual(prevUptime);
      prevUptime = up.data.uptime as number;
    }
    expect(prevUptime).toBeGreaterThan(1000);
  });

  it("odometer counter is monotonic", () => {
    const sim = new DeviceSimulator(tracker, { serial: "T1-0003" });
    let prev = -1;
    let t = Date.now();
    for (let i = 0; i < 200; i++) {
      const v = sim.next((t += 1000), "position").data.odometer as number;
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it("is deterministic for the same seed", () => {
    const a = new DeviceSimulator(tracker, { serial: "X", rng: mulberry32(1) });
    const b = new DeviceSimulator(tracker, { serial: "X", rng: mulberry32(1) });
    const t = 1_700_000_000_000;
    for (let i = 0; i < 20; i++) expect(a.next(t + i * 1000)).toEqual(b.next(t + i * 1000));
  });
});
