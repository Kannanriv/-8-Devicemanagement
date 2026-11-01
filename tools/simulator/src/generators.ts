/**
 * Pure, deterministic (seeded) value generators for the fleet simulator.
 * Given a DCS spec, produce realistic, evolving uplink data that the codec can
 * encode bit-exactly: random walks inside field ranges, GPS tracks between
 * Indian cities, battery decay, monotonic counters and occasional alarms.
 */
import type { DeviceCodecSpec, Field, MessageDef, ScalarField } from "@hash8/dcs-schema";

export type Rng = () => number;

/** Small, fast, seedable PRNG (mulberry32). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Gaussian-ish noise in [-1, 1] (mean of 3 uniforms). */
function noise(rng: Rng) {
  return ((rng() + rng() + rng()) / 3) * 2 - 1;
}

// ── Ranges ──────────────────────────────────────────────────────────────────
export interface Range {
  min: number;
  max: number;
  /** Smallest representable physical increment (|scale|), 0 = continuous. */
  quantum: number;
}

/**
 * Physical value range a scalar can carry: the raw range representable by its
 * bits, mapped through scale/offset, intersected with declared min/max.
 */
export function physicalRange(f: ScalarField): Range | undefined {
  const scale = f.scale ?? 1;
  const offset = f.offset ?? 0;
  let rawMin: number;
  let rawMax: number;
  if (f.type === "uint") {
    const bits = Math.min(f.bits ?? 8, 52);
    rawMin = 0;
    rawMax = 2 ** bits - 1;
  } else if (f.type === "int") {
    const bits = Math.min(f.bits ?? 8, 52);
    rawMin = -(2 ** (bits - 1));
    rawMax = 2 ** (bits - 1) - 1;
  } else if (f.type === "float") {
    rawMin = -1e9;
    rawMax = 1e9;
  } else {
    return undefined;
  }
  const a = rawMin * scale + offset;
  const b = rawMax * scale + offset;
  let min = Math.min(a, b);
  let max = Math.max(a, b);
  if (f.min !== undefined) min = Math.max(min, f.min);
  if (f.max !== undefined) max = Math.min(max, f.max);
  if (min > max) [min, max] = [max, min];
  return { min, max, quantum: f.type === "float" ? 0 : Math.abs(scale) };
}

/** Snap to the field's quantum (so encode→decode is lossless) and clamp to range. */
export function quantize(v: number, r: Range, f?: ScalarField): number {
  let out = clamp(v, r.min, r.max);
  if (r.quantum > 0) {
    const offset = f?.offset ?? 0;
    const raw = Math.round((out - offset) / r.quantum);
    out = raw * r.quantum + offset;
    // re-clamp by whole quanta
    while (out > r.max + 1e-12) out -= r.quantum;
    while (out < r.min - 1e-12) out += r.quantum;
  }
  const decimals = f?.decimals ?? decimalsOf(r.quantum);
  return Number(out.toFixed(Math.min(decimals, 12)));
}

function decimalsOf(q: number): number {
  if (!q || Number.isInteger(q)) return 0;
  const s = q.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]) + 2;
  return (s.split(".")[1]?.length ?? 0) + 1;
}

/** Bounded random walk; reflects off the bounds. */
export function randomWalk(value: number, r: Range, rng: Rng, stepFraction = 0.02): number {
  const span = r.max - r.min;
  if (!(span > 0)) return r.min;
  const step = Math.max(span * stepFraction, r.quantum);
  let v = value + noise(rng) * step;
  if (v > r.max) v = r.max - (v - r.max);
  if (v < r.min) v = r.min + (r.min - v);
  return clamp(v, r.min, r.max);
}

/** Battery: slow drain per message; a swap/recharge restores it once empty. */
export function decayBattery(level: number, r: Range, rng: Rng, drainFraction = 0.0005): number {
  const span = r.max - r.min;
  const next = level - span * drainFraction * (0.5 + rng());
  if (next <= r.min + span * 0.05) return rng() < 0.2 ? r.max : Math.max(r.min, next);
  return next;
}

