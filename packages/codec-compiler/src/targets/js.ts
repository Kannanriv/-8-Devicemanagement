import type { DeviceCodecSpec, Field, MessageDef } from "@hash8/dcs-schema";
import { JS_ENGINE, toJs, toTs } from "../engine-js";
import { blockHeader, cleanHex, runtimeSpec, strLit, vectors, type GeneratedFile } from "../common";

// ------------------------------------------------------------------ ts

function tsType(f: Field, indent: string): string {
  switch (f.kind) {
    case "group":
      return tsObject(f.fields, indent);
    case "repeat":
      return `Array<${tsObject(f.fields, indent)}>`;
    case "scalar": {
      if (f.type === "bool") return "boolean";
      if (f.type === "bytes" || f.type === "string" || f.type === "bcd") return "string";
      if (f.enum) return [...new Set(Object.values(f.enum))].map((l) => strLit(l)).concat("number").join(" | ");
      if ((f.type === "uint" || f.type === "int") && (f.bits ?? 8) > 53) return "number | string";
      return "number";
    }
    default:
      return "never";
  }
}

function tsProps(fields: Field[], indent: string, optional: boolean, out: string[], seen: Set<string>): void {
  for (const f of fields) {
    if (f.kind === "const" || f.kind === "checksum") continue;
    if (f.kind === "switch") {
      for (const c of Object.values(f.cases)) tsProps(c, indent, true, out, seen);
      if (f.default) tsProps(f.default, indent, true, out, seen);
      continue;
    }
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    const opt = optional || (f.kind === "scalar" && (f.hidden || f.default !== undefined));
    const doc = f.description || (f.kind === "scalar" && f.unit) ? `${indent}/** ${[f.description, f.kind === "scalar" && f.unit ? `[${f.unit}]` : ""].filter(Boolean).join(" ").replace(/\*\//g, "* /")} */\n` : "";
    out.push(`${doc}${indent}${f.name}${opt ? "?" : ""}: ${tsType(f, indent + "  ")};`);
  }
}

function tsObject(fields: Field[], indent: string): string {
  const out: string[] = [];
  tsProps(fields, indent, false, out, new Set());
  return out.length ? `{\n${out.join("\n")}\n${indent.slice(2)}}` : "{}";
}

function messageTypes(list: MessageDef[] | undefined, iface: string): string {
  const msgs = list ?? [];
  if (!msgs.length) return `export interface ${iface} {}\n`;
  return `export interface ${iface} {\n${msgs
    .map((m) => `${m.description ? `  /** ${m.description.replace(/\*\//g, "* /")} */\n` : ""}  ${m.name}: ${tsObject(m.fields, "    ")};`)
    .join("\n")}\n}\n`;
}

