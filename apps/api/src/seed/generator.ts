import type { Codec, DeviceCodecSpec } from "@hash8/dcs-schema";
import { fromHex, toHex } from "@hash8/dcs-schema";

export interface GeneratedUplink {
  hex: string;
  port?: number;
  topic?: string;
  message: string;
  data: Record<string, unknown>;
}

export interface DeviceContext {
  serial: string;
  lat?: number;
  lng?: number;
  /** 0..1 progression used for slowly-draining values (battery, counters). */
  phase?: number;
  /** Force an anomaly (e.g. high temperature, tamper). */
  anomaly?: boolean;
}

interface Template {
  message: string;
  port?: number;
  topic?: string;
  data: Record<string, unknown>;
  hex: string;
}

/** Deterministic PRNG (mulberry32) so seeds are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function decimalsOf(v: number): number {
  if (Number.isInteger(v)) return 0;
  const s = String(v);
  const i = s.indexOf(".");
  return i < 0 ? 0 : Math.min(6, s.length - i - 1);
}

/**
 * Produces realistic uplinks by taking each uplink test vector as a template,
 * perturbing its decoded values (with name-aware rules) and re-encoding with the
 * real codec. If a perturbed value does not encode, the original vector is used —
 * so every generated payload is guaranteed to decode with the published codec.
 */
export class PayloadGenerator {
  readonly templates: Template[] = [];

  constructor(
    readonly spec: DeviceCodecSpec,
    private codec: Codec,
  ) {
    for (const v of spec.vectors ?? []) {
      if ((v.direction ?? "uplink") !== "uplink") continue;
      const ctx: { port?: number; topic?: string } = {};
      if (v.port !== undefined) ctx.port = v.port;
      if (v.topic !== undefined) ctx.topic = v.topic;
      let r;
      try {
        r = codec.decode(fromHex(v.hex), ctx);
      } catch {
        continue;
      }
      if (!r.ok) continue;
      const t: Template = { message: r.message, data: r.data, hex: v.hex.replace(/\s+/g, "").toLowerCase() };
      if (v.port !== undefined) t.port = v.port;
      if (v.topic !== undefined) t.topic = v.topic;
      this.templates.push(t);
    }
  }

  get usable() {
    return this.templates.length > 0;
  }

  /** Pick a template, weighted towards "periodic" messages (non-ack/config/alarm). */
  private pick(rand: () => number, anomaly: boolean): Template {
    const periodic = this.templates.filter((t) => !/ack|config|setting|alarm|event|boot|error/i.test(t.message));
    const special = this.templates.filter((t) => /alarm|event|tamper/i.test(t.message));
    if (anomaly && special.length && rand() < 0.5) return special[Math.floor(rand() * special.length)]!;
    const pool = periodic.length && rand() < 0.9 ? periodic : this.templates;
    return pool[Math.floor(rand() * pool.length)]!;
  }

  next(dev: DeviceContext, rand: () => number): GeneratedUplink {
    const anomaly = !!dev.anomaly;
    const t = this.pick(rand, anomaly);
    const data = this.perturb(structuredClone(t.data), dev, rand, anomaly) as Record<string, unknown>;
    const enc = this.codec.encode(t.message, data);
    if (enc.ok) {
      const ctx: { port?: number; topic?: string } = {};
      const port = t.port ?? enc.port;
      if (port !== undefined) ctx.port = port;
      if (t.topic !== undefined) ctx.topic = t.topic;
      const check = this.codec.decode(enc.bytes, ctx);
      if (check.ok && check.message === t.message) {
        const out: GeneratedUplink = { hex: toHex(enc.bytes), message: t.message, data: check.data };
        if (port !== undefined) out.port = port;
        if (t.topic !== undefined) out.topic = t.topic;
        return out;
      }
    }
    const out: GeneratedUplink = { hex: t.hex, message: t.message, data: t.data };
    if (t.port !== undefined) out.port = t.port;
    if (t.topic !== undefined) out.topic = t.topic;
    return out;
  }

  private perturb(v: unknown, dev: DeviceContext, rand: () => number, anomaly: boolean, key = ""): unknown {
    if (Array.isArray(v)) return v.map((x) => this.perturb(x, dev, rand, anomaly, key));
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) o[k] = this.perturb(o[k], dev, rand, anomaly, k);
      return o;
    }
    if (typeof v === "boolean") {
      if (/tamper|alarm/i.test(key)) return anomaly;
      return v;
    }
    if (typeof v === "string") return key === "alarmType" && anomaly && rand() < 0.6 ? "tamper" : v;
    if (typeof v !== "number") return v;
    const k = key.toLowerCase();
    const dec = decimalsOf(v);
    const round = (x: number) => Number(x.toFixed(Math.max(dec, 0)));
    if (/^(lat|latitude)$/.test(k) && dev.lat !== undefined) return round(dev.lat + (rand() - 0.5) * 0.02);
    if (/^(lng|lon|long|longitude)$/.test(k) && dev.lng !== undefined) return round(dev.lng + (rand() - 0.5) * 0.02);
    if (/temp/.test(k)) return round(anomaly ? 31 + rand() * 5 : 18 + rand() * 10);
    if (/hum/.test(k)) return round(Math.min(95, Math.max(20, v + (rand() - 0.5) * 10)));
    if (/batt|soc/.test(k)) {
      const phase = dev.phase ?? rand();
      if (v > 100) return Math.round(v >= 3200 ? 4150 - phase * 900 : 3050 - phase * 700); // millivolts
      if (v <= 5) return round(Math.max(3.0, 4.15 - phase * 0.9)); // volts
      return Math.round(Math.max(5, 100 - phase * 85));
    }
    if (/rssi|signal/.test(k)) return Math.round(Math.min(-60, Math.max(-118, v + (rand() - 0.5) * 12)));
    if (/seq|count|counter|energy|kwh|total|uptime|year|month|day|hour|offset|major|minor|patch/.test(k)) return v; // monotonic / cumulative: leave as-is
    if (/^(id|type|version|ver|code|status|mode|port)$/.test(k) || /_?(id|type|flags?)$/.test(k)) return v;
    if (v === 0) return v;
    const jitter = (rand() - 0.5) * 0.1 * Math.abs(v);
    const nv = v + jitter;
    return dec === 0 ? Math.round(v >= 0 ? Math.max(0, nv) : nv) : round(nv);
  }
}