// ── GPS ─────────────────────────────────────────────────────────────────────
export interface City {
  name: string;
  lat: number;
  lng: number;
}
export const INDIAN_CITIES: City[] = [
  { name: "Bengaluru", lat: 12.9716, lng: 77.5946 },
  { name: "Chennai", lat: 13.0827, lng: 80.2707 },
  { name: "Hyderabad", lat: 17.385, lng: 78.4867 },
  { name: "Mumbai", lat: 19.076, lng: 72.8777 },
  { name: "Pune", lat: 18.5204, lng: 73.8567 },
  { name: "Delhi", lat: 28.6139, lng: 77.209 },
  { name: "Kolkata", lat: 22.5726, lng: 88.3639 },
  { name: "Ahmedabad", lat: 23.0225, lng: 72.5714 },
  { name: "Jaipur", lat: 26.9124, lng: 75.7873 },
  { name: "Kochi", lat: 9.9312, lng: 76.2673 },
  { name: "Coimbatore", lat: 11.0168, lng: 76.9558 },
  { name: "Lucknow", lat: 26.8467, lng: 80.9462 },
];

const R_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

export function bearingDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export interface GpsFix {
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number;
  target: string;
}

/** A vehicle driving city-to-city at highway speeds with jitter; parks briefly on arrival. */
export class GpsTrack {
  lat: number;
  lng: number;
  speedKmh = 0;
  heading = 0;
  private target: City;
  private parkedSec = 0;

  constructor(
    private readonly rng: Rng,
    private readonly cities: City[] = INDIAN_CITIES,
    /** Simulated seconds per real second — makes movement visible in short runs. */
    private readonly timeScale = 60,
  ) {
    const start = cities[Math.floor(rng() * cities.length)]!;
    this.lat = start.lat + noise(rng) * 0.05;
    this.lng = start.lng + noise(rng) * 0.05;
    this.target = this.pickTarget(start);
  }

  private pickTarget(exclude?: City): City {
    const pool = this.cities.filter((c) => c !== exclude);
    return pool[Math.floor(this.rng() * pool.length)] ?? this.cities[0]!;
  }

  get targetName() {
    return this.target.name;
  }

  step(dtSec: number): GpsFix {
    const dt = dtSec * this.timeScale;
    if (this.parkedSec > 0) {
      this.parkedSec -= dt;
      this.speedKmh = 0;
    } else {
      const dist = haversineKm(this, this.target);
      if (dist < 1) {
        this.parkedSec = 600 + this.rng() * 1800;
        this.speedKmh = 0;
        this.target = this.pickTarget(this.target);
      } else {
        this.speedKmh = clamp(55 + noise(this.rng) * 35, 5, 110);
        this.heading = bearingDeg(this, this.target);
        const moveKm = Math.min(dist, (this.speedKmh * dt) / 3600);
        const frac = moveKm / dist;
        this.lat += (this.target.lat - this.lat) * frac + noise(this.rng) * 0.0002;
        this.lng += (this.target.lng - this.lng) * frac + noise(this.rng) * 0.0002;
      }
    }
    return { lat: this.lat, lng: this.lng, speedKmh: this.speedKmh, heading: this.heading, target: this.target.name };
  }
}

// ── Field roles (name heuristics) ───────────────────────────────────────────
export type Role = "lat" | "lng" | "speed" | "heading" | "battery" | "counter" | "timestamp" | "alarm" | "walk";

export function roleOf(f: ScalarField): Role {
  const n = f.name.toLowerCase();
  if (/^(lat|latitude|gps_?lat)$/.test(n)) return "lat";
  if (/^(lng|lon|long|longitude|gps_?(lng|lon))$/.test(n)) return "lng";
  if (/alarm|alert|tamper|fault|sos|panic|leak|overload|^event/.test(n)) return "alarm";
  if (/batt|battery|soc/.test(n)) return "battery";
  if (/^(speed|velocity|spd)/.test(n)) return "speed";
  if (/heading|course|bearing|direction/.test(n)) return "heading";
  if (/(timestamp|epoch|^ts$|^time$|unix)/.test(n) && (f.type === "uint" || f.type === "int")) return "timestamp";
  if (/(energy|kwh|wh_|_wh|total|odometer|odo|uptime|counter|count$|seq|frame_?cnt|pulse)/.test(n)) return "counter";
  return "walk";
}

// ── Spec-driven synthesis & evolution ──────────────────────────────────────
type Obj = Record<string, unknown>;

const isScalar = (f: Field): f is ScalarField => (f.kind ?? "scalar") === "scalar";
const fieldKind = (f: Field) => f.kind ?? "scalar";

/** Names referenced by switch `on` / repeat `{ref}` — never mutate these. */
export function referencedNames(fields: Field[], out = new Set<string>()): Set<string> {
  for (const f of fields) {
    if (f.kind === "switch") {
      out.add(f.on.split(".").at(-1)!);
      for (const c of Object.values(f.cases)) referencedNames(c, out);
      if (f.default) referencedNames(f.default, out);
    } else if (f.kind === "repeat") {
      if (typeof f.count === "object") out.add(f.count.ref.split(".").at(-1)!);
      referencedNames(f.fields, out);
    } else if (f.kind === "group") referencedNames(f.fields, out);
  }
  return out;
}