function tsMain(spec: DeviceCodecSpec): string {
  return `${blockHeader(spec, "TypeScript codec (ES module)")}
// Usage:
//   import { decode, encode } from "./codec";
//   const r = decode(bytes, fPort);          // { ok, message, data, warnings } | { ok: false, errors, warnings }
//   const e = encode("<message>", { ... });  // { ok, bytes, port, warnings }

export type DecodedData = Record<string, unknown>;
export interface CodecError {
  code:
    | "NO_MATCHING_MESSAGE" | "PAYLOAD_TOO_SHORT" | "TRAILING_BYTES" | "CONST_MISMATCH" | "CHECKSUM_MISMATCH"
    | "BAD_REFERENCE" | "ENCODE_MISSING_FIELD" | "ENCODE_OUT_OF_RANGE" | "INVALID_SPEC";
  message: string;
  path?: string;
}
export type DecodeResult<D = DecodedData> =
  | { ok: true; message: string; data: D; warnings: string[] }
  | { ok: false; errors: CodecError[]; warnings: string[] };
export type EncodeResult =
  | { ok: true; bytes: Uint8Array; port?: number; warnings: string[] }
  | { ok: false; errors: CodecError[]; warnings: string[] };

${messageTypes(spec.uplink, "UplinkMessages")}
${messageTypes(spec.downlink, "DownlinkMessages")}
export type MessageName = keyof UplinkMessages | keyof DownlinkMessages;
export type MessageData<M extends MessageName> = M extends keyof DownlinkMessages
  ? DownlinkMessages[M]
  : M extends keyof UplinkMessages
    ? UplinkMessages[M]
    : never;

export const CODEC_ID = ${strLit(spec.id)};
export const CODEC_VERSION = ${strLit(spec.version)};

/** The Device Codec Spec this codec interprets (layout + semantics). */
const SPEC: any = ${JSON.stringify(runtimeSpec(spec), null, 2)};

/** Decode an uplink payload. \`port\` (LoRaWAN fPort) and \`topic\` (MQTT) select the message. */
export function decode(bytes: Uint8Array | ArrayLike<number>, port?: number, topic?: string): DecodeResult {
  return dcsDecode(SPEC, bytes, port, topic, "uplink");
}

/** Decode a downlink payload (e.g. to display queued commands). */
export function decodeDownlink(bytes: Uint8Array | ArrayLike<number>, port?: number): DecodeResult {
  return dcsDecode(SPEC, bytes, port, undefined, "downlink");
}

/** Encode a message (downlinks first, then uplinks — useful for simulators). */
export function encode<M extends MessageName>(message: M, data: MessageData<M>): EncodeResult;
export function encode(message: string, data: DecodedData): EncodeResult;
export function encode(message: string, data: unknown): EncodeResult {
  return dcsEncode(SPEC, message, data);
}

// ---------------------------------------------------------------------------
// Interpreter (normative semantics: DCS v1). Generated — do not edit.
// ---------------------------------------------------------------------------
${toTs(JS_ENGINE)}`;
}

function tsTest(spec: DeviceCodecSpec): string {
  return `${blockHeader(spec, "TypeScript codec test vectors")}
// Run: npx tsx codec.test.ts
import { decode, encode } from "./codec";

declare const console: { log(...a: unknown[]): void };

type Vector = { name: string; direction: string; port?: number; topic?: string; hex: string; message?: string; data: Record<string, unknown> };
const VECTORS: Vector[] = ${JSON.stringify(vectors(spec).map((v) => ({ ...v, hex: cleanHex(v.hex) })), null, 2)};

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function same(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && typeof a === "object") {
    if (!b || typeof b !== "object") return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => same((a as any)[k], (b as any)[k]));
  }
  return a === b;
}

let failed = 0;
for (const v of VECTORS) {
  let ok = false;
  if (v.direction === "downlink") {
    const r = encode(v.message ?? "", v.data);
    ok = r.ok && toHex(r.bytes) === v.hex;
  } else {
    const r = decode(hexToBytes(v.hex), v.port, v.topic);
    ok = r.ok && (!v.message || r.message === v.message) && same(v.data, r.data);
    if (r.ok) {
      const back = encode(r.message, r.data);
      ok = ok && back.ok && toHex(back.bytes) === v.hex;
    }
  }
  console.log(\`\${ok ? "ok  " : "FAIL"} \${v.name}\`);
  if (!ok) failed++;
}
if (failed) throw new Error(\`\${failed} vector(s) failed\`);
`;
}

export function generateTs(spec: DeviceCodecSpec): GeneratedFile[] {
  return [
    { path: "ts/codec.ts", content: tsMain(spec) },
    { path: "ts/codec.test.ts", content: tsTest(spec) },
  ];
}

// ------------------------------------------------------------------ ts013

