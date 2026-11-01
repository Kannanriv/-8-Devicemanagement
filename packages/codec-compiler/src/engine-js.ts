/**
 * The JavaScript DCS interpreter embedded in the `ts` and `ts013` plugins.
 *
 * It is authored once, as ES5-style JavaScript (no arrows, template literals,
 * BigInt, classes or modules) so it runs unchanged in TTN (goja) and ChirpStack
 * (QuickJS). Type annotations are written as `/*:T*\/` markers: `toTs()` turns them
 * into real annotations for the typed `ts` target, `toJs()` strips them.
 *
 * Normative semantics: docs/dcs-semantics.md. Every other language port
 * (python, go, java, c) mirrors this file function-for-function.
 */
export const JS_ENGINE = String.raw`
var DCS_CHECKSUM_BYTES/*:any*/ = { "crc8": 1, "xor8": 1, "sum8": 1, "crc16-ccitt": 2, "crc16-modbus": 2, "crc32": 4 };

function dcsFail(code/*:string*/, message/*:string*/, path/*:any*/)/*:never*/ {
  var e/*:any*/ = { dcsError: true, code: code, message: message };
  if (path) e.path = path;
  throw e;
}

function dcsHas(o/*:any*/, k/*:string*/)/*:boolean*/ {
  return o != null && Object.prototype.hasOwnProperty.call(o, k);
}

/** Case keys / enum keys: decimal or 0x-hex. */
function dcsParseKey(k/*:string*/)/*:number*/ {
  return /^\s*-?0x/i.test(k) ? (k.trim().charAt(0) === "-" ? -parseInt(k.trim().slice(3), 16) : parseInt(k.trim().slice(2), 16)) : Number(k);
}

function dcsFmt(v/*:any*/)/*:string*/ {
  return String(v);
}

function dcsHex(b/*:any*/)/*:string*/ {
  var s = "";
  for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
  return s;
}

// ---------------------------------------------------------------- big integers
// Unsigned big integers are byte arrays (big-endian). Used only for widths > 53 bits.

function dcsBytesToNumber(b/*:any*/)/*:number*/ {
  var x = 0;
  for (var i = 0; i < b.length; i++) x = x * 256 + b[i];
  return x;
}

function dcsBytesToDec(b/*:any*/)/*:string*/ {
  var a = b.slice(0), out = "";
  for (;;) {
    var nz = false, rem = 0;
    for (var i = 0; i < a.length; i++) {
      var cur = rem * 256 + a[i];
      a[i] = Math.floor(cur / 10);
      rem = cur % 10;
      if (a[i]) nz = true;
    }
    out = rem + out;
    if (!nz) return out;
  }
}

function dcsDecToBytes(s/*:string*/, n/*:number*/)/*:any*/ {
  var b/*:any*/ = [];
  for (var i = 0; i < n; i++) b.push(0);
  for (var j = 0; j < s.length; j++) {
    var carry = s.charCodeAt(j) - 48;
    for (var k = n - 1; k >= 0; k--) {
      var cur = b[k] * 10 + carry;
      b[k] = cur & 255;
      carry = Math.floor(cur / 256);
    }
    if (carry) return null;
  }
  return b;
}

function dcsBitLength(b/*:any*/)/*:number*/ {
  for (var i = 0; i < b.length; i++) {
    if (b[i]) {
      var n = 0, v = b[i];
      while (v) { n++; v >>= 1; }
      return (b.length - i - 1) * 8 + n;
    }
  }
  return 0;
}

function dcsNegate(b/*:any*/)/*:any*/ {
  var out/*:any*/ = [], carry = 1;
  for (var i = b.length - 1; i >= 0; i--) {
    var v = (~b[i] & 255) + carry;
    out[i] = v & 255;
    carry = v >> 8;
  }
  return out;
}

function dcsIsPow2(b/*:any*/)/*:boolean*/ {
  var seen = false;
  for (var i = 0; i < b.length; i++) {
    if (b[i]) {
      if (seen || (b[i] & (b[i] - 1))) return false;
      seen = true;
    }
  }
  return seen;
}

function dcsMagnitude(b/*:any*/, neg/*:boolean*/)/*:any*/ {
  var bl = dcsBitLength(b);
  if (bl <= 53 || (bl === 54 && dcsIsPow2(b))) {
    var x = dcsBytesToNumber(b);
    return neg ? -x : x;
  }
  return (neg ? "-" : "") + dcsBytesToDec(b);
}

// ---------------------------------------------------------------- reader

function dcsReadBits(st/*:any*/, n/*:number*/, little/*:boolean*/)/*:any*/ {
  if (st.pos + n > st.end) dcsFail("PAYLOAD_TOO_SHORT", "need " + n + " bits at bit " + st.pos + ", payload has " + st.end, st.path);
  var nb = Math.ceil(n / 8), out/*:any*/ = [];
  for (var i = 0; i < nb; i++) out.push(0);
  if (st.pos % 8 === 0 && n % 8 === 0) {
    for (var j = 0; j < nb; j++) out[j] = st.bytes[st.pos / 8 + j] & 255;
    if (little) out.reverse();
  } else {
    for (var k = 0; k < n; k++) {
      var p = st.pos + k;
      var bit = (st.bytes[p >> 3] >> (7 - (p & 7))) & 1;
      var idx = nb - 1 - Math.floor((n - 1 - k) / 8);
      out[idx] |= bit << ((n - 1 - k) % 8);
    }
  }
  st.pos += n;
  return out;
}

function dcsReadUnsigned(st/*:any*/, n/*:number*/, little/*:boolean*/)/*:any*/ {
  return dcsMagnitude(dcsReadBits(st, n, little), false);
}

function dcsReadSigned(st/*:any*/, n/*:number*/, little/*:boolean*/)/*:any*/ {
  var b = dcsReadBits(st, n, little);
  var topBit = (b[0] >> ((n - 1) % 8)) & 1;
  if (!topBit) return dcsMagnitude(b, false);
  // sign-extend to whole bytes, then negate
  var ext = b.slice(0);
  if (n % 8) ext[0] |= (0xff << (n % 8)) & 255;
  return dcsMagnitude(dcsNegate(ext), true);
}

function dcsUtf8Decode(b/*:any*/)/*:string*/ {
  var s = "", i = 0;
  while (i < b.length) {
    var c = b[i++];
    if (c < 0x80) s += String.fromCharCode(c);
    else if (c >= 0xc0 && c < 0xe0 && i < b.length) s += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f));
    else if (c >= 0xe0 && c < 0xf0 && i + 1 < b.length) { s += String.fromCharCode(((c & 0x0f) << 12) | ((b[i] & 0x3f) << 6) | (b[i + 1] & 0x3f)); i += 2; }
    else if (c >= 0xf0 && i + 2 < b.length) {
      var cp = (((c & 0x07) << 18) | ((b[i] & 0x3f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f)) - 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      i += 3;
    } else s += "�";
  }
  return s;
}

function dcsUtf8Encode(s/*:string*/)/*:any*/ {
  var out/*:any*/ = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) { c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00); }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

// ---------------------------------------------------------------- checksums

function dcsChecksum(algo/*:string*/, b/*:any*/, start/*:number*/, end/*:number*/)/*:number*/ {
  var c = 0, i = 0, k = 0;
  if (algo === "crc8") {
    for (i = start; i < end; i++) { c ^= b[i]; for (k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; }
  } else if (algo === "crc16-ccitt") {
    c = 0xffff;
    for (i = start; i < end; i++) { c ^= b[i] << 8; for (k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; }
  } else if (algo === "crc16-modbus") {
    c = 0xffff;
    for (i = start; i < end; i++) { c ^= b[i]; for (k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1; }
  } else if (algo === "crc32") {
    c = 0xffffffff;
    for (i = start; i < end; i++) { c ^= b[i]; for (k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; }
    c = (c ^ 0xffffffff) >>> 0;
  } else if (algo === "xor8") {
    for (i = start; i < end; i++) c ^= b[i];
  } else if (algo === "sum8") {
    for (i = start; i < end; i++) c = (c + b[i]) & 0xff;
  } else dcsFail("INVALID_SPEC", "unknown checksum " + algo, null);
  return c;
}

// ---------------------------------------------------------------- helpers

function dcsEndianLittle(spec/*:any*/, f/*:any*/)/*:boolean*/ {
  var e = f.endian || (spec.defaults && spec.defaults.endian) || "big";
  return e === "little";
}

function dcsScalarBits(f/*:any*/)/*:number*/ {
  if (f.type === "bool") return f.bits || 1;
  if (f.type === "float") return f.bits || 32;
  return f.bits || 8;
}

function dcsTrailingBits(fields/*:any*/, i/*:number*/)/*:number*/ {
  var n = 0;
  for (var j = i + 1; j < fields.length; j++) if (fields[j].kind === "checksum") n += 8 * DCS_CHECKSUM_BYTES[fields[j].algo];
  return n;
}

function dcsByteLength(st/*:any*/, f/*:any*/, reserve/*:number*/)/*:number*/ {
  if (f.length === "remaining") {
    var n = Math.floor((st.end - reserve - st.pos) / 8);
    return n < 0 ? 0 : n;
  }
  if (typeof f.length !== "number") dcsFail("INVALID_SPEC", f.name + ": length required", st.path);
  return f.length;
}

function dcsRound(v/*:number*/, d/*:number*/)/*:number*/ {
  return Number(v.toFixed(d));
}

function dcsIsInt(x/*:any*/)/*:boolean*/ {
  return typeof x === "number" && Math.floor(x) === x;
}

/** Resolve a field reference against the raw-value scope chain (innermost last). */
function dcsResolve(scopes/*:any*/, ref/*:string*/, path/*:string*/)/*:any*/ {
  var v/*:any*/;
  if (ref.indexOf(".") >= 0) {
    var parts = ref.split("."), cur/*:any*/ = scopes[0];
    for (var i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== "object" || !dcsHas(cur, parts[i])) dcsFail("BAD_REFERENCE", "cannot resolve '" + ref + "'", path);
      cur = cur[parts[i]];
    }
    v = cur;
  } else {
    var found = false;
    for (var s = scopes.length - 1; s >= 0; s--) {
      if (dcsHas(scopes[s], ref)) { v = scopes[s][ref]; found = true; break; }
    }
    if (!found) dcsFail("BAD_REFERENCE", "cannot resolve '" + ref + "'", path);
  }
  return v;
}

// ---------------------------------------------------------------- decode

function dcsSemantics(st/*:any*/, f/*:any*/, raw/*:any*/, path/*:string*/)/*:any*/ {
  if (f.type === "bool") return raw !== 0 && raw !== "0";
  if (typeof raw !== "number") return raw;
  if (f.enum) {
    var key = String(raw);
    if (dcsHas(f.enum, key)) return f.enum[key];
    st.warnings.push(path + ": unknown enum value " + dcsFmt(raw));
    return raw;
  }
  var scale = f.scale == null ? 1 : f.scale, offset = f.offset == null ? 0 : f.offset;
  var v = raw * scale + offset;
  if (f.decimals != null) v = dcsRound(v, f.decimals);
  else if (!dcsIsInt(scale) || !dcsIsInt(offset)) v = dcsRound(v, 10);
  if ((f.min != null && v < f.min) || (f.max != null && v > f.max)) {
    st.warnings.push(path + ": value " + dcsFmt(v) + " outside [" + (f.min == null ? "-Infinity" : dcsFmt(f.min)) + "," + (f.max == null ? "Infinity" : dcsFmt(f.max)) + "]");
  }
  return v;
}

function dcsReadScalar(st/*:any*/, f/*:any*/, reserve/*:number*/)/*:any*/ {
  var little = dcsEndianLittle(st.spec, f), t = f.type;
  if (t === "uint" || t === "bool") return dcsReadUnsigned(st, dcsScalarBits(f), little);
  if (t === "int") return dcsReadSigned(st, dcsScalarBits(f), little);
  if (t === "float") {
    var fb = dcsScalarBits(f);
    if (fb !== 32 && fb !== 64) dcsFail("INVALID_SPEC", f.name + ": float must be 32 or 64 bits", st.path);
    var b = dcsReadBits(st, fb, little);
    var dv = new DataView(new ArrayBuffer(fb / 8));
    for (var i = 0; i < b.length; i++) dv.setUint8(i, b[i]);
    return fb === 32 ? dv.getFloat32(0) : dv.getFloat64(0);
  }
  var n = dcsByteLength(st, f, reserve);
  var bytes = n ? dcsReadBits(st, n * 8, false) : [];
  if (t === "bytes") return dcsHex(bytes);
  if (t === "string") {
    var e = bytes.length;
    while (e > 0 && bytes[e - 1] === 0) e--;
    return dcsUtf8Decode(bytes.slice(0, e));
  }
  if (t === "bcd") {
    var s = "";
    for (var j = 0; j < bytes.length; j++) {
      var hi = bytes[j] >> 4, lo = bytes[j] & 15;
      if (hi !== 15) s += hi.toString(16);
      if (lo !== 15) s += lo.toString(16);
    }
    return s;
  }
  return dcsFail("INVALID_SPEC", f.name + ": unknown type " + t, st.path);
}

function dcsDecodeFields(st/*:any*/, fields/*:any*/, out/*:any*/, raws/*:any*/, scopes/*:any*/, prefix/*:string*/, reserve/*:number*/)/*:void*/ {
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i], kind = f.kind || "scalar", path = prefix + f.name;
    var trailing = reserve + dcsTrailingBits(fields, i);
    st.path = path;
    if (kind === "scalar") {
      var raw = dcsReadScalar(st, f, trailing);
      raws[f.name] = raw;
      if (!f.hidden) out[f.name] = dcsSemantics(st, f, raw, path);
    } else if (kind === "const") {
      var cv = dcsReadUnsigned(st, f.bits, dcsEndianLittle(st.spec, f));
      var want = f.value < 0 ? f.value + Math.pow(2, f.bits) : f.value;
      if (cv !== want && String(cv) !== String(want)) dcsFail("CONST_MISMATCH", path + ": expected " + f.value + ", got " + cv, path);
      raws[f.name] = cv;
    } else if (kind === "checksum") {
      if (st.pos % 8) dcsFail("INVALID_SPEC", path + ": checksum must be byte-aligned", path);
      var at = st.pos / 8, width = DCS_CHECKSUM_BYTES[f.algo];
      if (!width) dcsFail("INVALID_SPEC", "unknown checksum " + f.algo, path);
      var got = dcsReadUnsigned(st, width * 8, dcsEndianLittle(st.spec, f));
      var calc = dcsChecksum(f.algo, st.bytes, 0, at);
      if (got !== calc) dcsFail("CHECKSUM_MISMATCH", path + ": " + f.algo + " expected " + calc.toString(16) + ", got " + got.toString(16), path);
    } else if (kind === "group") {
      var go/*:any*/ = {}, gr/*:any*/ = {};
      raws[f.name] = gr;
      dcsDecodeFields(st, f.fields, go, gr, scopes.concat([gr]), path + ".", trailing);
      out[f.name] = go;
    } else if (kind === "repeat") {
      var arr/*:any*/ = [], rarr/*:any*/ = [];
      raws[f.name] = rarr;
      var count = -1;
      if (typeof f.count === "number") count = f.count;
      else if (f.count && typeof f.count === "object") {
        count = dcsResolve(scopes, f.count.ref, path);
        if (!dcsIsInt(count) || count < 0) dcsFail("BAD_REFERENCE", path + ": count '" + f.count.ref + "' is not a non-negative integer", path);
      }
      for (var k = 0; count < 0 || k < count; k++) {
        if (count < 0 && st.end - trailing - st.pos < 8) break;
        var start = st.pos, io/*:any*/ = {}, ir/*:any*/ = {};
        rarr.push(ir);
        dcsDecodeFields(st, f.fields, io, ir, scopes.concat([ir]), path + "[" + k + "].", trailing);
        arr.push(io);
        if (count < 0 && st.pos === start) break;
      }
      out[f.name] = arr;
    } else if (kind === "switch") {
      var on = dcsResolve(scopes, f.on, path);
      var chosen/*:any*/ = dcsPickCase(f, on);
      if (chosen) dcsDecodeFields(st, chosen, out, raws, scopes, prefix, trailing);
      else st.warnings.push(path + ": no case for " + dcsFmt(on));
    } else dcsFail("INVALID_SPEC", path + ": unknown field kind " + kind, path);
  }
}

function dcsPickCase(f/*:any*/, on/*:any*/)/*:any*/ {
  var keys = Object.keys(f.cases || {});
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i] as string;
    if (dcsParseKey(k) === on || (typeof on === "string" && k === on)) return f.cases[k];
  }
  return f["default"] || null;
}

function dcsWhenMatches(when/*:any*/, port/*:any*/, topic/*:any*/)/*:boolean*/ {
  if (!when) return true;
  if (when.port != null && port != null) {
    var ports = typeof when.port === "number" ? [when.port] : when.port;
    if (ports.indexOf(port) < 0) return false;
  }
  if (when.topic != null && topic != null && !dcsTopicMatches(when.topic, topic)) return false;
  return true;
}

function dcsTopicMatches(pattern/*:string*/, topic/*:string*/)/*:boolean*/ {
  var p = pattern.split("/"), t = topic.split("/");
  for (var i = 0; i < p.length; i++) {
    if (p[i] === "#") return true;
    if (i >= t.length) return false;
    if (p[i] !== "+" && p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}

function dcsDecode(spec/*:any*/, bytes/*:any*/, port/*:any*/, topic/*:any*/, list/*:string*/)/*:any*/ {
  var msgs = (list === "downlink" ? spec.downlink : spec.uplink) || [];
  var errors/*:any*/ = [], tried = 0;
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (!dcsWhenMatches(m.when, port, topic)) continue;
    tried++;
    var st/*:any*/ = { spec: spec, bytes: bytes, pos: 0, end: bytes.length * 8, warnings: [], path: "" };
    try {
      var out/*:any*/ = {}, raws/*:any*/ = {};
      dcsDecodeFields(st, m.fields, out, raws, [raws], "", 0);
      if (Math.ceil(st.pos / 8) < bytes.length) dcsFail("TRAILING_BYTES", (bytes.length - Math.ceil(st.pos / 8)) + " unread byte(s)", null);
      return { ok: true, message: m.name, data: out, warnings: st.warnings };
    } catch (e/*:any*/) {
      if (!e || !e.dcsError) throw e;
      var err/*:any*/ = { code: e.code, message: m.name + ": " + e.message };
      if (e.path) err.path = e.path;
      errors.push(err);
    }
  }
  return {
    ok: false,
    errors: [{ code: "NO_MATCHING_MESSAGE", message: "no message matched (" + tried + " candidate(s) tried)" }].concat(errors),
    warnings: []
  };
}

// ---------------------------------------------------------------- encode

function dcsWriteBits(w/*:any*/, b/*:any*/, n/*:number*/, little/*:boolean*/)/*:void*/ {
  // b: right-aligned big-endian byte array holding an n-bit value
  var src = b;
  if (w.pos % 8 === 0 && n % 8 === 0 && little) src = b.slice(0).reverse();
  var nb = src.length;
  for (var k = 0; k < n; k++) {
    var idx = nb - 1 - Math.floor((n - 1 - k) / 8);
    var bit = (src[idx] >> ((n - 1 - k) % 8)) & 1;
    var p = w.pos + k;
    while (w.bytes.length <= (p >> 3)) w.bytes.push(0);
    if (bit) w.bytes[p >> 3] |= 1 << (7 - (p & 7));
  }
  w.pos += n;
}

/** Integer raw (number or decimal string) -> n-bit two's complement byte array, or null if out of range. */
function dcsIntBytes(raw/*:any*/, n/*:number*/, signed/*:boolean*/)/*:any*/ {
  var s = typeof raw === "number" ? (Math.abs(raw) < 1e21 ? raw.toFixed(0) : "x") : String(raw).trim();
  if (!/^-?\d+$/.test(s)) return null;
  var neg = s.charAt(0) === "-";
  var nb = Math.ceil(n / 8);
  var mag = dcsDecToBytes(neg ? s.slice(1) : s, nb + 1);
  if (!mag) return null;
  var bl = dcsBitLength(mag);
  if (neg && bl === 0) neg = false;
  if (!signed && neg) return null;
  if (!signed && bl > n) return null;
  if (signed && !neg && bl > n - 1) return null;
  if (signed && neg) {
    if (bl > n) return null;
    if (bl === n) {
      // only -2^(n-1) is allowed at full width
      if (!dcsIsPow2(mag)) return null;
    }
    mag = dcsNegate(mag);
  }
  var out = mag.slice(1);
  if (n % 8) out[0] &= (1 << (n % 8)) - 1;
  return out;
}

function dcsToRaw(f/*:any*/, v/*:any*/, path/*:string*/)/*:any*/ {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (f.type === "bool") return v ? 1 : 0;
  if (f.enum && typeof v === "string") {
    var keys = Object.keys(f.enum);
    for (var i = 0; i < keys.length; i++) if (f.enum[keys[i] as string] === v) return dcsParseKey(keys[i] as string);
    if (!/^-?\d+$/.test(v)) dcsFail("ENCODE_OUT_OF_RANGE", path + ": unknown enum label '" + v + "'", path);
  }
  if (typeof v === "string") {
    if (/^-?\d+$/.test(v.trim())) return v.trim();
    dcsFail("ENCODE_OUT_OF_RANGE", path + ": not a number: '" + v + "'", path);
  }
  if (typeof v !== "number" || v !== v) dcsFail("ENCODE_OUT_OF_RANGE", path + ": not a number", path);
  if (f.enum) return v;
  var scale = f.scale == null ? 1 : f.scale, offset = f.offset == null ? 0 : f.offset;
  var x = (v - offset) / scale;
  return f.type === "float" ? x : Math.floor(x + 0.5);
}

function dcsHexToBytes(s/*:any*/, path/*:string*/)/*:any*/ {
  if (typeof s !== "string") {
    if (s && typeof s.length === "number") { var a/*:any*/ = []; for (var j = 0; j < s.length; j++) a.push(s[j] & 255); return a; }
    dcsFail("ENCODE_OUT_OF_RANGE", path + ": expected hex string", path);
  }
  var c = s.replace(/[\s:-]/g, "");
  if (c.length % 2 || /[^0-9a-fA-F]/.test(c)) dcsFail("ENCODE_OUT_OF_RANGE", path + ": invalid hex", path);
  var out/*:any*/ = [];
  for (var i = 0; i < c.length; i += 2) out.push(parseInt(c.substr(i, 2), 16));
  return out;
}

function dcsWriteScalar(w/*:any*/, f/*:any*/, v/*:any*/, path/*:string*/, missing/*:boolean*/)/*:any*/ {
  var little = dcsEndianLittle(w.spec, f), t = f.type;
  if (t === "uint" || t === "int" || t === "bool") {
    var n = dcsScalarBits(f);
    var raw = missing ? 0 : dcsToRaw(f, v, path);
    var b = dcsIntBytes(raw, n, t === "int");
    if (!b) dcsFail("ENCODE_OUT_OF_RANGE", path + ": " + raw + " does not fit " + t + n, path);
    dcsWriteBits(w, b, n, little);
    return raw;
  }
  if (t === "float") {
    var fb = dcsScalarBits(f);
    var x = missing ? 0 : dcsToRaw(f, v, path);
    var dv = new DataView(new ArrayBuffer(fb / 8));
    if (fb === 32) dv.setFloat32(0, x); else dv.setFloat64(0, x);
    var fbytes/*:any*/ = [];
    for (var i = 0; i < fb / 8; i++) fbytes.push(dv.getUint8(i));
    dcsWriteBits(w, fbytes, fb, little);
    return x;
  }
  var bytes/*:any*/;
  if (missing) bytes = [];
  else if (t === "bytes") bytes = dcsHexToBytes(v, path);
  else if (t === "string") bytes = dcsUtf8Encode(String(v));
  else if (t === "bcd") {
    var ds = String(v);
    if (!/^[0-9a-eA-E]*$/.test(ds)) dcsFail("ENCODE_OUT_OF_RANGE", path + ": invalid BCD digits", path);
    bytes = [];
    for (var k = 0; k < ds.length; k += 2) {
      var hi = parseInt(ds.charAt(k), 16), lo = k + 1 < ds.length ? parseInt(ds.charAt(k + 1), 16) : 15;
      bytes.push((hi << 4) | lo);
    }
  } else dcsFail("INVALID_SPEC", path + ": unknown type " + t, path);
  if (f.length !== "remaining") {
    if (typeof f.length !== "number") dcsFail("INVALID_SPEC", path + ": length required", path);
    if (bytes.length > f.length) dcsFail("ENCODE_OUT_OF_RANGE", path + ": " + bytes.length + " bytes exceed length " + f.length, path);
    while (bytes.length < f.length) bytes.push(t === "bcd" ? 0xff : 0);
  }
  if (bytes.length) dcsWriteBits(w, bytes, bytes.length * 8, false);
  return t === "bytes" ? dcsHex(bytes) : v;
}

function dcsDeclares(fields/*:any*/, name/*:string*/)/*:boolean*/ {
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i], kind = f.kind || "scalar";
    if ((kind === "scalar" || kind === "const") && f.name === name) return true;
    if (kind === "switch") {
      var ks = Object.keys(f.cases || {});
      for (var j = 0; j < ks.length; j++) if (dcsDeclares(f.cases[ks[j] as string], name)) return true;
      if (f["default"] && dcsDeclares(f["default"], name)) return true;
    }
  }
  return false;
}

/** Semantics §7: a {ref} count field omitted by the caller is set to the array length. */
function dcsAutoCounts(fields/*:any*/, obj/*:any*/, stack/*:any*/)/*:void*/ {
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.kind !== "repeat" || !f.count || typeof f.count !== "object") continue;
    var arr = obj[f.name];
    if (!arr || typeof arr.length !== "number") continue;
    var ref = f.count.ref;
    if (ref.indexOf(".") >= 0) {
      var parts = ref.split("."), cur = stack[0].obj;
      for (var p = 0; p < parts.length - 1 && cur; p++) {
        if (cur[parts[p]] == null) cur[parts[p]] = {};
        cur = cur[parts[p]];
      }
      if (cur && typeof cur === "object" && cur[parts[parts.length - 1]] == null) cur[parts[parts.length - 1]] = arr.length;
    } else {
      for (var s = stack.length - 1; s >= 0; s--) {
        if (dcsDeclares(stack[s].fields, ref)) {
          if (stack[s].obj[ref] == null) stack[s].obj[ref] = arr.length;
          break;
        }
      }
    }
  }
}

function dcsEncodeFields(w/*:any*/, fields/*:any*/, obj/*:any*/, raws/*:any*/, scopes/*:any*/, stack/*:any*/, prefix/*:string*/)/*:void*/ {
  dcsAutoCounts(fields, obj, stack);
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i], kind = f.kind || "scalar", path = prefix + f.name;
    if (kind === "scalar") {
      var v = obj[f.name], missing = false;
      if (v === undefined || v === null) {
        if (f["default"] !== undefined) v = f["default"];
        else if (f.hidden) missing = true;
        else {
          dcsEncodeError(w, { code: "ENCODE_MISSING_FIELD", message: "missing field " + path, path: path });
          missing = true;
        }
      }
      try {
        raws[f.name] = dcsWriteScalar(w, f, v, path, missing);
      } catch (e/*:any*/) {
        if (!e || !e.dcsError || e.code.indexOf("ENCODE_") !== 0) throw e;
        dcsEncodeError(w, e);
        raws[f.name] = dcsWriteScalar(w, f, null, path, true);
      }
    } else if (kind === "const") {
      var cb = dcsIntBytes(f.value < 0 ? f.value + Math.pow(2, f.bits) : f.value, f.bits, false);
      if (!cb) dcsFail("INVALID_SPEC", path + ": const does not fit", path);
      dcsWriteBits(w, cb, f.bits, dcsEndianLittle(w.spec, f));
      raws[f.name] = f.value;
    } else if (kind === "checksum") {
      if (w.pos % 8) dcsFail("INVALID_SPEC", path + ": checksum must be byte-aligned", path);
      var width = DCS_CHECKSUM_BYTES[f.algo];
      if (!width) dcsFail("INVALID_SPEC", "unknown checksum " + f.algo, path);
      var c = dcsChecksum(f.algo, w.bytes, 0, w.pos / 8);
      var cbytes/*:any*/ = [];
      for (var k = width - 1; k >= 0; k--) cbytes.push(Math.floor(c / Math.pow(256, k)) & 255);
      dcsWriteBits(w, cbytes, width * 8, dcsEndianLittle(w.spec, f));
    } else if (kind === "group") {
      var go = obj[f.name];
      if (go == null || typeof go !== "object") go = obj[f.name] = {};
      var gr/*:any*/ = {};
      raws[f.name] = gr;
      dcsEncodeFields(w, f.fields, go, gr, scopes.concat([gr]), stack.concat([{ obj: go, fields: f.fields }]), path + ".");
    } else if (kind === "repeat") {
      var arr = obj[f.name];
      if (arr == null || typeof arr !== "object" || typeof arr.length !== "number") {
        dcsEncodeError(w, { code: "ENCODE_MISSING_FIELD", message: "missing array " + path, path: path });
        continue;
      }
      var want = -1;
      if (typeof f.count === "number") want = f.count;
      else if (f.count && typeof f.count === "object") want = dcsResolve(scopes, f.count.ref, path);
      if (want >= 0 && want !== arr.length) {
        dcsEncodeError(w, { code: "ENCODE_OUT_OF_RANGE", message: path + ": expected " + want + " items, got " + arr.length, path: path });
        continue;
      }
      var rarr/*:any*/ = [];
      raws[f.name] = rarr;
      for (var j = 0; j < arr.length; j++) {
        var item = arr[j] == null ? {} : arr[j];
        var ir/*:any*/ = {};
        rarr.push(ir);
        dcsEncodeFields(w, f.fields, item, ir, scopes.concat([ir]), stack.concat([{ obj: item, fields: f.fields }]), path + "[" + j + "].");
      }
    } else if (kind === "switch") {
      var on = dcsResolve(scopes, f.on, path);
      var chosen = dcsPickCase(f, on);
      if (chosen) dcsEncodeFields(w, chosen, obj, raws, scopes, stack, prefix);
      else w.warnings.push(path + ": no case for " + dcsFmt(on));
    } else dcsFail("INVALID_SPEC", path + ": unknown field kind " + kind, path);
  }
}

function dcsEncodeError(w/*:any*/, e/*:any*/)/*:void*/ {
  var err/*:any*/ = { code: e.code, message: e.message };
  if (e.path) err.path = e.path;
  w.errors.push(err);
}

function dcsClone(v/*:any*/)/*:any*/ {
  if (v === null || typeof v !== "object") return v;
  if (typeof v.length === "number" && !(v instanceof Array)) return v; // typed arrays
  var out/*:any*/ = v instanceof Array ? [] : {};
  var keys = Object.keys(v);
  for (var i = 0; i < keys.length; i++) out[keys[i] as string] = dcsClone(v[keys[i] as string]);
  return out;
}

function dcsEncode(spec/*:any*/, message/*:string*/, data/*:any*/)/*:any*/ {
  var lists = [spec.downlink || [], spec.uplink || []], m/*:any*/ = null;
  for (var l = 0; l < lists.length && !m; l++) {
    for (var i = 0; i < lists[l].length; i++) if (lists[l][i].name === message) { m = lists[l][i]; break; }
  }
  if (!m) return { ok: false, errors: [{ code: "NO_MATCHING_MESSAGE", message: "unknown message '" + message + "'" }], warnings: [] };
  var w/*:any*/ = { spec: spec, bytes: [], pos: 0, warnings: [], errors: [] };
  try {
    var obj = dcsClone(data || {}), raws/*:any*/ = {};
    dcsEncodeFields(w, m.fields, obj, raws, [raws], [{ obj: obj, fields: m.fields }], "");
  } catch (e/*:any*/) {
    if (!e || !e.dcsError) throw e;
    var err/*:any*/ = { code: e.code, message: e.message };
    if (e.path) err.path = e.path;
    w.errors.push(err);
  }
  if (w.errors.length) return { ok: false, errors: w.errors, warnings: w.warnings };
  var res/*:any*/ = { ok: true, bytes: new Uint8Array(w.bytes), warnings: w.warnings };
  var port = m.when && m.when.port;
  if (port != null) res.port = typeof port === "number" ? port : port[0];
  return res;
}
`;

/** Strip `/*:T*\/` annotation markers -> plain ES2015 JavaScript. Also strips `as string` casts. */
export function toJs(src: string): string {
  return src.replace(/\/\*:[^*]*\*\//g, "").replace(/ as string/g, "");
}

/** Turn `/*:T*\/` markers into TypeScript annotations. */
export function toTs(src: string): string {
  return src.replace(/\/\*:([^*]*)\*\//g, ": $1");
}
