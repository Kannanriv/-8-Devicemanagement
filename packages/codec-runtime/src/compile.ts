import type {
  ChecksumField,
  Codec,
  CodecError,
  ConstField,
  DecodedData,
  DecodeResult,
  DeviceCodecSpec,
  EncodeResult,
  Endian,
  Field,
  GroupField,
  MessageDef,
  PayloadContext,
  RepeatField,
  ScalarField,
  SwitchField,
} from "@hash8/dcs-schema";
import { BitWriter, floatBytes, makeUintReader, readBig, readBitsBE, readFloat } from "./bits";
import { CHECKSUM_BITS, checksum } from "./checksum";
import { roundTo } from "./round";

/* ------------------------------------------------------------------ */
/* Runtime state                                                       */
/* ------------------------------------------------------------------ */

/**
 * Raw-value scope (for ref/switch resolution). Explicit parent links instead of prototype
 * chains: per-decode Object.create(parent) forces costly V8 prototype transitions.
 * Only names that some ref/on mentions are ever written (see Ctx.refs).
 */
interface Scope {
  v: Record<string, unknown>;
  p: Scope | null;
}

function childScope(parent: Scope, key: string | null): Scope {
  const r: Scope = { v: {}, p: parent };
  if (key !== null) parent.v[key] = r;
  return r;
}
const rootScope = (): Scope => ({ v: {}, p: null });
type Obj = Record<string, unknown>;

interface DState {
  buf: Uint8Array;
  pos: number;
  end: number;
  warnings: string[];
  root: Scope;
}

interface EState {
  w: BitWriter;
  rootObj: Obj;
  errors: CodecError[];
  warnings: string[];
  root: Scope;
}

type DecFn = (st: DState, out: Obj, raw: Scope, prefix: string) => void;
type EncFn = (st: EState, obj: Obj, raw: Scope, prefix: string) => void;

/** Thrown to abort decoding a candidate message. */
class Fail {
  constructor(readonly error: CodecError) {}
}

function fail(code: CodecError["code"], message: string, path?: string): never {
  throw new Fail(path === undefined ? { code, message } : { code, message, path });
}

/** Spec is structurally valid (zod) but semantically unusable. */
export class CodecSpecError extends Error {
  constructor(readonly errors: CodecError[]) {
    super(errors.map((e) => e.message).join("; "));
    this.name = "CodecSpecError";
  }
}

const TWO53 = 2 ** 53;
const BIG_TWO53 = 2n ** 53n;
const utf8Dec = new TextDecoder("utf-8");
const utf8Enc = new TextEncoder();

/* ------------------------------------------------------------------ */
/* Compile-time scope (for encode auto-count of repeat {ref})          */
/* ------------------------------------------------------------------ */

interface ScalarNode {
  /** Where to find the repeat array whose length auto-fills this count field: relative to the field's object, or absolute from the message root. */
  autoCount?: { fromRoot: boolean; keys: string[] };
}

interface CScope {
  parent?: CScope;
  /** Key of this scope's object inside the parent object (groups); undefined for repeat items. */
  key?: string;
  item: boolean;
  scalars: Map<string, { node: ScalarNode; scope: CScope }>;
  groups: Map<string, CScope>;
}

function newScope(parent?: CScope, key?: string, item = false): CScope {
  return { parent, key, item, scalars: new Map(), groups: new Map() };
}

/** Relative key path from `from` (an ancestor) down to `to`, or undefined if not reachable through groups only. */
function relPath(from: CScope, to: CScope): string[] | undefined {
  const keys: string[] = [];
  let s: CScope | undefined = to;
  while (s && s !== from) {
    if (s.item || s.key === undefined) return undefined;
    keys.unshift(s.key);
    s = s.parent;
  }
  return s === from ? keys : undefined;
}

/* ------------------------------------------------------------------ */
/* Reference resolution                                                */
/* ------------------------------------------------------------------ */

type Resolver = (raw: Scope, root: Scope) => unknown;

function makeResolver(ref: string): Resolver {
  const parts = ref.split(".");
  if (parts.length === 1) {
    const name = parts[0]!;
    return (raw) => {
      for (let s: Scope | null = raw; s !== null; s = s.p) if (Object.hasOwn(s.v, name)) return s.v[name];
      return undefined;
    };
  }
  return (_raw, root) => {
    let cur: Scope = root;
    for (let k = 0; k < parts.length - 1; k++) {
      const next = Object.hasOwn(cur.v, parts[k]!) ? cur.v[parts[k]!] : undefined;
      if (next === null || typeof next !== "object") return undefined;
      cur = next as Scope;
    }
    const last = parts[parts.length - 1]!;
    return Object.hasOwn(cur.v, last) ? cur.v[last] : undefined;
  };
}

