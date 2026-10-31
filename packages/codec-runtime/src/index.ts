import {
  fromHex,
  parseSpec,
  safeParseSpec,
  toHex,
  type Codec,
  type CodecError,
  type DecodedData,
  type DecodeResult,
  type DeviceCodecSpec,
  type EncodeResult,
  type Field,
  type PayloadContext,
  type VectorResult,
} from "@hash8/dcs-schema";
import { CodecSpecError, compileCodec, topicMatches } from "./compile";

export { checksum, CHECKSUM_BITS, type ChecksumAlgo } from "./checksum";
export { CodecSpecError, topicMatches };

/**
 * Validate (zod) and precompile a DCS into a fast closure-based codec.
 * Throws CodecSpecError (errors[].code === "INVALID_SPEC") for invalid specs.
 */
export function createCodec(spec: DeviceCodecSpec | unknown): Codec {
  const parsed = safeParseSpec(spec);
  if (!parsed.success) {
    throw new CodecSpecError(
      parsed.error.issues.map((i) => ({
        code: "INVALID_SPEC" as const,
        message: `${i.path.join(".") || "(root)"}: ${i.message}`,
        path: i.path.join("."),
      })),
    );
  }
  return compileCodec(parsed.data);
}

const cache = new WeakMap<object, Codec | CodecSpecError>();

function cached(spec: unknown): Codec | CodecSpecError {
  if (spec === null || typeof spec !== "object") {
    return new CodecSpecError([{ code: "INVALID_SPEC", message: "spec must be an object" }]);
  }
  let c = cache.get(spec);
  if (!c) {
    try {
      c = createCodec(spec);
    } catch (e) {
      c = e instanceof CodecSpecError ? e : new CodecSpecError([{ code: "INVALID_SPEC", message: String(e) }]);
    }
    cache.set(spec, c);
  }
  return c;
}

/** Decode an uplink payload (compiled codec cached per spec object). */
export function decode(spec: DeviceCodecSpec | unknown, bytes: Uint8Array, ctx?: PayloadContext): DecodeResult {
  const c = cached(spec);
  if (c instanceof CodecSpecError) return { ok: false, errors: c.errors, warnings: [] };
  return c.decode(bytes, ctx);
}

/** Encode a downlink (or uplink, for simulators) message by name. */
export function encode(spec: DeviceCodecSpec | unknown, message: string, data: DecodedData): EncodeResult {
  const c = cached(spec);
  if (c instanceof CodecSpecError) return { ok: false, errors: c.errors, warnings: [] };
  return c.encode(message, data);
}

/* ------------------------------------------------------------------ */
/* Test vectors                                                        */
/* ------------------------------------------------------------------ */

const TOLERANCE = 1e-9;

function fmt(v: unknown): string {
  return v === undefined ? "undefined" : JSON.stringify(v);
}

function diffValues(expected: unknown, actual: unknown, path: string, out: string[]): void {
  const at = path || "(root)";
  if (typeof expected === "number" && typeof actual === "number") {
    if (expected === actual || Math.abs(expected - actual) <= TOLERANCE || (Number.isNaN(expected) && Number.isNaN(actual))) return;
    out.push(`${at}: expected ${expected}, got ${actual}`);
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) out.push(`${at}: expected ${expected.length} items, got ${actual.length}`);
    const n = Math.min(expected.length, actual.length);
    for (let k = 0; k < n; k++) diffValues(expected[k], actual[k], `${path}[${k}]`, out);
    return;
  }
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  if (isObj(expected) && isObj(actual)) {
    for (const k of Object.keys(expected)) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in actual)) out.push(`${p}: missing (expected ${fmt(expected[k])})`);
      else diffValues(expected[k], actual[k], p, out);
    }
    for (const k of Object.keys(actual)) {
      if (!(k in expected)) out.push(`${path ? `${path}.${k}` : k}: unexpected ${fmt(actual[k])}`);
    }
    return;
  }
  if (expected !== actual) out.push(`${at}: expected ${fmt(expected)}, got ${fmt(actual)}`);
}

function errs(errors: CodecError[]): string[] {
  return errors.map((e) => `${e.code}: ${e.message}`);
}

