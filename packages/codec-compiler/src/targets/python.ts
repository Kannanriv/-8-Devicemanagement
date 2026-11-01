import type { DeviceCodecSpec } from "@hash8/dcs-schema";
import { cleanHex, lineHeader, runtimeSpec, slug, vectors, type GeneratedFile } from "../common";

/** Python port of the JS engine (src/engine-js.ts) — keep function-for-function parity. */
const PY_ENGINE = String.raw`
_CHECKSUM_BYTES = {"crc8": 1, "xor8": 1, "sum8": 1, "crc16-ccitt": 2, "crc16-modbus": 2, "crc32": 4}
_TWO53 = 2 ** 53


class CodecError(Exception):
    def __init__(self, code, message, path=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.path = path

    def to_dict(self, prefix=""):
        d = {"code": self.code, "message": prefix + self.message}
        if self.path:
            d["path"] = self.path
        return d


def _parse_key(k):
    s = k.strip()
    neg = s.startswith("-")
    if neg:
        s = s[1:]
    v = int(s[2:], 16) if s.lower().startswith("0x") else float(s)
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return -v if neg else v


def _fmt(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        if v.is_integer() and abs(v) < 1e21:
            return str(int(v))
        return repr(v)
    return str(v)


def _round(v, d):
    # Same as JavaScript Number(v.toFixed(d)): exact decimal value, ties away from zero.
    if v != v or abs(v) >= 1e21:
        return v
    return float(Decimal(v).quantize(Decimal(1).scaleb(-d), rounding=ROUND_HALF_UP))


def _is_int(x):
    if isinstance(x, bool):
        return False
    return isinstance(x, int) or (isinstance(x, float) and x.is_integer())


def _endian_little(spec, f):
    return (f.get("endian") or spec.get("defaults", {}).get("endian") or "big") == "little"


def _scalar_bits(f):
    if f["type"] == "bool":
        return f.get("bits") or 1
    if f["type"] == "float":
        return f.get("bits") or 32
    return f.get("bits") or 8


def _trailing_bits(fields, i):
    return sum(8 * _CHECKSUM_BYTES[g["algo"]] for g in fields[i + 1:] if g.get("kind") == "checksum")


def checksum(algo, b):
    """Checksum of bytes b with a DCS algorithm name."""
    c = 0
    if algo == "crc8":
        for x in b:
            c ^= x
            for _ in range(8):
                c = ((c << 1) ^ 0x07) & 0xFF if c & 0x80 else (c << 1) & 0xFF
    elif algo == "crc16-ccitt":
        c = 0xFFFF
        for x in b:
            c ^= x << 8
            for _ in range(8):
                c = ((c << 1) ^ 0x1021) & 0xFFFF if c & 0x8000 else (c << 1) & 0xFFFF
    elif algo == "crc16-modbus":
        c = 0xFFFF
        for x in b:
            c ^= x
            for _ in range(8):
                c = (c >> 1) ^ 0xA001 if c & 1 else c >> 1
    elif algo == "crc32":
        c = 0xFFFFFFFF
        for x in b:
            c ^= x
            for _ in range(8):
                c = (c >> 1) ^ 0xEDB88320 if c & 1 else c >> 1
        c ^= 0xFFFFFFFF
    elif algo == "xor8":
        for x in b:
            c ^= x
    elif algo == "sum8":
        for x in b:
            c = (c + x) & 0xFF
    else:
        raise CodecError("INVALID_SPEC", "unknown checksum " + str(algo))
    return c


def _resolve(scopes, ref, path):
    """Resolve a field reference against the raw-value scope chain (innermost last)."""
    if "." in ref:
        cur = scopes[0]
        for p in ref.split("."):
            if isinstance(cur, dict) and p in cur:
                cur = cur[p]
            elif isinstance(cur, list) and p.isdigit() and int(p) < len(cur):
                cur = cur[int(p)]
            else:
                raise CodecError("BAD_REFERENCE", "cannot resolve '%s'" % ref, path)
        return cur
    for s in reversed(scopes):
        if ref in s:
            return s[ref]
    raise CodecError("BAD_REFERENCE", "cannot resolve '%s'" % ref, path)


def _magnitude(u, neg):
    if u <= _TWO53:
        return -u if neg else u
    return ("-" if neg else "") + str(u)


def _pick_case(f, on):
    for k, fields in (f.get("cases") or {}).items():
        if (not isinstance(on, (str, bool, dict, list)) and _parse_key(k) == on) or (isinstance(on, str) and k == on):
            return fields
    return f.get("default")


def _when_matches(when, port, topic):
    if not when:
        return True
    wp = when.get("port")
    if wp is not None and port is not None:
        ports = [wp] if isinstance(wp, int) else wp
        if port not in ports:
            return False
    wt = when.get("topic")
    if wt is not None and topic is not None and not _topic_matches(wt, topic):
        return False
    return True


def _topic_matches(pattern, topic):
    p, t = pattern.split("/"), topic.split("/")
    for i, seg in enumerate(p):
        if seg == "#":
            return True
        if i >= len(t):
            return False
        if seg != "+" and seg != t[i]:
            return False
    return len(p) == len(t)


class _Reader:
    def __init__(self, spec, data):
        self.spec = spec
        self.data = data
        self.pos = 0
        self.end = len(data) * 8
        self.warnings = []
        self.path = ""

    def bits(self, n, little):
        """Read n bits MSB-first (little-endian byte order only when aligned and n % 8 == 0)."""
        if self.pos + n > self.end:
            raise CodecError("PAYLOAD_TOO_SHORT", "need %d bits at bit %d, payload has %d" % (n, self.pos, self.end), self.path)
        if self.pos % 8 == 0 and n % 8 == 0:
            start = self.pos // 8
            v = int.from_bytes(self.data[start:start + n // 8], "little" if little else "big")
        else:
            v = 0
            for k in range(n):
                p = self.pos + k
                v = (v << 1) | ((self.data[p >> 3] >> (7 - (p & 7))) & 1)
        self.pos += n
        return v


def _semantics(st, f, raw, path):
    if f["type"] == "bool":
        return raw != 0
    if isinstance(raw, (str, bool)):
        return raw
    enum = f.get("enum")
    if enum is not None:
        key = _fmt(raw)
        if key in enum:
            return enum[key]
        st.warnings.append("%s: unknown enum value %s" % (path, _fmt(raw)))
        return raw
    scale = f.get("scale")
    offset = f.get("offset")
    scale = 1 if scale is None else scale
    offset = 0 if offset is None else offset
    v = raw * scale + offset
    if f.get("decimals") is not None:
        v = _round(v, f["decimals"])
    elif not _is_int(scale) or not _is_int(offset):
        v = _round(v, 10)
    lo, hi = f.get("min"), f.get("max")
    if (lo is not None and v < lo) or (hi is not None and v > hi):
        st.warnings.append("%s: value %s outside [%s,%s]" % (path, _fmt(v), "-Infinity" if lo is None else _fmt(lo), "Infinity" if hi is None else _fmt(hi)))
    return v


def _byte_length(st, f, reserve):
    ln = f.get("length")
    if ln == "remaining":
        return max(0, (st.end - reserve - st.pos) // 8)
    if not isinstance(ln, int):
        raise CodecError("INVALID_SPEC", f["name"] + ": length required", st.path)
    return ln


def _read_scalar(st, f, reserve):
    little = _endian_little(st.spec, f)
    t = f["type"]
    if t in ("uint", "bool"):
        return _magnitude(st.bits(_scalar_bits(f), little), False)
    if t == "int":
        n = _scalar_bits(f)
        u = st.bits(n, little)
        if u >> (n - 1):
            return _magnitude((1 << n) - u, True)
        return _magnitude(u, False)
    if t == "float":
        n = _scalar_bits(f)
        if n not in (32, 64):
            raise CodecError("INVALID_SPEC", f["name"] + ": float must be 32 or 64 bits", st.path)
        u = st.bits(n, little)
        return struct.unpack(">f" if n == 32 else ">d", u.to_bytes(n // 8, "big"))[0]
    n = _byte_length(st, f, reserve)
    raw = st.bits(n * 8, False).to_bytes(n, "big") if n else b""
    if t == "bytes":
        return raw.hex()
    if t == "string":
        return raw.rstrip(b"\x00").decode("utf-8", errors="replace")
    if t == "bcd":
        out = []
        for x in raw:
            for nib in (x >> 4, x & 15):
                if nib != 15:
                    out.append("%x" % nib)
        return "".join(out)
    raise CodecError("INVALID_SPEC", f["name"] + ": unknown type " + str(t), st.path)


def _decode_fields(st, fields, out, raws, scopes, prefix, reserve):
    for i, f in enumerate(fields):
        kind = f.get("kind", "scalar")
        name = f["name"]
        path = prefix + name
        trailing = reserve + _trailing_bits(fields, i)
        st.path = path
        if kind == "scalar":
            raw = _read_scalar(st, f, trailing)
            raws[name] = raw
            if not f.get("hidden"):
                out[name] = _semantics(st, f, raw, path)
        elif kind == "const":
            cv = st.bits(f["bits"], _endian_little(st.spec, f))
            want = f["value"] + (1 << f["bits"]) if f["value"] < 0 else f["value"]
            if cv != want:
                raise CodecError("CONST_MISMATCH", "%s: expected %s, got %s" % (path, f["value"], cv), path)
            raws[name] = cv
        elif kind == "checksum":
            if st.pos % 8:
                raise CodecError("INVALID_SPEC", path + ": checksum must be byte-aligned", path)
            at = st.pos // 8
            width = _CHECKSUM_BYTES.get(f["algo"])
            if not width:
                raise CodecError("INVALID_SPEC", "unknown checksum " + str(f["algo"]), path)
            got = st.bits(width * 8, _endian_little(st.spec, f))
            calc = checksum(f["algo"], st.data[:at])
            if got != calc:
                raise CodecError("CHECKSUM_MISMATCH", "%s: %s expected %x, got %x" % (path, f["algo"], calc, got), path)
        elif kind == "group":
            go, gr = {}, {}
            raws[name] = gr
            _decode_fields(st, f["fields"], go, gr, scopes + [gr], path + ".", trailing)
            out[name] = go
        elif kind == "repeat":
            arr, rarr = [], []
            raws[name] = rarr
            count = -1
            c = f.get("count")
            if isinstance(c, int):
                count = c
            elif isinstance(c, dict):
                count = _resolve(scopes, c["ref"], path)
                if not _is_int(count) or count < 0:
                    raise CodecError("BAD_REFERENCE", "%s: count '%s' is not a non-negative integer" % (path, c["ref"]), path)
                count = int(count)
            k = 0
            while count < 0 or k < count:
                if count < 0 and st.end - trailing - st.pos < 8:
                    break
                start = st.pos
                io, ir = {}, {}
                rarr.append(ir)
                _decode_fields(st, f["fields"], io, ir, scopes + [ir], "%s[%d]." % (path, k), trailing)
                arr.append(io)
                k += 1
                if count < 0 and st.pos == start:
                    break
            out[name] = arr
        elif kind == "switch":
            on = _resolve(scopes, f["on"], path)
            chosen = _pick_case(f, on)
            if chosen is not None:
                _decode_fields(st, chosen, out, raws, scopes, prefix, trailing)
            else:
                st.warnings.append("%s: no case for %s" % (path, _fmt(on)))
        else:
            raise CodecError("INVALID_SPEC", "%s: unknown field kind %s" % (path, kind), path)


def _decode(data, port, topic, direction):
    data = bytes(data)
    errors, tried = [], 0
    for m in SPEC.get(direction) or []:
        if not _when_matches(m.get("when"), port, topic):
            continue
        tried += 1
        st = _Reader(SPEC, data)
        try:
            out, raws = {}, {}
            _decode_fields(st, m["fields"], out, raws, [raws], "", 0)
            used = (st.pos + 7) // 8
            if used < len(data):
                raise CodecError("TRAILING_BYTES", "%d unread byte(s)" % (len(data) - used))
            return {"ok": True, "message": m["name"], "data": out, "warnings": st.warnings}
        except CodecError as e:
            errors.append(e.to_dict(m["name"] + ": "))
    return {
        "ok": False,
        "errors": [{"code": "NO_MATCHING_MESSAGE", "message": "no message matched (%d candidate(s) tried)" % tried}] + errors,
        "warnings": [],
    }


# ------------------------------------------------------------------ encode

class _Writer:
    def __init__(self, spec):
        self.spec = spec
        self.buf = bytearray()
        self.pos = 0
        self.warnings = []
        self.errors = []

    def bits(self, value, n, little):
        """Write the low n bits of a non-negative integer MSB-first."""
        if self.pos % 8 == 0 and n % 8 == 0 and little:
            value = int.from_bytes(value.to_bytes(n // 8, "big"), "little")
        for k in range(n):
            p = self.pos + k
            while len(self.buf) <= (p >> 3):
                self.buf.append(0)
            if (value >> (n - 1 - k)) & 1:
                self.buf[p >> 3] |= 1 << (7 - (p & 7))
        self.pos += n


def _is_dec(s):
    s = s.strip()
    return s[1:].isdigit() if s.startswith("-") else s.isdigit()


def _int_bits(raw, n, signed):
    """Integer raw (int or decimal string) -> n-bit two's complement, or None if out of range."""
    if isinstance(raw, str):
        if not _is_dec(raw):
            return None
        raw = int(raw.strip())
    elif isinstance(raw, float):
        if raw != raw or abs(raw) >= 1e21:
            return None
        raw = int(Decimal(raw).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    if signed:
        if raw < -(1 << (n - 1)) or raw > (1 << (n - 1)) - 1:
            return None
        return raw & ((1 << n) - 1)
    if raw < 0 or raw > (1 << n) - 1:
        return None
    return raw


def _to_raw(f, v, path):
    """Inverse semantics pipeline: enum label -> key; else round((v - offset) / scale)."""
    if isinstance(v, bool) or f["type"] == "bool":
        return 1 if v else 0
    enum = f.get("enum")
    if enum is not None and isinstance(v, str):
        for k, label in enum.items():
            if label == v:
                return _parse_key(k)
        if not _is_dec(v):
            raise CodecError("ENCODE_OUT_OF_RANGE", "%s: unknown enum label '%s'" % (path, v), path)
    if isinstance(v, str):
        if _is_dec(v):
            return v.strip()
        raise CodecError("ENCODE_OUT_OF_RANGE", "%s: not a number: '%s'" % (path, v), path)
    if not isinstance(v, (int, float)) or v != v:
        raise CodecError("ENCODE_OUT_OF_RANGE", path + ": not a number", path)
    if enum is not None:
        return v
    scale = f.get("scale")
    offset = f.get("offset")
    scale = 1 if scale is None else scale
    offset = 0 if offset is None else offset
    if f["type"] == "float":
        return (v - offset) / scale
    if scale == 1 and offset == 0 and isinstance(v, int):
        return v
    return math.floor((v - offset) / scale + 0.5)


def _hex_to_bytes(s, path):
    if isinstance(s, (bytes, bytearray, list)):
        return bytearray(x & 255 for x in s)
    if not isinstance(s, str):
        raise CodecError("ENCODE_OUT_OF_RANGE", path + ": expected hex string", path)
    c = "".join(ch for ch in s if ch not in " \t\r\n:-")
    try:
        return bytearray(bytes.fromhex(c))
    except ValueError:
        raise CodecError("ENCODE_OUT_OF_RANGE", path + ": invalid hex", path)


def _write_scalar(w, f, v, path, missing):
    little = _endian_little(w.spec, f)
    t = f["type"]
    if t in ("uint", "int", "bool"):
        n = _scalar_bits(f)
        raw = 0 if missing else _to_raw(f, v, path)
        u = _int_bits(raw, n, t == "int")
        if u is None:
            raise CodecError("ENCODE_OUT_OF_RANGE", "%s: %s does not fit %s%d" % (path, _fmt(raw), t, n), path)
        w.bits(u, n, little)
        return raw
    if t == "float":
        n = _scalar_bits(f)
        x = 0.0 if missing else float(_to_raw(f, v, path))
        w.bits(int.from_bytes(struct.pack(">f" if n == 32 else ">d", x), "big"), n, little)
        return x
    if missing:
        data = bytearray()
    elif t == "bytes":
        data = _hex_to_bytes(v, path)
    elif t == "string":
        data = bytearray(str(v).encode("utf-8"))
    elif t == "bcd":
        ds = str(v)
        if any(ch not in "0123456789abcdeABCDE" for ch in ds):
            raise CodecError("ENCODE_OUT_OF_RANGE", path + ": invalid BCD digits", path)
        data = bytearray()
        for k in range(0, len(ds), 2):
            hi = int(ds[k], 16)
            lo = int(ds[k + 1], 16) if k + 1 < len(ds) else 15
            data.append((hi << 4) | lo)
    else:
        raise CodecError("INVALID_SPEC", "%s: unknown type %s" % (path, t), path)
    ln = f.get("length")
    if ln != "remaining":
        if not isinstance(ln, int):
            raise CodecError("INVALID_SPEC", path + ": length required", path)
        if len(data) > ln:
            raise CodecError("ENCODE_OUT_OF_RANGE", "%s: %d bytes exceed length %d" % (path, len(data), ln), path)
        while len(data) < ln:
            data.append(0xFF if t == "bcd" else 0)
    for x in data:
        w.bits(x, 8, False)
    return data.hex() if t == "bytes" else v


def _declares(fields, name):
    for f in fields:
        kind = f.get("kind", "scalar")
        if kind in ("scalar", "const") and f["name"] == name:
            return True
        if kind == "switch":
            for c in (f.get("cases") or {}).values():
                if _declares(c, name):
                    return True
            if f.get("default") and _declares(f["default"], name):
                return True
    return False


def _auto_counts(fields, obj, stack):
    """Semantics 7: a {ref} count field omitted by the caller is set to the array length."""
    for f in fields:
        if f.get("kind") != "repeat" or not isinstance(f.get("count"), dict):
            continue
        arr = obj.get(f["name"])
        if not isinstance(arr, (list, tuple)):
            continue
        ref = f["count"]["ref"]
        if "." in ref:
            parts = ref.split(".")
            cur = stack[0][0]
            for p in parts[:-1]:
                if not isinstance(cur, dict):
                    cur = None
                    break
                if cur.get(p) is None:
                    cur[p] = {}
                cur = cur[p]
            if isinstance(cur, dict) and cur.get(parts[-1]) is None:
                cur[parts[-1]] = len(arr)
        else:
            for sobj, sfields in reversed(stack):
                if _declares(sfields, ref):
                    if sobj.get(ref) is None:
                        sobj[ref] = len(arr)
                    break


def _encode_fields(w, fields, obj, raws, scopes, stack, prefix):
    _auto_counts(fields, obj, stack)
    for f in fields:
        kind = f.get("kind", "scalar")
        name = f["name"]
        path = prefix + name
        if kind == "scalar":
            v = obj.get(name)
            missing = False
            if v is None:
                if f.get("default") is not None:
                    v = f["default"]
                elif f.get("hidden"):
                    missing = True
                else:
                    w.errors.append(CodecError("ENCODE_MISSING_FIELD", "missing field " + path, path).to_dict())
                    missing = True
            try:
                raws[name] = _write_scalar(w, f, v, path, missing)
            except CodecError as e:
                if not e.code.startswith("ENCODE_"):
                    raise
                w.errors.append(e.to_dict())
                raws[name] = _write_scalar(w, f, None, path, True)
        elif kind == "const":
            u = _int_bits(f["value"] + (1 << f["bits"]) if f["value"] < 0 else f["value"], f["bits"], False)
            if u is None:
                raise CodecError("INVALID_SPEC", path + ": const does not fit", path)
            w.bits(u, f["bits"], _endian_little(w.spec, f))
            raws[name] = f["value"]
        elif kind == "checksum":
            if w.pos % 8:
                raise CodecError("INVALID_SPEC", path + ": checksum must be byte-aligned", path)
            width = _CHECKSUM_BYTES.get(f["algo"])
            if not width:
                raise CodecError("INVALID_SPEC", "unknown checksum " + str(f["algo"]), path)
            w.bits(checksum(f["algo"], bytes(w.buf[: w.pos // 8])), width * 8, _endian_little(w.spec, f))
        elif kind == "group":
            go = obj.get(name)
            if not isinstance(go, dict):
                go = obj[name] = {}
            gr = {}
            raws[name] = gr
            _encode_fields(w, f["fields"], go, gr, scopes + [gr], stack + [(go, f["fields"])], path + ".")
        elif kind == "repeat":
            arr = obj.get(name)
            if not isinstance(arr, (list, tuple)):
                w.errors.append(CodecError("ENCODE_MISSING_FIELD", "missing array " + path, path).to_dict())
                continue
            want = -1
            c = f.get("count")
            if isinstance(c, int):
                want = c
            elif isinstance(c, dict):
                want = _resolve(scopes, c["ref"], path)
            if _is_int(want) and want >= 0 and want != len(arr):
                w.errors.append(CodecError("ENCODE_OUT_OF_RANGE", "%s: expected %s items, got %d" % (path, _fmt(want), len(arr)), path).to_dict())
                continue
            rarr = []
            raws[name] = rarr
            for j, item in enumerate(arr):
                item = {} if item is None else item
                ir = {}
                rarr.append(ir)
                _encode_fields(w, f["fields"], item, ir, scopes + [ir], stack + [(item, f["fields"])], "%s[%d]." % (path, j))
        elif kind == "switch":
            on = _resolve(scopes, f["on"], path)
            chosen = _pick_case(f, on)
            if chosen is not None:
                _encode_fields(w, chosen, obj, raws, scopes, stack, prefix)
            else:
                w.warnings.append("%s: no case for %s" % (path, _fmt(on)))
        else:
            raise CodecError("INVALID_SPEC", "%s: unknown field kind %s" % (path, kind), path)


def decode(data, port=None, topic=None):
    """Decode an uplink payload.

    Returns {"ok": True, "message", "data", "warnings"} or {"ok": False, "errors", "warnings"}.
    """
    return _decode(data, port, topic, "uplink")


def decode_downlink(data, port=None):
    """Decode a downlink payload (e.g. to display queued commands)."""
    return _decode(data, port, None, "downlink")


def encode(message, data):
    """Encode a message (downlinks first, then uplinks).

    Returns {"ok": True, "bytes", "port", "warnings"} or {"ok": False, "errors", "warnings"}.
    """
    m = None
    for lst in (SPEC.get("downlink") or [], SPEC.get("uplink") or []):
        for cand in lst:
            if cand["name"] == message:
                m = cand
                break
        if m:
            break
    if m is None:
        return {"ok": False, "errors": [{"code": "NO_MATCHING_MESSAGE", "message": "unknown message '%s'" % message}], "warnings": []}
    w = _Writer(SPEC)
    try:
        obj = copy.deepcopy(dict(data or {}))
        raws = {}
        _encode_fields(w, m["fields"], obj, raws, [raws], [(obj, m["fields"])], "")
    except CodecError as e:
        w.errors.append(e.to_dict())
    if w.errors:
        return {"ok": False, "errors": w.errors, "warnings": w.warnings}
    res = {"ok": True, "bytes": bytes(w.buf), "warnings": w.warnings}
    port = (m.get("when") or {}).get("port")
    if port is not None:
        res["port"] = port if isinstance(port, int) else port[0]
    return res
`;