/* ------------------------------------------------------------------ */
/* Semantic pipeline                                                   */
/* ------------------------------------------------------------------ */

type Post = (r: number | string, st: DState, prefix: string) => unknown;

function makePost(f: ScalarField): Post {
  const name = f.name;
  const en = f.enum ? new Map(Object.entries(f.enum)) : undefined;
  const scale = f.scale ?? 1;
  const offset = f.offset ?? 0;
  const hasLinear = f.scale !== undefined || f.offset !== undefined;
  const decimals = f.decimals;
  const round10 = decimals === undefined && (!Number.isInteger(scale) || !Number.isInteger(offset));
  const min = f.min;
  const max = f.max;
  const hasRange = min !== undefined || max !== undefined;
  const lo = min ?? -Infinity;
  const hi = max ?? Infinity;

  if (!en && !hasLinear && decimals === undefined && !hasRange) return (r) => r;

  return (r, st, prefix) => {
    if (en) {
      const label = en.get(String(r));
      if (label !== undefined) return label;
      st.warnings.push(`${prefix}${name}: unknown enum value ${r}`);
      return r;
    }
    let v: number | string = r;
    if (hasLinear || decimals !== undefined) {
      let n = (typeof r === "string" ? Number(r) : r) * scale + offset;
      if (decimals !== undefined) n = roundTo(n, decimals);
      else if (round10) n = roundTo(n, 10);
      v = n;
    }
    if (hasRange) {
      const n = typeof v === "string" ? Number(v) : v;
      if (n < lo || n > hi) st.warnings.push(`${prefix}${name}: value ${v} outside [${lo},${hi}]`);
    }
    return v;
  };
}

/** Inverse pipeline: physical value -> raw integer (number or bigint), or an error message. */
function makeInverse(f: ScalarField, wide: boolean): (v: unknown) => number | bigint | string {
  const rev = new Map<string, number>();
  if (f.enum) for (const [k, label] of Object.entries(f.enum)) rev.set(label, Number(k));
  const hasEnum = f.enum !== undefined;
  const scale = f.scale ?? 1;
  const offset = f.offset ?? 0;
  const linear = f.scale !== undefined || f.offset !== undefined;
  return (v) => {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") {
      const r = rev.get(v);
      if (r !== undefined) return r;
      if (!/^-?\d+$/.test(v.trim())) return hasEnum ? `unknown enum label "${v}"` : `not a number: "${v}"`;
      if (wide && !linear) return BigInt(v.trim());
      v = Number(v);
    }
    if (typeof v !== "number" || !Number.isFinite(v)) return `not a finite number: ${JSON.stringify(v)}`;
    if (hasEnum) {
      if (!Number.isInteger(v)) return `non-integer raw value ${v} for enum field`;
      return v;
    }
    return linear ? Math.round((v - offset) / scale) : Math.round(v);
  };
}

/* ------------------------------------------------------------------ */
/* Field compilation                                                   */
/* ------------------------------------------------------------------ */

interface CompiledList {
  dec: DecFn;
  enc: EncFn;
}

interface Ctx {
  endian: Endian;
  /** Every name mentioned by a repeat {ref} or switch `on` (all dot-path segments). */
  refs: Set<string>;
  specErrors: CodecError[];
}

function runAllDec(fns: DecFn[]): DecFn {
  if (fns.length === 1) return fns[0]!;
  return (st, out, raw, prefix) => {
    for (let k = 0; k < fns.length; k++) fns[k]!(st, out, raw, prefix);
  };
}
function runAllEnc(fns: EncFn[]): EncFn {
  return (st, obj, raw, prefix) => {
    for (let k = 0; k < fns.length; k++) fns[k]!(st, obj, raw, prefix);
  };
}

function collectRefs(fields: Field[], out: Set<string>): void {
  for (const f of fields) {
    if (f.kind === "group") collectRefs(f.fields, out);
    else if (f.kind === "repeat") {
      if (typeof f.count === "object") for (const p of f.count.ref.split(".")) out.add(p);
      collectRefs(f.fields, out);
    } else if (f.kind === "switch") {
      for (const p of f.on.split(".")) out.add(p);
      for (const c of Object.values(f.cases)) collectRefs(c, out);
      if (f.default) collectRefs(f.default, out);
    }
  }
}