function synthScalar(f: ScalarField, rng: Rng, serial: string): unknown {
  if (f.default !== undefined) return f.default;
  if (f.enum) return Object.values(f.enum)[0];
  const len = typeof f.length === "number" ? f.length : 2;
  switch (f.type) {
    case "bool":
      return false;
    case "bytes":
      return "00".repeat(len);
    case "string":
      return "SIM".padEnd(len, " ").slice(0, len);
    case "bcd": {
      const digits = (serial.replace(/\D/g, "") + "35693803564380").padStart(len * 2, "0");
      return digits.slice(-len * 2);
    }
    default: {
      const r = physicalRange(f)!;
      const span = r.max - r.min;
      const role = roleOf(f);
      let base: number;
      if (role === "battery") base = r.max - span * 0.1 * rng();
      else if (role === "alarm" || role === "counter") base = r.min;
      else if (f.min === undefined && f.max === undefined && r.min < 0 && r.max > 0 && span > 1000) base = 0;
      else base = r.min + span * (0.3 + 0.4 * rng());
      return quantize(base, r, f);
    }
  }
}

/** Build a plausible data object for a message straight from its field layout. */
export function synthesize(fields: Field[], rng: Rng, serial = "SIM0001", obj: Obj = {}): Obj {
  for (const f of fields) {
    switch (f.kind ?? "scalar") {
      case "scalar":
        if (!(f as ScalarField).hidden) obj[f.name] = synthScalar(f as ScalarField, rng, serial);
        break;
      case "group":
        obj[f.name] = synthesize((f as { fields: Field[] }).fields, rng, serial);
        break;
      case "repeat": {
        const rf = f as Extract<Field, { kind: "repeat" }>;
        const n = typeof rf.count === "number" ? rf.count : 2;
        obj[f.name] = Array.from({ length: n }, () => synthesize(rf.fields, rng, serial));
        if (typeof rf.count === "object") delete obj[rf.count.ref.split(".").at(-1)!]; // encoder auto-sets it
        break;
      }
      case "switch": {
        const sf = f as Extract<Field, { kind: "switch" }>;
        const key = Object.keys(sf.cases)[0];
        if (key === undefined) {
          if (sf.default) synthesize(sf.default, rng, serial, obj);
          break;
        }
        const onName = sf.on.split(".").at(-1)!;
        const onField = fields.find((x) => x.name === onName);
        const raw = Number(key);
        if (onField && isScalar(onField)) {
          obj[onName] = onField.enum?.[String(raw)] ?? raw * (onField.scale ?? 1) + (onField.offset ?? 0);
        } else obj[onName] = raw;
        synthesize(sf.cases[key]!, rng, serial, obj);
        break;
      }
      default:
        break; // const / checksum are written by the encoder
    }
  }
  return obj;
}

export interface GeneratedUplink {
  message: string;
  data: Obj;
  port?: number;
}

export interface DeviceSimOptions {
  rng?: Rng;
  serial?: string;
  /** Per-message baseline data, e.g. from the spec's uplink test vectors (decoded). */
  templates?: Record<string, Obj>;
  /** Probability a given alarm field fires on a message. */
  alarmRate?: number;
  /** Simulated-time acceleration for GPS movement. */
  timeScale?: number;
}

const deepClone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * One simulated device bound to a spec. `next()` returns the next uplink:
 * the main (first) uplink message most of the time, others occasionally.
 */
export class DeviceSimulator {
  readonly serial: string;
  private readonly rng: Rng;
  private readonly alarmRate: number;
  private readonly state = new Map<string, Obj>();
  private readonly baselines = new Map<string, Obj>();
  private readonly frozen: Set<string>;
  private readonly gps: GpsTrack;
  private lastAt = Date.now();
  private counter = 0;

  constructor(
    readonly spec: DeviceCodecSpec,
    opts: DeviceSimOptions = {},
  ) {
    this.serial = opts.serial ?? "SIM0001";
    this.rng = opts.rng ?? mulberry32(hashSeed(this.serial));
    this.alarmRate = opts.alarmRate ?? 0.01;
    this.gps = new GpsTrack(this.rng, INDIAN_CITIES, opts.timeScale ?? 60);
    this.frozen = new Set(spec.uplink.flatMap((m) => [...referencedNames(m.fields)]));
    for (const m of spec.uplink) {
      const tpl = opts.templates?.[m.name];
      const base = tpl ? deepClone(tpl) : synthesize(m.fields, this.rng, this.serial);
      this.baselines.set(m.name, deepClone(base));
      this.state.set(m.name, base);
    }
  }

