import type { DeviceCodecSpec, Field, MessageDef, SourceRef } from "@hash8/dcs-schema";

export interface FieldRange {
  path: string;
  startBit: number;
  bits: number;
  hidden?: boolean;
  kind: Field["kind"];
}

const CHECKSUM_BITS: Record<string, number> = {
  crc8: 8,
  xor8: 8,
  sum8: 8,
  "crc16-ccitt": 16,
  "crc16-modbus": 16,
  crc32: 32,
};

function scalarBits(f: Extract<Field, { kind: "scalar" }>): number | null {
  if (f.type === "bytes" || f.type === "string" || f.type === "bcd") {
    return typeof f.length === "number" ? f.length * 8 : null;
  }
  if (f.type === "float") return f.bits ?? 32;
  if (f.type === "bool") return f.bits ?? 1;
  return f.bits ?? 8;
}

/**
 * Best-effort static byte layout for a message: walks fixed-width fields in order.
 * Stops at the first variable-width construct (repeat / switch / remaining).
 * `complete` is false when the layout could not be resolved to the end.
 */
export function messageLayout(msg: MessageDef, totalBytes?: number): { ranges: FieldRange[]; complete: boolean } {
  const ranges: FieldRange[] = [];
  let cursor = 0;
  let complete = true;
  const trailing: FieldRange[] = [];

  const walk = (fields: Field[], prefix: string): boolean => {
    for (const f of fields) {
      const path = prefix ? `${prefix}.${f.name}` : f.name;
      const kind = (f as { kind?: Field["kind"] }).kind ?? "scalar";
      if (kind === "group") {
        if (!walk((f as Extract<Field, { kind: "group" }>).fields, path)) return false;
        continue;
      }
      if (kind === "repeat" || kind === "switch") return false;
      if (kind === "checksum") {
        const bits = CHECKSUM_BITS[(f as Extract<Field, { kind: "checksum" }>).algo] ?? 8;
        if (totalBytes != null) trailing.push({ path, startBit: totalBytes * 8 - bits, bits, kind });
        continue;
      }
      if (kind === "const") {
        const bits = (f as Extract<Field, { kind: "const" }>).bits;
        ranges.push({ path, startBit: cursor, bits, kind });
        cursor += bits;
        continue;
      }
      const sf = f as Extract<Field, { kind: "scalar" }>;
      let bits = scalarBits({ ...sf, kind: "scalar" });
      if (bits == null && sf.length === "remaining" && totalBytes != null) {
        const tail = trailing.reduce((a, t) => a + t.bits, 0);
        bits = totalBytes * 8 - cursor - tail;
      }
      if (bits == null) return false;
      ranges.push({ path, startBit: cursor, bits, hidden: sf.hidden, kind: "scalar" });
      cursor += bits;
    }
    return true;
  };

  complete = walk(msg.fields, "");
  return { ranges: [...ranges, ...trailing], complete };
}

export function findMessage(spec: DeviceCodecSpec | undefined, name: string | undefined, direction: "uplink" | "downlink" = "uplink") {
  if (!spec || !name) return undefined;
  return (direction === "uplink" ? spec.uplink : (spec.downlink ?? [])).find((m) => m.name === name);
}

export interface FieldRow {
  path: string;
  name: string;
  depth: number;
  kind: Field["kind"];
  type?: string;
  bits?: number;
  length?: number | "remaining";
  unit?: string;
  scale?: number;
  offset?: number;
  enumMap?: Record<string, string>;
  min?: number;
  max?: number;
  value?: number;
  description?: string;
  source?: SourceRef;
  hidden?: boolean;
  detail?: string;
}

/** Flatten a message's field tree into table rows (groups / repeats / switches become headers). */
export function fieldRows(fields: Field[], prefix = "", depth = 0, out: FieldRow[] = []): FieldRow[] {
  for (const f of fields) {
    const path = prefix ? `${prefix}.${f.name}` : f.name;
    const kind = (f as { kind?: Field["kind"] }).kind ?? "scalar";
    const base = { path, name: f.name, depth, kind, description: f.description, source: f.source };
    switch (kind) {
      case "group": {
        out.push({ ...base, detail: "group" });
        fieldRows((f as Extract<Field, { kind: "group" }>).fields, path, depth + 1, out);
        break;
      }
      case "repeat": {
        const r = f as Extract<Field, { kind: "repeat" }>;
        const count = typeof r.count === "number" ? `×${r.count}` : r.count === "remaining" ? "× until end" : `× ${r.count.ref}`;
        out.push({ ...base, detail: `repeat ${count}` });
        fieldRows(r.fields, `${path}[]`, depth + 1, out);
        break;
      }
      case "switch": {
        const s = f as Extract<Field, { kind: "switch" }>;
        out.push({ ...base, detail: `switch on ${s.on}` });
        for (const [k, sub] of Object.entries(s.cases)) {
          out.push({ path: `${path}#${k}`, name: `case ${k}`, depth: depth + 1, kind: "group", detail: "case" });
          fieldRows(sub, path, depth + 2, out);
        }
        break;
      }
      case "const": {
        const c = f as Extract<Field, { kind: "const" }>;
        out.push({ ...base, type: "const", bits: c.bits, value: c.value });
        break;
      }
      case "checksum": {
        const c = f as Extract<Field, { kind: "checksum" }>;
        out.push({ ...base, type: c.algo, bits: CHECKSUM_BITS[c.algo] });
        break;
      }
      default: {
        const s = f as Extract<Field, { kind: "scalar" }>;
        out.push({
          ...base,
          type: s.type,
          bits: s.bits,
          length: s.length,
          unit: s.unit,
          scale: s.scale,
          offset: s.offset,
          enumMap: s.enum,
          min: s.min,
          max: s.max,
          hidden: s.hidden,
        });
      }
    }
  }
  return out;
}

/** Unit lookup: decoded key → UCUM unit, from all uplink messages. */
export function unitIndex(spec: DeviceCodecSpec | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!spec) return m;
  for (const msg of spec.uplink) {
    for (const r of fieldRows(msg.fields)) {
      if (r.unit) {
        m.set(r.path, r.unit);
        if (!m.has(r.name)) m.set(r.name, r.unit);
      }
    }
  }
  return m;
}

const UNIT_LABEL: Record<string, string> = {
  Cel: "°C",
  "[degF]": "°F",
  "%": "%",
  deg: "°",
  "kW.h": "kWh",
  "W.h": "Wh",
  "m/s": "m/s",
  "km/h": "km/h",
  "dB[mW]": "dBm",
  dBm: "dBm",
  "[ppm]": "ppm",
  hPa: "hPa",
  lx: "lx",
};
export function unitLabel(u: string | undefined) {
  if (!u) return "";
  return UNIT_LABEL[u] ?? u;
}

export function sourceLabel(s: SourceRef | undefined): string | null {
  if (!s) return null;
  const loc = s.sheet && s.cell ? `${s.sheet}!${s.cell}` : s.sheet ?? (s.cell ? s.cell : s.page != null ? `p.${s.page}` : s.row != null ? `row ${s.row}` : null);
  if (!loc && s.confidence == null) return null;
  const conf = s.confidence != null ? `${Math.round(s.confidence * 100)}%` : null;
  return [loc, conf].filter(Boolean).join(" · ");
}