/** Does decoding this list write any referenced raw value (so it needs its own scope)? */
function writesRaw(fields: Field[], refs: Set<string>): boolean {
  for (const f of fields) {
    if ((f.kind === "scalar" || f.kind === "const") && refs.has(f.name)) return true;
    if ((f.kind === "group" || f.kind === "repeat") && writesRaw(f.fields, refs)) return true;
    if (f.kind === "switch" && (Object.values(f.cases).some((c) => writesRaw(c, refs)) || (f.default !== undefined && writesRaw(f.default, refs)))) return true;
  }
  return false;
}

function fieldWidthIfChecksum(f: Field): number | undefined {
  return f.kind === "checksum" ? CHECKSUM_BITS[f.algo] : undefined;
}

/**
 * Compile a field list. `tailReserve` = bits of trailing checksum(s) that follow this list
 * in enclosing lists, excluded from "remaining".
 */
function compileList(fields: Field[], ctx: Ctx, scope: CScope, tailReserve: number, path: string): CompiledList {
  // reserve[i] = tailReserve + width of the trailing checksum block after field i
  const reserve: number[] = new Array(fields.length).fill(tailReserve);
  let block = 0;
  let inBlock = true;
  for (let k = fields.length - 1; k >= 0; k--) {
    reserve[k] = tailReserve + block;
    const w = fieldWidthIfChecksum(fields[k]!);
    if (inBlock && w !== undefined) block += w;
    else inBlock = false;
  }
  const dec: DecFn[] = [];
  const enc: EncFn[] = [];
  fields.forEach((f, k) => {
    const c = compileField(f, ctx, scope, reserve[k]!, path);
    dec.push(c.dec);
    enc.push(c.enc);
  });
  return { dec: dec.length ? runAllDec(dec) : () => {}, enc: runAllEnc(enc) };
}

function compileField(f: Field, ctx: Ctx, scope: CScope, reserve: number, path: string): CompiledList {
  switch (f.kind) {
    case "scalar":
      return compileScalar(f, ctx, scope, reserve, path);
    case "const":
      return compileConst(f, ctx, scope, path);
    case "checksum":
      return compileChecksum(f, ctx, path);
    case "group":
      return compileGroup(f, ctx, scope, reserve, path);
    case "repeat":
      return compileRepeat(f, ctx, scope, reserve, path);
    case "switch":
      return compileSwitch(f, ctx, scope, reserve, path);
    default:
      ctx.specErrors.push({ code: "INVALID_SPEC", message: `unknown field kind at ${path}`, path });
      return { dec: () => {}, enc: () => {} };
  }
}

function tooShort(st: DState, prefix: string, name: string, bits: number): never {
  return fail(
    "PAYLOAD_TOO_SHORT",
    `payload too short reading ${prefix}${name}: need ${bits} bits at bit ${st.pos}, payload has ${st.end} bits`,
    prefix + name,
  );
}