function ts013Main(spec: DeviceCodecSpec): string {
  const downs = (spec.downlink ?? []).map((m) => m.name);
  return `${blockHeader(spec, "LoRaWAN TS013 payload codec (TTN / ChirpStack)")}
// Paste this file as a "Custom JavaScript formatter" in The Things Stack or as the
// device-profile codec in ChirpStack v4. Plain ES5/ES2015 JavaScript, no dependencies.
//   decodeUplink({ bytes, fPort })               -> { data, warnings, errors }
//   encodeDownlink({ data: { message, ... } })   -> { bytes, fPort, warnings, errors }
//   decodeDownlink({ bytes, fPort })             -> { data, warnings, errors }

var DCS_SPEC = ${JSON.stringify(runtimeSpec(spec), null, 2)};

function dcsErrors(r) {
  var out = [];
  for (var i = 0; i < r.errors.length; i++) out.push(r.errors[i].code + ": " + r.errors[i].message);
  return out;
}

function decodeUplink(input) {
  var r = dcsDecode(DCS_SPEC, input.bytes, input.fPort, undefined, "uplink");
  if (r.ok) return { data: r.data, warnings: r.warnings, errors: [] };
  return { warnings: r.warnings, errors: dcsErrors(r) };
}

function decodeDownlink(input) {
  var r = dcsDecode(DCS_SPEC, input.bytes, input.fPort, undefined, "downlink");
  if (r.ok) return { data: r.data, warnings: r.warnings, errors: [] };
  return { warnings: r.warnings, errors: dcsErrors(r) };
}

function encodeDownlink(input) {
  var data = (input && input.data) || {};
  var message = data.message;
  if (!message) message = ${downs.length === 1 ? strLit(downs[0]!) : "undefined"};
  if (!message) return { warnings: [], errors: ["ENCODE_MISSING_FIELD: data.message is required (one of: ${downs.join(", ")})"] };
  var payload = {};
  for (var k in data) if (k !== "message" && Object.prototype.hasOwnProperty.call(data, k)) payload[k] = data[k];
  var r = dcsEncode(DCS_SPEC, message, payload);
  if (!r.ok) return { warnings: r.warnings, errors: dcsErrors(r) };
  var bytes = [];
  for (var i = 0; i < r.bytes.length; i++) bytes.push(r.bytes[i]);
  return { bytes: bytes, fPort: r.port != null ? r.port : input.fPort, warnings: r.warnings, errors: [] };
}

// ---------------------------------------------------------------------------
// Interpreter (normative semantics: DCS v1). Generated — do not edit.
// ---------------------------------------------------------------------------
${toJs(JS_ENGINE)}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { decodeUplink: decodeUplink, decodeDownlink: decodeDownlink, encodeDownlink: encodeDownlink };
}
`;
}

function ts013Test(spec: DeviceCodecSpec): string {
  return `${blockHeader(spec, "TS013 codec test vectors")}
// Run: node codec.test.js
var codec = require("./codec.js");
var VECTORS = ${JSON.stringify(vectors(spec).map((v) => ({ ...v, hex: cleanHex(v.hex) })), null, 2)};

function hexToBytes(h) { var o = []; for (var i = 0; i < h.length; i += 2) o.push(parseInt(h.substr(i, 2), 16)); return o; }
function toHex(b) { var s = ""; for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16); return s; }
function same(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  if (Array.isArray(a)) { if (!Array.isArray(b) || a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false; return true; }
  if (a && typeof a === "object") {
    if (!b || typeof b !== "object") return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var j = 0; j < ka.length; j++) if (!same(a[ka[j]], b[ka[j]])) return false;
    return true;
  }
  return a === b;
}
var failed = 0;
VECTORS.forEach(function (v) {
  var ok;
  if (v.direction === "downlink") {
    var data = { message: v.message };
    for (var k in v.data) data[k] = v.data[k];
    var e = codec.encodeDownlink({ data: data });
    ok = e.errors.length === 0 && toHex(e.bytes) === v.hex;
  } else {
    var r = codec.decodeUplink({ bytes: hexToBytes(v.hex), fPort: v.port });
    ok = r.errors.length === 0 && same(v.data, r.data);
  }
  console.log((ok ? "ok   " : "FAIL ") + v.name);
  if (!ok) failed++;
});
if (failed) { console.error(failed + " vector(s) failed"); process.exit(1); }
`;
}

export function generateTs013(spec: DeviceCodecSpec): GeneratedFile[] {
  return [
    { path: "ts013/codec.js", content: ts013Main(spec) },
    { path: "ts013/codec.test.js", content: ts013Test(spec) },
  ];
}