export function pyModule(spec: DeviceCodecSpec): string {
  return `dcs_${slug(spec)}`;
}

function pyJson(v: unknown): string {
  return JSON.stringify(v, null, 1).replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
}

function pyMain(spec: DeviceCodecSpec): string {
  return `${lineHeader(spec, "Python codec (stdlib only, Python 3.8+)", "#")}"""${spec.device.vendor} ${spec.device.model} payload codec (${spec.id} v${spec.version}).

    import ${pyModule(spec)} as codec
    r = codec.decode(bytes.fromhex("..."), port=1)
    # {"ok": True, "message": "...", "data": {...}, "warnings": []}
    e = codec.encode("<message>", {...})
    # {"ok": True, "bytes": b"...", "port": 1, "warnings": []}
"""
import copy
import json
import math
import struct
from decimal import Decimal, ROUND_HALF_UP

__all__ = ["decode", "decode_downlink", "encode", "checksum", "CodecError", "CODEC_ID", "CODEC_VERSION", "SPEC"]

CODEC_ID = ${JSON.stringify(spec.id)}
CODEC_VERSION = ${JSON.stringify(spec.version)}

# The Device Codec Spec this module interprets (layout + semantics).
SPEC = json.loads("""
${pyJson(runtimeSpec(spec))}
""")

${PY_ENGINE}`;
}