function compileScalar(f: ScalarField, ctx: Ctx, scope: CScope, reserve: number, path: string): CompiledList {
  const name = f.name;
  const fpath = path + name;
  const little = (f.endian ?? ctx.endian) === "little";
  const hidden = f.hidden === true;
  const node: ScalarNode = {};
  scope.scalars.set(name, { node, scope });
  const keep = ctx.refs.has(name);

  const type = f.type;
  if (type === "uint" || type === "int" || type === "bool") {
    const bits = f.bits ?? (type === "bool" ? 1 : 8);
    const signed = type === "int";
    const wide = bits > 48;
    const post = type === "bool" ? null : makePost(f);
    const read = wide ? null : makeUintReader(bits, little);
    const half = 2 ** (bits - 1);
    const full = 2 ** bits;
    const bigFull = 1n << BigInt(bits);
    const bigHalf = 1n << BigInt(bits - 1);

    const dec: DecFn = (st, out, raw, prefix) => {
      const p = st.pos;
      if (p + bits > st.end) tooShort(st, prefix, name, bits);
      st.pos = p + bits;
      let r: number | string;
      let rn: number;
      if (read) {
        rn = read(st.buf, p);
        if (signed && rn >= half) rn -= full;
        r = rn;
      } else {
        let b = readBig(st.buf, p, bits, little);
        if (signed && b >= bigHalf) b -= bigFull;
        rn = Number(b);
        r = b > BIG_TWO53 || b < -BIG_TWO53 ? b.toString() : rn;
      }
      if (keep) raw.v[name] = rn;
      if (hidden) return;
      out[name] = post === null ? rn !== 0 : post(r, st, prefix);
    };

    const inverse = type === "bool" ? null : makeInverse(f, wide);
    const minRaw = signed ? -half : 0;
    const maxRaw = signed ? half - 1 : full - 1;
    const enc: EncFn = (st, obj, raw, prefix) => {
      let v = obj[name];
      let r: number | bigint | string | undefined;
      if (v === undefined || v === null) {
        if (node.autoCount) {
          let cur: unknown = node.autoCount.fromRoot ? st.rootObj : obj;
          for (const k of node.autoCount.keys) cur = cur && typeof cur === "object" ? (cur as Obj)[k] : undefined;
          if (Array.isArray(cur)) r = cur.length;
        }
        if (r === undefined) {
          if (f.default !== undefined) v = f.default;
          else if (hidden) r = 0;
          else {
            st.errors.push({ code: "ENCODE_MISSING_FIELD", message: `missing field ${prefix}${name}`, path: prefix + name });
            r = 0;
          }
        }
      }
      if (r === undefined) {
        if (inverse === null) r = v === true || (typeof v === "number" && v !== 0) || v === "true" ? 1 : 0;
        else r = inverse(v);
      }
      if (typeof r === "string") {
        st.errors.push({ code: "ENCODE_OUT_OF_RANGE", message: `${prefix}${name}: ${r}`, path: prefix + name });
        r = 0;
      }
      if (wide) {
        let b = typeof r === "bigint" ? r : BigInt(r);
        if (b < (signed ? -bigHalf : 0n) || b > (signed ? bigHalf - 1n : bigFull - 1n)) {
          st.errors.push({ code: "ENCODE_OUT_OF_RANGE", message: `${prefix}${name}: raw ${b} does not fit ${type}${bits}`, path: prefix + name });
          b = 0n;
        }
        if (keep) raw.v[name] = Number(b);
        st.w.writeBig(b < 0n ? b + bigFull : b, bits, little);
      } else {
        let n = Number(r);
        if (n < minRaw || n > maxRaw) {
          st.errors.push({ code: "ENCODE_OUT_OF_RANGE", message: `${prefix}${name}: raw ${n} does not fit ${type}${bits}`, path: prefix + name });
          n = 0;
        }
        if (keep) raw.v[name] = n;
        st.w.writeUint(n < 0 ? n + full : n, bits, little);
      }
    };
    return { dec, enc };
  }

  if (type === "float") {
    const bits = f.bits ?? 32;
    if (bits !== 32 && bits !== 64) {
      ctx.specErrors.push({ code: "INVALID_SPEC", message: `${fpath}: float bits must be 32 or 64`, path: fpath });
    }
    const fb = bits === 64 ? 64 : 32;
    const post = makePost(f);
    const scale = f.scale ?? 1;
    const offset = f.offset ?? 0;
    const dec: DecFn = (st, out, raw, prefix) => {
      const p = st.pos;
      if ((p & 7) !== 0) fail("INVALID_SPEC", `${prefix}${name}: float must be byte-aligned`, prefix + name);
      if (p + fb > st.end) tooShort(st, prefix, name, fb);
      const r = readFloat(st.buf, p >> 3, fb, little);
      st.pos = p + fb;
      if (keep) raw.v[name] = r;
      if (!hidden) out[name] = post(r, st, prefix);
    };
    const enc: EncFn = (st, obj, raw, prefix) => {
      let v = obj[name];
      if (v === undefined || v === null) {
        if (f.default !== undefined) v = f.default;
        else if (hidden) v = 0;
        else {
          st.errors.push({ code: "ENCODE_MISSING_FIELD", message: `missing field ${prefix}${name}`, path: prefix + name });
          v = 0;
        }
      }
      const cand = typeof v === "string" ? Number(v) : v;
      let n = 0;
      if (typeof cand !== "number" || Number.isNaN(cand)) {
        st.errors.push({ code: "ENCODE_OUT_OF_RANGE", message: `${prefix}${name}: not a number`, path: prefix + name });
      } else n = cand;
      const r = (n - offset) / scale;
      if ((st.w.pos & 7) !== 0) {
        st.errors.push({ code: "INVALID_SPEC", message: `${prefix}${name}: float must be byte-aligned`, path: prefix + name });
        return;
      }
      if (keep) raw.v[name] = r;
      st.w.writeBytes(floatBytes(r, fb, little));
    };
    return { dec, enc };
  }

  // byte-sized: bytes / string / bcd
  const length = f.length;
  if (length === undefined) {
    ctx.specErrors.push({ code: "INVALID_SPEC", message: `${fpath}: ${type} requires length`, path: fpath });
  }
  const fixed = typeof length === "number" ? length : -1;
  const convert: (b: Uint8Array) => string =
    type === "bytes"
      ? (b) => {
          let s = "";
          for (let k = 0; k < b.length; k++) s += HEX[b[k]!];
          return s;
        }
      : type === "string"
        ? (b) => {
            let e = b.length;
            while (e > 0 && b[e - 1] === 0) e--;
            return utf8Dec.decode(b.subarray(0, e));
          }
        : (b) => {
            let s = "";
            for (let k = 0; k < b.length; k++) {
              const hi = b[k]! >> 4;
              const lo = b[k]! & 15;
              if (hi !== 15) s += hi.toString(16);
              if (lo !== 15) s += lo.toString(16);
            }
            return s;
          };

  const dec: DecFn = (st, out, raw, prefix) => {
    const p = st.pos;
    if ((p & 7) !== 0) fail("INVALID_SPEC", `${prefix}${name}: ${type} must be byte-aligned`, prefix + name);
    let nbits: number;
    if (fixed >= 0) {
      nbits = fixed * 8;
      if (p + nbits > st.end) tooShort(st, prefix, name, nbits);
    } else {
      nbits = st.end - reserve - p;
      if (nbits < 0) tooShort(st, prefix, name, reserve);
      nbits -= nbits & 7;
    }
    const i = p >> 3;
    const v = convert(st.buf.subarray(i, i + (nbits >> 3)));
    st.pos = p + nbits;
    if (keep) raw.v[name] = v;
    if (!hidden) out[name] = v;
  };

  const toBytes: (v: unknown) => Uint8Array | string =
    type === "bytes"
      ? (v) => {
          if (typeof v !== "string") return "expected hex string";
          const clean = v.replace(/^0x/i, "").replace(/[\s:-]/g, "");
          if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) return `invalid hex "${v}"`;
          const out = new Uint8Array(clean.length / 2);
          for (let k = 0; k < out.length; k++) out[k] = parseInt(clean.slice(k * 2, k * 2 + 2), 16);
          if (fixed >= 0 && out.length !== fixed) return `expected ${fixed} bytes, got ${out.length}`;
          return out;
        }
      : type === "string"
        ? (v) => {
            const b = utf8Enc.encode(String(v));
            if (fixed < 0) return b;
            if (b.length > fixed) return `string of ${b.length} bytes exceeds length ${fixed}`;
            const out = new Uint8Array(fixed);
            out.set(b);
            return out;
          }
        : (v) => {
            const s = String(v);
            if (!/^\d*$/.test(s)) return `bcd value must be digits, got "${s}"`;
            const nNib = fixed >= 0 ? fixed * 2 : s.length + (s.length & 1);
            if (s.length > nNib) return `bcd value of ${s.length} digits exceeds ${nNib}`;
            const out = new Uint8Array(nNib / 2);
            for (let k = 0; k < nNib; k++) {
              const d = k < s.length ? s.charCodeAt(k) - 48 : 15;
              out[k >> 1]! |= k & 1 ? d : d << 4;
            }
            return out;
          };

  const enc: EncFn = (st, obj, raw, prefix) => {
    let v = obj[name];
    if (v === undefined || v === null) {
      if (f.default !== undefined) v = f.default;
      else if (hidden) v = type === "bytes" ? "00".repeat(Math.max(fixed, 0)) : "";
      else {
        st.errors.push({ code: "ENCODE_MISSING_FIELD", message: `missing field ${prefix}${name}`, path: prefix + name });
        return;
      }
    }
    const b = toBytes(v);
    if (typeof b === "string") {
      st.errors.push({ code: "ENCODE_OUT_OF_RANGE", message: `${prefix}${name}: ${b}`, path: prefix + name });
      return;
    }
    if ((st.w.pos & 7) !== 0) {
      st.errors.push({ code: "INVALID_SPEC", message: `${prefix}${name}: ${type} must be byte-aligned`, path: prefix + name });
      return;
    }
    if (keep) raw.v[name] = v;
    st.w.writeBytes(b);
  };
  return { dec, enc };
}