/** Run every test vector of a spec (decode + round-trip for uplinks, encode for downlinks). */
export function runVectors(spec: DeviceCodecSpec | unknown): VectorResult[] {
  const c = cached(spec);
  if (c instanceof CodecSpecError) {
    return [{ name: "(spec)", pass: false, expected: "valid spec", actual: c.errors, diff: errs(c.errors) }];
  }
  return c.spec.vectors.map((v): VectorResult => {
    let bytes: Uint8Array;
    try {
      bytes = fromHex(v.hex);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { name: v.name, pass: false, expected: v.direction === "downlink" ? v.hex : v.data, actual: null, diff: [msg] };
    }
    const expectedHex = toHex(bytes);

    if (v.direction === "downlink") {
      if (!v.message) {
        return { name: v.name, pass: false, expected: expectedHex, actual: null, diff: ["downlink vector requires `message`"] };
      }
      const r = c.encode(v.message, v.data);
      if (!r.ok) return { name: v.name, pass: false, expected: expectedHex, actual: r.errors, diff: errs(r.errors) };
      const actual = toHex(r.bytes);
      const diff: string[] = [];
      if (actual !== expectedHex) diff.push(`bytes: expected ${expectedHex}, got ${actual}`);
      if (v.port !== undefined && r.port !== v.port) diff.push(`port: expected ${v.port}, got ${r.port}`);
      return { name: v.name, pass: diff.length === 0, expected: expectedHex, actual, ...(diff.length ? { diff } : {}) };
    }

    const ctx: PayloadContext = {};
    if (v.port !== undefined) ctx.port = v.port;
    if (v.topic !== undefined) ctx.topic = v.topic;
    const r = c.decode(bytes, ctx);
    if (!r.ok) return { name: v.name, pass: false, expected: v.data, actual: r.errors, diff: errs(r.errors) };
    const diff: string[] = [];
    if (v.message !== undefined && r.message !== v.message) diff.push(`message: expected ${v.message}, got ${r.message}`);
    diffValues(v.data, r.data, "", diff);
    const rt = c.encode(r.message, r.data);
    if (!rt.ok) diff.push(`round-trip: encode failed: ${errs(rt.errors).join("; ")}`);
    else if (toHex(rt.bytes) !== expectedHex) diff.push(`round-trip: encode produced ${toHex(rt.bytes)}, expected ${expectedHex}`);
    return { name: v.name, pass: diff.length === 0, expected: v.data, actual: r.data, ...(diff.length ? { diff } : {}) };
  });
}

/* ------------------------------------------------------------------ */
/* describeSpec                                                        */
/* ------------------------------------------------------------------ */

export interface DescribedField {
  path: string;
  type: string;
  bits?: number;
  unit?: string;
  description?: string;
}

export interface DescribedMessage {
  name: string;
  direction: "uplink" | "downlink";
  port?: number;
  fields: DescribedField[];
}

export interface SpecDescription {
  messages: DescribedMessage[];
  fieldCount: number;
}

function flatten(fields: Field[], prefix: string, out: DescribedField[], seen: Set<string>): void {
  for (const f of fields) {
    switch (f.kind) {
      case "scalar": {
        if (f.hidden) break;
        const path = prefix + f.name;
        if (seen.has(path)) break;
        seen.add(path);
        const d: DescribedField = { path, type: f.type };
        const bits =
          f.bits ??
          (f.type === "bool" ? 1 : f.type === "float" ? 32 : f.type === "uint" || f.type === "int" ? 8 : typeof f.length === "number" ? f.length * 8 : undefined);
        if (bits !== undefined) d.bits = bits;
        if (f.unit !== undefined) d.unit = f.unit;
        if (f.description !== undefined) d.description = f.description;
        out.push(d);
        break;
      }
      case "group":
        flatten(f.fields, `${prefix}${f.name}.`, out, seen);
        break;
      case "repeat":
        flatten(f.fields, `${prefix}${f.name}[].`, out, seen);
        break;
      case "switch":
        for (const c of Object.values(f.cases)) flatten(c, prefix, out, seen);
        if (f.default) flatten(f.default, prefix, out, seen);
        break;
      default:
        break; // const & checksum are never emitted
    }
  }
}

/** Flattened, UI-friendly listing of every emitted field per message. */
export function describeSpec(spec: DeviceCodecSpec | unknown): SpecDescription {
  const s = parseSpec(spec);
  const messages: DescribedMessage[] = [];
  let fieldCount = 0;
  const add = (direction: "uplink" | "downlink", list: DeviceCodecSpec["uplink"]) => {
    for (const m of list) {
      const fields: DescribedField[] = [];
      flatten(m.fields, "", fields, new Set());
      const p = m.when?.port;
      const port = Array.isArray(p) ? p[0] : p;
      messages.push({ name: m.name, direction, ...(port !== undefined ? { port } : {}), fields });
      fieldCount += fields.length;
    }
  };
  add("uplink", s.uplink);
  add("downlink", s.downlink ?? []);
  return { messages, fieldCount };
}