  pickMessage(): MessageDef {
    const ups = this.spec.uplink;
    if (ups.length === 1) return ups[0]!;
    // main telemetry message weighted ×6
    const total = 6 + (ups.length - 1);
    const r = this.rng() * total;
    return r < 6 ? ups[0]! : ups[1 + Math.floor(r - 6)] ?? ups[0]!;
  }

  next(now = Date.now(), message?: string): GeneratedUplink {
    const m = message ? this.spec.uplink.find((x) => x.name === message) ?? this.pickMessage() : this.pickMessage();
    const dt = Math.max(0, (now - this.lastAt) / 1000);
    this.lastAt = now;
    this.counter++;
    const data = this.state.get(m.name)!;
    const fix = this.gps.step(dt || 1);
    this.evolve(m.fields, data, this.baselines.get(m.name)!, fix, now);
    const port = Array.isArray(m.when?.port) ? m.when.port[0] : m.when?.port;
    return { message: m.name, data: deepClone(data), ...(port !== undefined ? { port } : {}) };
  }

  private evolve(fields: Field[], obj: Obj, base: Obj, fix: GpsFix, now: number) {
    for (const f of fields) {
      const k = fieldKind(f);
      if (k === "scalar") this.evolveScalar(f as ScalarField, obj, base, fix, now);
      else if (k === "group") {
        const child = obj[f.name];
        if (child && typeof child === "object") this.evolve((f as { fields: Field[] }).fields, child as Obj, (base[f.name] ?? {}) as Obj, fix, now);
      } else if (k === "repeat") {
        const arr = obj[f.name];
        const barr = (base[f.name] ?? []) as Obj[];
        if (Array.isArray(arr))
          arr.forEach((el, i) => el && typeof el === "object" && this.evolve((f as { fields: Field[] }).fields, el as Obj, barr[i] ?? {}, fix, now));
      } else if (k === "switch") {
        const sf = f as Extract<Field, { kind: "switch" }>;
        for (const c of Object.values(sf.cases)) this.evolve(c, obj, base, fix, now);
        if (sf.default) this.evolve(sf.default, obj, base, fix, now);
      }
    }
  }

  private evolveScalar(f: ScalarField, obj: Obj, base: Obj, fix: GpsFix, now: number) {
    if (f.hidden || !(f.name in obj) || this.frozen.has(f.name)) return;
    const role = roleOf(f);
    const cur = obj[f.name];
    if (role === "alarm") {
      const baseline = base[f.name];
      if (this.rng() >= this.alarmRate) {
        obj[f.name] = baseline;
        return;
      }
      if (f.type === "bool") obj[f.name] = !baseline;
      else if (f.enum) {
        const labels = Object.values(f.enum).filter((l) => l !== baseline);
        obj[f.name] = labels.length ? labels[Math.floor(this.rng() * labels.length)] : baseline;
      } else if (typeof baseline === "number") {
        const r = physicalRange(f);
        if (r) obj[f.name] = quantize(baseline === r.min ? r.min + Math.max(r.quantum, 1) : r.min, r, f);
      }
      return;
    }
    if (typeof cur !== "number" || f.enum) {
      // enums / strings / bytes / bools: stable, occasionally re-roll a non-alarm enum
      if (f.enum && this.rng() < 0.02) {
        const labels = Object.values(f.enum);
        obj[f.name] = labels[Math.floor(this.rng() * labels.length)];
      }
      return;
    }
    const r = physicalRange(f);
    if (!r) return;
    let v: number;
    switch (role) {
      case "lat":
        v = fix.lat;
        break;
      case "lng":
        v = fix.lng;
        break;
      case "speed":
        v = fix.speedKmh;
        break;
      case "heading":
        v = fix.heading;
        break;
      case "battery":
        v = decayBattery(cur, r, this.rng);
        break;
      case "counter":
        v = cur + Math.max(r.quantum, (r.max - r.min) * 1e-6) * (1 + Math.floor(this.rng() * 5));
        if (v > r.max) v = r.min; // wrap like a real counter
        break;
      case "timestamp":
        v = Math.floor(now / 1000);
        if (v > r.max || v < r.min) v = cur;
        break;
      default:
        v = randomWalk(cur, r, this.rng);
    }
    obj[f.name] = quantize(v, r, f);
  }
}