const HEX: string[] = Array.from({ length: 256 }, (_, k) => k.toString(16).padStart(2, "0"));

function compileConst(f: ConstField, ctx: Ctx, scope: CScope, path: string): CompiledList {
  const { name, bits, value } = f;
  const little = (f.endian ?? ctx.endian) === "little";
  const wide = bits > 48;
  const read = wide ? null : makeUintReader(bits, little);
  const bigValue = BigInt(value);
  scope.scalars.set(name, { node: {}, scope });
  const keep = ctx.refs.has(name);
  if (value < 0 || bigValue >= 1n << BigInt(bits)) {
    ctx.specErrors.push({ code: "INVALID_SPEC", message: `${path}${name}: const ${value} does not fit uint${bits}`, path: path + name });
  }
  const dec: DecFn = (st, _out, raw, prefix) => {
    const p = st.pos;
    if (p + bits > st.end) tooShort(st, prefix, name, bits);
    st.pos = p + bits;
    const ok = read ? read(st.buf, p) === value : readBig(st.buf, p, bits, little) === bigValue;
    if (!ok) {
      const got = read ? read(st.buf, p) : readBig(st.buf, p, bits, little);
      fail("CONST_MISMATCH", `${prefix}${name}: expected 0x${value.toString(16)}, got 0x${got.toString(16)}`, prefix + name);
    }
    if (keep) raw.v[name] = value;
  };
  const enc: EncFn = (st, _obj, raw) => {
    if (wide) st.w.writeBig(bigValue, bits, little);
    else st.w.writeUint(value, bits, little);
    if (keep) raw.v[name] = value;
  };
  return { dec, enc };
}