function pyTest(spec: DeviceCodecSpec): string {
  const mod = pyModule(spec);
  const vs = vectors(spec).map((v) => ({ ...v, hex: cleanHex(v.hex) }));
  return `${lineHeader(spec, "Python codec test vectors", "#")}"""Run: python -m unittest test_${mod}  (or: python test_${mod}.py)"""
import json
import unittest

import ${mod} as codec

VECTORS = json.loads("""
${pyJson(vs)}
""")


def same(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= 1e-9 * max(1, abs(a))
    if isinstance(a, list):
        return isinstance(b, list) and len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict):
        return isinstance(b, dict) and set(a) == set(b) and all(same(a[k], b[k]) for k in a)
    return a == b


class VectorTests(unittest.TestCase):
    def test_vectors(self):
        for v in VECTORS:
            with self.subTest(v["name"]):
                if v.get("direction") == "downlink":
                    r = codec.encode(v.get("message"), v["data"])
                    self.assertTrue(r["ok"], r)
                    self.assertEqual(r["bytes"].hex(), v["hex"])
                else:
                    r = codec.decode(bytes.fromhex(v["hex"]), v.get("port"), v.get("topic"))
                    self.assertTrue(r["ok"], r)
                    if v.get("message"):
                        self.assertEqual(r["message"], v["message"])
                    self.assertTrue(same(v["data"], r["data"]), (v["data"], r["data"]))
                    back = codec.encode(r["message"], r["data"])
                    self.assertTrue(back["ok"], back)
                    self.assertEqual(back["bytes"].hex(), v["hex"], "round-trip")


if __name__ == "__main__":
    unittest.main()
`;
}

export function generatePython(spec: DeviceCodecSpec): GeneratedFile[] {
  const mod = pyModule(spec);
  return [
    { path: `python/${mod}.py`, content: pyMain(spec) },
    { path: `python/test_${mod}.py`, content: pyTest(spec) },
  ];
}