function compileChecksum(f: ChecksumField, ctx: Ctx, path: string): CompiledList {
  const { name, algo } = f;
  const bits = CHECKSUM_BITS[algo];
  const little = (f.endian ?? ctx.endian) === "little";
  const read = makeUintReader(bits, little);
  void path;
  const dec: DecFn = (st, _out, _raw, prefix) => {
    const p = st.pos;
    if ((p & 7) !== 0) fail("INVALID_SPEC", `${prefix}${name}: checksum must be byte-aligned`, prefix + name);
    if (p + bits > st.end) tooShort(st, prefix, name, bits);
    const got = read(st.buf, p);
    const want = checksum(algo, st.buf, 0, p >> 3);
    if (got !== want) {
      fail("CHECKSUM_MISMATCH", `${prefix}${name}: ${algo} expected 0x${want.toString(16)}, got 0x${got.toString(16)}`, prefix + name);
    }
    st.pos = p + bits;
  };
  const enc: EncFn = (st, _obj, _raw, prefix) => {
    if ((st.w.pos & 7) !== 0) {
      st.errors.push({ code: "INVALID_SPEC", message: `${prefix}${name}: checksum must be byte-aligned`, path: prefix + name });
      return;
    }
    st.w.writeUint(checksum(algo, st.w.buf, 0, st.w.pos >> 3), bits, little);
  };
  return { dec, enc };
}

function compileGroup(f: GroupField, ctx: Ctx, scope: CScope, reserve: number, path: string): CompiledList {
  const name = f.name;
  const sub = newScope(scope, name);
  scope.groups.set(name, sub);
  const inner = compileList(f.fields, ctx, sub, reserve, path + name + ".");
  const own = writesRaw(f.fields, ctx.refs);
  const dec: DecFn = (st, out, raw, prefix) => {
    const o: Obj = {};
    const r = own ? childScope(raw, name) : raw;
    inner.dec(st, o, r, prefix + name + ".");
    out[name] = o;
  };
  const enc: EncFn = (st, obj, raw, prefix) => {
    const v = obj[name];
    const o = v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
    const r = own ? childScope(raw, name) : raw;
    inner.enc(st, o, r, prefix + name + ".");
  };
  return { dec, enc };
}

function badRef(prefix: string, name: string, ref: string, v: unknown): never {
  return fail("BAD_REFERENCE", `${prefix}${name}: reference "${ref}" did not resolve to a usable value (got ${String(v)})`, prefix + name);
}

function resolveCompileRef(ref: string, scope: CScope): { node: ScalarNode; scope: CScope } | undefined {
  const parts = ref.split(".");
  if (parts.length === 1) {
    for (let s: CScope | undefined = scope; s; s = s.parent) {
      const hit = s.scalars.get(ref);
      if (hit) return hit;
    }
    return undefined;
  }
  let root = scope;
  while (root.parent) root = root.parent;
  let s: CScope | undefined = root;
  for (const p of parts.slice(0, -1)) s = s?.groups.get(p);
  return s?.scalars.get(parts[parts.length - 1]!);
}

function compileRepeat(f: RepeatField, ctx: Ctx, scope: CScope, reserve: number, path: string): CompiledList {
  const name = f.name;
  const itemScope = newScope(scope, undefined, true);
  const inner = compileList(f.fields, ctx, itemScope, reserve, path + name + "[].");
  const own = writesRaw(f.fields, ctx.refs);
  const count = f.count;
  const resolver = typeof count === "object" ? makeResolver(count.ref) : null;
  const refName = typeof count === "object" ? count.ref : "";

  if (typeof count === "object") {
    // encode: auto-set the count field from the array length when omitted
    const target = resolveCompileRef(count.ref, scope);
    if (target) {
      const rel = relPath(target.scope, scope);
      let root = scope;
      while (root.parent) root = root.parent;
      const abs = rel ? undefined : relPath(root, scope);
      if (rel) target.node.autoCount = { fromRoot: false, keys: [...rel, name] };
      else if (abs) target.node.autoCount = { fromRoot: true, keys: [...abs, name] };
    }
  }

  // Cache "name[i]." path prefixes: the base is almost always the same string.
  let cachedBase = "";
  let cachedPrefixes: string[] = [];
  const itemPrefix = (base: string, idx: number): string => {
    if (base !== cachedBase) {
      cachedBase = base;
      cachedPrefixes = [];
    }
    return (cachedPrefixes[idx] ??= `${base}[${idx}].`);
  };

  const decItem = (st: DState, arr: Obj[], raw: Scope, base: string, idx: number) => {
    const o: Obj = {};
    inner.dec(st, o, own ? childScope(raw, null) : raw, itemPrefix(base, idx));
    arr.push(o);
  };

  const dec: DecFn = (st, out, raw, prefix) => {
    const arr: Obj[] = [];
    const base = prefix + name;
    if (typeof count === "number") {
      for (let k = 0; k < count; k++) decItem(st, arr, raw, base, k);
    } else if (resolver) {
      const n = resolver(raw, st.root);
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) badRef(prefix, name, refName, n);
      for (let k = 0; k < n; k++) decItem(st, arr, raw, base, k);
    } else {
      const limit = st.end - reserve;
      let k = 0;
      while (limit - st.pos >= 8) {
        const before = st.pos;
        decItem(st, arr, raw, base, k++);
        if (st.pos === before) break;
      }
    }
    out[name] = arr;
  };

  const enc: EncFn = (st, obj, raw, prefix) => {
    const arr = obj[name];
    if (!Array.isArray(arr)) {
      st.errors.push({ code: "ENCODE_MISSING_FIELD", message: `missing array ${prefix}${name}`, path: prefix + name });
      return;
    }
    if (typeof count === "number" && arr.length !== count) {
      st.errors.push({ code: "ENCODE_OUT_OF_RANGE", message: `${prefix}${name}: expected ${count} items, got ${arr.length}`, path: prefix + name });
      return;
    }
    if (resolver) {
      const n = resolver(raw, st.root);
      if (typeof n !== "number") {
        st.errors.push({ code: "BAD_REFERENCE", message: `${prefix}${name}: reference "${refName}" did not resolve`, path: prefix + name });
        return;
      }
      if (n !== arr.length) {
        st.errors.push({
          code: "ENCODE_OUT_OF_RANGE",
          message: `${prefix}${name}: count field "${refName}" is ${n} but array has ${arr.length} items`,
          path: prefix + name,
        });
        return;
      }
    }
    const base = prefix + name;
    for (let k = 0; k < arr.length; k++) {
      const it = arr[k];
      const o = it !== null && typeof it === "object" ? (it as Obj) : {};
      inner.enc(st, o, own ? childScope(raw, null) : raw, `${base}[${k}].`);
    }
  };
  return { dec, enc };
}

function compileSwitch(f: SwitchField, ctx: Ctx, scope: CScope, reserve: number, path: string): CompiledList {
  const name = f.name;
  const cases = new Map<number, CompiledList>();
  for (const [key, fields] of Object.entries(f.cases)) {
    const k = Number(key.trim());
    if (key.trim() === "" || !Number.isFinite(k)) {
      ctx.specErrors.push({ code: "INVALID_SPEC", message: `${path}${name}: case key "${key}" is not a number`, path: path + name });
      continue;
    }
    cases.set(k, compileList(fields, ctx, scope, reserve, path));
  }
  const def = f.default ? compileList(f.default, ctx, scope, reserve, path) : undefined;
  const resolver = makeResolver(f.on);

  const dec: DecFn = (st, out, raw, prefix) => {
    const v = resolver(raw, st.root);
    if (typeof v !== "number") badRef(prefix, name, f.on, v);
    const c = cases.get(v) ?? def;
    if (!c) {
      st.warnings.push(`${prefix}${name}: no case for ${v}`);
      return;
    }
    c.dec(st, out, raw, prefix);
  };
  const enc: EncFn = (st, obj, raw, prefix) => {
    const v = resolver(raw, st.root);
    if (typeof v !== "number") {
      st.errors.push({ code: "BAD_REFERENCE", message: `${prefix}${name}: reference "${f.on}" did not resolve`, path: prefix + name });
      return;
    }
    const c = cases.get(v) ?? def;
    if (!c) {
      st.warnings.push(`${prefix}${name}: no case for ${v}`);
      return;
    }
    c.enc(st, obj, raw, prefix);
  };
  return { dec, enc };
}

/* ------------------------------------------------------------------ */
/* Messages & codec                                                    */
/* ------------------------------------------------------------------ */

interface CompiledMessage {
  def: MessageDef;
  name: string;
  ports: number[] | null;
  topic: string | null;
  body: CompiledList;
}

export function topicMatches(filter: string, topic: string): boolean {
  if (filter === topic) return true;
  const f = filter.split("/");
  const t = topic.split("/");
  for (let k = 0; k < f.length; k++) {
    const p = f[k]!;
    if (p === "#") return true;
    if (k >= t.length) return false;
    if (p !== "+" && p !== t[k]) return false;
  }
  return f.length === t.length;
}

function compileMessage(m: MessageDef, ctx: Ctx): CompiledMessage {
  const port = m.when?.port;
  return {
    def: m,
    name: m.name,
    ports: port === undefined ? null : Array.isArray(port) ? port : [port],
    topic: m.when?.topic ?? null,
    body: compileList(m.fields, ctx, newScope(), 0, ""),
  };
}

function decodeMessage(m: CompiledMessage, buf: Uint8Array): { data: DecodedData; warnings: string[] } {
  const root = rootScope();
  const st: DState = { buf, pos: 0, end: buf.length * 8, warnings: [], root };
  const out: Obj = {};
  m.body.dec(st, out, root, "");
  if ((st.pos + 7) >> 3 !== buf.length) {
    fail("TRAILING_BYTES", `${buf.length - ((st.pos + 7) >> 3)} trailing byte(s) after layout`);
  }
  return { data: out, warnings: st.warnings };
}

function toCodecError(e: unknown): CodecError {
  if (e instanceof Fail) return e.error;
  return { code: "INVALID_SPEC", message: `internal error: ${e instanceof Error ? e.message : String(e)}` };
}

export function compileCodec(spec: DeviceCodecSpec): Codec {
  const refs = new Set<string>();
  for (const m of [...spec.uplink, ...(spec.downlink ?? [])]) collectRefs(m.fields, refs);
  const ctx: Ctx = { endian: spec.defaults?.endian ?? "big", refs, specErrors: [] };
  const uplink = spec.uplink.map((m) => compileMessage(m, ctx));
  const downlink = (spec.downlink ?? []).map((m) => compileMessage(m, ctx));
  if (ctx.specErrors.length) throw new CodecSpecError(ctx.specErrors);

  const byName = new Map<string, CompiledMessage>();
  for (const m of downlink) if (!byName.has(m.name)) byName.set(m.name, m);
  for (const m of uplink) if (!byName.has(m.name)) byName.set(m.name, m);

  const decode = (bytes: Uint8Array, c?: PayloadContext): DecodeResult => {
    const port = c?.port;
    const topic = c?.topic;
    let errs: CodecError[] | undefined;
    const tried: string[] = [];
    for (let k = 0; k < uplink.length; k++) {
      const m = uplink[k]!;
      if (port !== undefined && m.ports !== null && !m.ports.includes(port)) continue;
      if (topic !== undefined && m.topic !== null && !topicMatches(m.topic, topic)) continue;
      try {
        const r = decodeMessage(m, bytes);
        return { ok: true, message: m.name, data: r.data, warnings: r.warnings };
      } catch (e) {
        const err = toCodecError(e);
        tried.push(m.name);
        (errs ??= []).push({ ...err, message: `${m.name}: ${err.message}` });
      }
    }
    return {
      ok: false,
      errors: [
        {
          code: "NO_MATCHING_MESSAGE",
          message: tried.length ? `no uplink message decoded the payload (tried ${tried.join(", ")})` : "no uplink message matches the port/topic",
        },
        ...(errs ?? []),
      ],
      warnings: [],
    };
  };

  const encode = (message: string, data: DecodedData): EncodeResult => {
    const m = byName.get(message);
    if (!m) return { ok: false, errors: [{ code: "NO_MATCHING_MESSAGE", message: `unknown message "${message}"` }], warnings: [] };
    const st: EState = { w: new BitWriter(), rootObj: data ?? {}, errors: [], warnings: [], root: rootScope() };
    try {
      m.body.enc(st, data ?? {}, st.root, "");
    } catch (e) {
      st.errors.push(toCodecError(e));
    }
    if (st.errors.length) return { ok: false, errors: st.errors, warnings: st.warnings };
    const res: EncodeResult = { ok: true, bytes: st.w.result(), warnings: st.warnings };
    if (m.ports && m.ports.length) res.port = m.ports[0];
    return res;
  };

  return { spec, decode, encode };
}
