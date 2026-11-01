import type { DeviceCodecSpec } from "@hash8/dcs-schema";
import { blockHeader, cleanHex, runtimeSpec, slug, strLit, vectors, type GeneratedFile } from "../common";

/** Java 11 port of the JS engine (src/engine-js.ts) — keep function-for-function parity. */
const JAVA_ENGINE = String.raw`
    // ------------------------------------------------------------ result types

    /** A decode/encode failure with a stable code (see DCS semantics). */
    public static final class CodecError {
        public final String code;
        public final String message;
        public final String path;

        CodecError(String code, String message, String path) {
            this.code = code;
            this.message = message;
            this.path = path;
        }

        @Override
        public String toString() {
            return code + ": " + message;
        }
    }

    /** Result of decode: ok + message + data, or errors. */
    public static final class DecodeResult {
        public final boolean ok;
        public final String message;
        public final Map<String, Object> data;
        public final List<String> warnings;
        public final List<CodecError> errors;

        DecodeResult(boolean ok, String message, Map<String, Object> data, List<String> warnings, List<CodecError> errors) {
            this.ok = ok;
            this.message = message;
            this.data = data;
            this.warnings = warnings;
            this.errors = errors;
        }
    }

    /** Result of encode: ok + bytes (+ port), or errors. */
    public static final class EncodeResult {
        public final boolean ok;
        public final byte[] bytes;
        public final Integer port;
        public final List<String> warnings;
        public final List<CodecError> errors;

        EncodeResult(boolean ok, byte[] bytes, Integer port, List<String> warnings, List<CodecError> errors) {
            this.ok = ok;
            this.bytes = bytes;
            this.port = port;
            this.warnings = warnings;
            this.errors = errors;
        }
    }

    private static final class Fail extends RuntimeException {
        private static final long serialVersionUID = 1L;
        final transient CodecError error;

        Fail(String code, String message, String path) {
            super(message, null, false, false);
            this.error = new CodecError(code, message, path);
        }
    }

    private Codec() {
    }

    private static final Map<String, Object> SPEC = asMap(Json.parse(SPEC_JSON));
    private static final long TWO53 = 1L << 53;
    private static final Map<String, Integer> CHECKSUM_BYTES = new HashMap<>();

    static {
        CHECKSUM_BYTES.put("crc8", 1);
        CHECKSUM_BYTES.put("xor8", 1);
        CHECKSUM_BYTES.put("sum8", 1);
        CHECKSUM_BYTES.put("crc16-ccitt", 2);
        CHECKSUM_BYTES.put("crc16-modbus", 2);
        CHECKSUM_BYTES.put("crc32", 4);
    }

    // ------------------------------------------------------------ spec accessors

    @SuppressWarnings("unchecked")
    static Map<String, Object> asMap(Object o) {
        return o instanceof Map ? (Map<String, Object>) o : null;
    }

    @SuppressWarnings("unchecked")
    static List<Object> asList(Object o) {
        return o instanceof List ? (List<Object>) o : null;
    }

    private static String str(Map<String, Object> m, String k) {
        Object v = m == null ? null : m.get(k);
        return v instanceof String ? (String) v : "";
    }

    private static Double num(Map<String, Object> m, String k) {
        Object v = m == null ? null : m.get(k);
        return v instanceof Number ? ((Number) v).doubleValue() : null;
    }

    private static List<Object> list(Map<String, Object> m, String k) {
        List<Object> l = asList(m == null ? null : m.get(k));
        return l == null ? new ArrayList<>() : l;
    }

    private static String kindOf(Map<String, Object> f) {
        String k = str(f, "kind");
        return k.isEmpty() ? "scalar" : k;
    }

    private static <T> List<T> with(List<T> l, T x) {
        List<T> out = new ArrayList<>(l);
        out.add(x);
        return out;
    }

    private static double parseKey(String k) {
        String s = k.trim();
        boolean neg = s.startsWith("-");
        if (neg) s = s.substring(1);
        double v;
        try {
            v = s.toLowerCase(Locale.ROOT).startsWith("0x") ? (double) Long.parseUnsignedLong(s.substring(2), 16) : Double.parseDouble(s);
        } catch (NumberFormatException e) {
            return Double.NaN;
        }
        return neg ? -v : v;
    }

    static String fmtNum(double v) {
        if (v == Math.rint(v) && Math.abs(v) < 1e21) return new BigDecimal(v).toPlainString();
        double a = Math.abs(v);
        if (a >= 1e-6 && a < 1e21) return new BigDecimal(Double.toString(v)).stripTrailingZeros().toPlainString();
        return Double.toString(v);
    }

    private static String fmtAny(Object v) {
        return v instanceof Double ? fmtNum((Double) v) : String.valueOf(v);
    }

    /** Same as JavaScript Number(v.toFixed(d)): exact decimal value, ties away from zero. */
    static double roundFixed(double v, int d) {
        if (Double.isNaN(v) || Double.isInfinite(v) || Math.abs(v) >= 1e21) return v;
        return new BigDecimal(v).setScale(d, RoundingMode.HALF_UP).doubleValue();
    }

    private static boolean isInt(double x) {
        return x == Math.floor(x) && !Double.isInfinite(x);
    }

    private static boolean endianLittle(Map<String, Object> f) {
        String e = str(f, "endian");
        if (e.isEmpty()) e = str(asMap(SPEC.get("defaults")), "endian");
        return e.equals("little");
    }

    private static int scalarBits(Map<String, Object> f) {
        Double b = num(f, "bits");
        if (b != null && b > 0) return b.intValue();
        String t = str(f, "type");
        if (t.equals("bool")) return 1;
        if (t.equals("float")) return 32;
        return 8;
    }

    private static int trailingBits(List<Object> fields, int i) {
        int n = 0;
        for (int j = i + 1; j < fields.size(); j++) {
            Map<String, Object> g = asMap(fields.get(j));
            if (kindOf(g).equals("checksum")) n += 8 * CHECKSUM_BYTES.getOrDefault(str(g, "algo"), 0);
        }
        return n;
    }

    /** Computes a DCS checksum ("crc8", "crc16-ccitt", "crc16-modbus", "crc32", "xor8", "sum8") over b[0..len). */
    public static long checksum(String algo, byte[] b, int len) {
        long c = 0;
        switch (algo) {
            case "crc8":
                for (int i = 0; i < len; i++) {
                    c ^= b[i] & 0xFF;
                    for (int k = 0; k < 8; k++) c = (c & 0x80) != 0 ? ((c << 1) ^ 0x07) & 0xFF : (c << 1) & 0xFF;
                }
                break;
            case "crc16-ccitt":
                c = 0xFFFF;
                for (int i = 0; i < len; i++) {
                    c ^= (long) (b[i] & 0xFF) << 8;
                    for (int k = 0; k < 8; k++) c = (c & 0x8000) != 0 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
                }
                break;
            case "crc16-modbus":
                c = 0xFFFF;
                for (int i = 0; i < len; i++) {
                    c ^= b[i] & 0xFF;
                    for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? (c >>> 1) ^ 0xA001 : c >>> 1;
                }
                break;
            case "crc32":
                c = 0xFFFFFFFFL;
                for (int i = 0; i < len; i++) {
                    c ^= b[i] & 0xFF;
                    for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? (c >>> 1) ^ 0xEDB88320L : c >>> 1;
                }
                c ^= 0xFFFFFFFFL;
                break;
            case "xor8":
                for (int i = 0; i < len; i++) c ^= b[i] & 0xFF;
                break;
            case "sum8":
                for (int i = 0; i < len; i++) c = (c + (b[i] & 0xFF)) & 0xFF;
                break;
            default:
                throw new Fail("INVALID_SPEC", "unknown checksum " + algo, null);
        }
        return c;
    }

    /** Resolve a field reference against the raw-value scope chain (innermost last). */
    private static Object resolve(List<Map<String, Object>> scopes, String ref, String path) {
        if (ref.contains(".")) {
            Object cur = scopes.get(0);
            for (String p : ref.split("\\.")) {
                Map<String, Object> m = asMap(cur);
                List<Object> l = asList(cur);
                if (m != null && m.containsKey(p)) {
                    cur = m.get(p);
                } else if (l != null && p.matches("\\d+") && Integer.parseInt(p) < l.size()) {
                    cur = l.get(Integer.parseInt(p));
                } else {
                    throw new Fail("BAD_REFERENCE", "cannot resolve '" + ref + "'", path);
                }
            }
            return cur;
        }
        for (int s = scopes.size() - 1; s >= 0; s--) {
            if (scopes.get(s).containsKey(ref)) return scopes.get(s).get(ref);
        }
        throw new Fail("BAD_REFERENCE", "cannot resolve '" + ref + "'", path);
    }

    private static Object magnitude(long u, boolean neg) {
        if (Long.compareUnsigned(u, TWO53) <= 0) return neg ? -(double) u : (double) u;
        return (neg ? "-" : "") + Long.toUnsignedString(u);
    }

    private static List<Object> pickCase(Map<String, Object> f, Object on) {
        Map<String, Object> cases = asMap(f.get("cases"));
        if (cases != null) {
            for (Map.Entry<String, Object> e : cases.entrySet()) {
                if (on instanceof Double && parseKey(e.getKey()) == (Double) on) return asList(e.getValue());
                if (on instanceof String && e.getKey().equals(on)) return asList(e.getValue());
            }
        }
        return asList(f.get("default"));
    }

    private static boolean whenMatches(Map<String, Object> when, Integer port, String topic) {
        if (when == null) return true;
        Object wp = when.get("port");
        if (wp != null && port != null) {
            boolean match = false;
            if (wp instanceof Number) match = ((Number) wp).intValue() == port;
            List<Object> ports = asList(wp);
            if (ports != null) {
                for (Object x : ports) if (x instanceof Number && ((Number) x).intValue() == port) match = true;
            }
            if (!match) return false;
        }
        Object wt = when.get("topic");
        return !(wt instanceof String && topic != null && !topicMatches((String) wt, topic));
    }

    static boolean topicMatches(String pattern, String topic) {
        String[] p = pattern.split("/", -1);
        String[] t = topic.split("/", -1);
        for (int i = 0; i < p.length; i++) {
            if (p[i].equals("#")) return true;
            if (i >= t.length) return false;
            if (!p[i].equals("+") && !p[i].equals(t[i])) return false;
        }
        return p.length == t.length;
    }

    // ------------------------------------------------------------ decode

    private static final class Reader {
        final byte[] data;
        int pos;
        final int end;
        final List<String> warnings = new ArrayList<>();
        String path = "";

        Reader(byte[] data) {
            this.data = data;
            this.end = data.length * 8;
        }

        /** Reads n <= 64 bits MSB-first; bytes are reversed only for aligned whole-byte little-endian fields. */
        long bits(int n, boolean little) {
            if (pos + n > end) throw new Fail("PAYLOAD_TOO_SHORT", "need " + n + " bits at bit " + pos + ", payload has " + end, path);
            long v = 0;
            if (pos % 8 == 0 && n % 8 == 0) {
                int start = pos / 8;
                for (int i = 0; i < n / 8; i++) {
                    long b = data[start + i] & 0xFFL;
                    if (little) v |= b << (8 * i);
                    else v = (v << 8) | b;
                }
            } else {
                for (int k = 0; k < n; k++) {
                    int p = pos + k;
                    v = (v << 1) | ((data[p >> 3] >> (7 - (p & 7))) & 1);
                }
            }
            pos += n;
            return v;
        }

        byte[] bytes(int n) {
            if (pos + n * 8 > end) throw new Fail("PAYLOAD_TOO_SHORT", "need " + n + " bytes at bit " + pos + ", payload has " + end + " bits", path);
            byte[] out = new byte[n];
            for (int i = 0; i < n; i++) out[i] = (byte) bits(8, false);
            return out;
        }
    }

    private static Object semantics(Reader r, Map<String, Object> f, Object raw, String path) {
        if (str(f, "type").equals("bool")) {
            if (raw instanceof Double) return (Double) raw != 0;
            return !"0".equals(raw);
        }
        if (!(raw instanceof Double)) return raw;
        double x = (Double) raw;
        Map<String, Object> en = asMap(f.get("enum"));
        if (en != null) {
            Object label = en.get(fmtNum(x));
            if (label != null) return label;
            r.warnings.add(path + ": unknown enum value " + fmtNum(x));
            return x;
        }
        Double s = num(f, "scale");
        Double o = num(f, "offset");
        double scale = s == null ? 1 : s;
        double offset = o == null ? 0 : o;
        double v = x * scale + offset;
        Double d = num(f, "decimals");
        if (d != null) v = roundFixed(v, d.intValue());
        else if (!isInt(scale) || !isInt(offset)) v = roundFixed(v, 10);
        Double lo = num(f, "min");
        Double hi = num(f, "max");
        if ((lo != null && v < lo) || (hi != null && v > hi)) {
            r.warnings.add(path + ": value " + fmtNum(v) + " outside [" + (lo == null ? "-Infinity" : fmtNum(lo)) + "," + (hi == null ? "Infinity" : fmtNum(hi)) + "]");
        }
        return v;
    }

    private static int byteLength(Reader r, Map<String, Object> f, int reserve) {
        if ("remaining".equals(f.get("length"))) return Math.max(0, (r.end - reserve - r.pos) / 8);
        Double l = num(f, "length");
        if (l == null) throw new Fail("INVALID_SPEC", str(f, "name") + ": length required", r.path);
        return l.intValue();
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x & 0xFF));
        return sb.toString();
    }

    private static Object readScalar(Reader r, Map<String, Object> f, int reserve) {
        boolean little = endianLittle(f);
        String t = str(f, "type");
        switch (t) {
            case "uint":
            case "bool":
                return magnitude(r.bits(scalarBits(f), little), false);
            case "int": {
                int n = scalarBits(f);
                long u = r.bits(n, little);
                if (((u >>> (n - 1)) & 1) == 1) {
                    long mask = n == 64 ? -1L : (1L << n) - 1;
                    return magnitude((~u + 1) & mask, true);
                }
                return magnitude(u, false);
            }
            case "float": {
                int n = scalarBits(f);
                if (n != 32 && n != 64) throw new Fail("INVALID_SPEC", str(f, "name") + ": float must be 32 or 64 bits", r.path);
                long u = r.bits(n, little);
                return n == 32 ? (double) Float.intBitsToFloat((int) u) : Double.longBitsToDouble(u);
            }
            case "bytes":
                return hex(r.bytes(byteLength(r, f, reserve)));
            case "string": {
                byte[] b = r.bytes(byteLength(r, f, reserve));
                int e = b.length;
                while (e > 0 && b[e - 1] == 0) e--;
                return new String(b, 0, e, StandardCharsets.UTF_8);
            }
            case "bcd": {
                StringBuilder sb = new StringBuilder();
                for (byte x : r.bytes(byteLength(r, f, reserve))) {
                    int hi = (x >> 4) & 15;
                    int lo = x & 15;
                    if (hi != 15) sb.append(Integer.toHexString(hi));
                    if (lo != 15) sb.append(Integer.toHexString(lo));
                }
                return sb.toString();
            }
            default:
                throw new Fail("INVALID_SPEC", str(f, "name") + ": unknown type " + t, r.path);
        }
    }

    private static void decodeFields(Reader r, List<Object> fields, Map<String, Object> out, Map<String, Object> raws,
                                     List<Map<String, Object>> scopes, String prefix, int reserve) {
        for (int i = 0; i < fields.size(); i++) {
            Map<String, Object> f = asMap(fields.get(i));
            String name = str(f, "name");
            String path = prefix + name;
            int trailing = reserve + trailingBits(fields, i);
            r.path = path;
            String kind = kindOf(f);
            switch (kind) {
                case "scalar": {
                    Object raw = readScalar(r, f, trailing);
                    raws.put(name, raw);
                    if (!Boolean.TRUE.equals(f.get("hidden"))) out.put(name, semantics(r, f, raw, path));
                    break;
                }
                case "const": {
                    int bits = scalarBits(f);
                    long cv = r.bits(bits, endianLittle(f));
                    double value = num(f, "value");
                    long want = (long) value;
                    if (bits < 64) want &= (1L << bits) - 1;
                    if (cv != want) throw new Fail("CONST_MISMATCH", path + ": expected " + fmtNum(value) + ", got " + Long.toUnsignedString(cv), path);
                    raws.put(name, magnitude(cv, false));
                    break;
                }
                case "checksum": {
                    if (r.pos % 8 != 0) throw new Fail("INVALID_SPEC", path + ": checksum must be byte-aligned", path);
                    int at = r.pos / 8;
                    Integer width = CHECKSUM_BYTES.get(str(f, "algo"));
                    if (width == null) throw new Fail("INVALID_SPEC", "unknown checksum " + str(f, "algo"), path);
                    long got = r.bits(width * 8, endianLittle(f));
                    long calc = checksum(str(f, "algo"), r.data, at);
                    if (got != calc) {
                        throw new Fail("CHECKSUM_MISMATCH", path + ": " + str(f, "algo") + " expected " + Long.toHexString(calc) + ", got " + Long.toHexString(got), path);
                    }
                    break;
                }
                case "group": {
                    Map<String, Object> gout = new LinkedHashMap<>();
                    Map<String, Object> graw = new LinkedHashMap<>();
                    raws.put(name, graw);
                    decodeFields(r, list(f, "fields"), gout, graw, with(scopes, graw), path + ".", trailing);
                    out.put(name, gout);
                    break;
                }
                case "repeat": {
                    List<Object> arr = new ArrayList<>();
                    List<Object> rarr = new ArrayList<>();
                    raws.put(name, rarr);
                    int count = -1;
                    Object c = f.get("count");
                    if (c instanceof Number) {
                        count = ((Number) c).intValue();
                    } else if (asMap(c) != null) {
                        String ref = str(asMap(c), "ref");
                        Object v = resolve(scopes, ref, path);
                        if (!(v instanceof Double) || (Double) v < 0 || !isInt((Double) v)) {
                            throw new Fail("BAD_REFERENCE", path + ": count '" + ref + "' is not a non-negative integer", path);
                        }
                        count = ((Double) v).intValue();
                    }
                    for (int k = 0; count < 0 || k < count; k++) {
                        if (count < 0 && r.end - trailing - r.pos < 8) break;
                        int start = r.pos;
                        Map<String, Object> iout = new LinkedHashMap<>();
                        Map<String, Object> iraw = new LinkedHashMap<>();
                        rarr.add(iraw);
                        decodeFields(r, list(f, "fields"), iout, iraw, with(scopes, iraw), path + "[" + k + "].", trailing);
                        arr.add(iout);
                        if (count < 0 && r.pos == start) break;
                    }
                    out.put(name, arr);
                    break;
                }
                case "switch": {
                    Object on = resolve(scopes, str(f, "on"), path);
                    List<Object> chosen = pickCase(f, on);
                    if (chosen != null) decodeFields(r, chosen, out, raws, scopes, prefix, trailing);
                    else r.warnings.add(path + ": no case for " + fmtAny(on));
                    break;
                }
                default:
                    throw new Fail("INVALID_SPEC", path + ": unknown field kind " + kind, path);
            }
        }
    }

    private static DecodeResult decodeList(byte[] payload, Integer port, String topic, String direction) {
        List<CodecError> errors = new ArrayList<>();
        int tried = 0;
        for (Object mo : list(SPEC, direction)) {
            Map<String, Object> m = asMap(mo);
            if (!whenMatches(asMap(m.get("when")), port, topic)) continue;
            tried++;
            Reader r = new Reader(payload);
            try {
                Map<String, Object> out = new LinkedHashMap<>();
                Map<String, Object> raws = new LinkedHashMap<>();
                List<Map<String, Object>> scopes = new ArrayList<>();
                scopes.add(raws);
                decodeFields(r, list(m, "fields"), out, raws, scopes, "", 0);
                int used = (r.pos + 7) / 8;
                if (used < payload.length) throw new Fail("TRAILING_BYTES", (payload.length - used) + " unread byte(s)", null);
                return new DecodeResult(true, str(m, "name"), out, r.warnings, new ArrayList<>());
            } catch (Fail e) {
                errors.add(new CodecError(e.error.code, str(m, "name") + ": " + e.error.message, e.error.path));
            }
        }
        errors.add(0, new CodecError("NO_MATCHING_MESSAGE", "no message matched (" + tried + " candidate(s) tried)", null));
        return new DecodeResult(false, null, null, new ArrayList<>(), errors);
    }

    /** Decode an uplink payload. port (LoRaWAN fPort) and topic (MQTT) may be null. */
    public static DecodeResult decode(byte[] payload, Integer port, String topic) {
        return decodeList(payload, port, topic, "uplink");
    }

    /** Decode a downlink payload (e.g. to display queued commands). */
    public static DecodeResult decodeDownlink(byte[] payload, Integer port) {
        return decodeList(payload, port, null, "downlink");
    }

    // ------------------------------------------------------------ encode

    private static final class Writer {
        byte[] buf = new byte[16];
        int pos;
        final List<String> warnings = new ArrayList<>();
        final List<CodecError> errors = new ArrayList<>();

        /** Writes the low n <= 64 bits of v MSB-first. */
        void bits(long v, int n, boolean little) {
            if (pos % 8 == 0 && n % 8 == 0 && little) {
                long rv = 0;
                for (int i = 0; i < n / 8; i++) rv = (rv << 8) | ((v >>> (8 * i)) & 0xFF);
                v = rv;
            }
            for (int k = 0; k < n; k++) {
                int p = pos + k;
                if ((p >> 3) >= buf.length) buf = Arrays.copyOf(buf, buf.length * 2);
                if (((v >>> (n - 1 - k)) & 1) == 1) buf[p >> 3] |= (byte) (1 << (7 - (p & 7)));
            }
            pos += n;
        }

        int length() {
            return (pos + 7) / 8;
        }
    }

    private static boolean isDec(String s) {
        return s.trim().matches("-?\\d+");
    }

    /** Integer raw (Double or decimal String) -> n-bit two's complement, or null if out of range. */
    private static Long intBits(Object raw, int n, boolean signed) {
        BigInteger v;
        if (raw instanceof String) {
            if (!isDec((String) raw)) return null;
            v = new BigInteger(((String) raw).trim());
        } else if (raw instanceof Double) {
            double x = (Double) raw;
            if (Double.isNaN(x) || Math.abs(x) >= 1e21) return null;
            v = new BigDecimal(x).setScale(0, RoundingMode.HALF_UP).toBigInteger();
        } else {
            return null;
        }
        BigInteger one = BigInteger.ONE;
        if (signed) {
            BigInteger lo = one.shiftLeft(n - 1).negate();
            BigInteger hi = one.shiftLeft(n - 1).subtract(one);
            if (v.compareTo(lo) < 0 || v.compareTo(hi) > 0) return null;
            if (v.signum() < 0) v = v.add(one.shiftLeft(n));
            return v.longValue();
        }
        if (v.signum() < 0 || v.compareTo(one.shiftLeft(n).subtract(one)) > 0) return null;
        return v.longValue();
    }

    /** Caller numbers -> Double, or exact decimal String beyond 2^53. */
    private static Object normNumber(Number x) {
        if (x instanceof BigInteger || x instanceof Long) {
            BigInteger b = x instanceof BigInteger ? (BigInteger) x : BigInteger.valueOf(x.longValue());
            if (b.abs().compareTo(BigInteger.valueOf(TWO53)) > 0) return b.toString();
            return b.doubleValue();
        }
        if (x instanceof BigDecimal) return x.doubleValue();
        return x.doubleValue();
    }

    /** Inverse semantics pipeline: enum label -> key; else round((v - offset) / scale). */
    private static Object toRaw(Map<String, Object> f, Object v, String path) {
        if (v instanceof Boolean) return (Boolean) v ? 1.0 : 0.0;
        if (str(f, "type").equals("bool")) {
            if (v instanceof Number) return ((Number) v).doubleValue() != 0 ? 1.0 : 0.0;
            return v == null || "".equals(v) || "0".equals(v) ? 0.0 : 1.0;
        }
        Map<String, Object> en = asMap(f.get("enum"));
        if (v instanceof String) {
            String s = (String) v;
            if (en != null) {
                for (Map.Entry<String, Object> e : en.entrySet()) {
                    if (s.equals(e.getValue())) return parseKey(e.getKey());
                }
                if (!isDec(s)) throw new Fail("ENCODE_OUT_OF_RANGE", path + ": unknown enum label '" + s + "'", path);
            }
            if (isDec(s)) return s.trim();
            throw new Fail("ENCODE_OUT_OF_RANGE", path + ": not a number: '" + s + "'", path);
        }
        if (!(v instanceof Number)) throw new Fail("ENCODE_OUT_OF_RANGE", path + ": not a number", path);
        Object nv = normNumber((Number) v);
        if (nv instanceof String) return nv;
        double x = (Double) nv;
        if (Double.isNaN(x)) throw new Fail("ENCODE_OUT_OF_RANGE", path + ": not a number", path);
        if (en != null) return x;
        Double s = num(f, "scale");
        Double o = num(f, "offset");
        double scale = s == null ? 1 : s;
        double offset = o == null ? 0 : o;
        if (str(f, "type").equals("float")) return (x - offset) / scale;
        return Math.floor((x - offset) / scale + 0.5);
    }

    private static byte[] hexToBytes(Object v, String path) {
        if (v instanceof byte[]) return ((byte[]) v).clone();
        if (!(v instanceof String)) throw new Fail("ENCODE_OUT_OF_RANGE", path + ": expected hex string", path);
        String c = ((String) v).replaceAll("[\\s:-]", "");
        if (c.length() % 2 != 0 || !c.matches("[0-9a-fA-F]*")) throw new Fail("ENCODE_OUT_OF_RANGE", path + ": invalid hex", path);
        byte[] out = new byte[c.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(c.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    private static Object writeScalar(Writer w, Map<String, Object> f, Object v, String path, boolean missing) {
        boolean little = endianLittle(f);
        String t = str(f, "type");
        if (t.equals("uint") || t.equals("int") || t.equals("bool")) {
            int n = scalarBits(f);
            Object raw = missing ? (Object) 0.0 : toRaw(f, v, path);
            Long u = intBits(raw, n, t.equals("int"));
            if (u == null) throw new Fail("ENCODE_OUT_OF_RANGE", path + ": " + fmtAny(raw) + " does not fit " + t + n, path);
            w.bits(u, n, little);
            return raw;
        }
        if (t.equals("float")) {
            int n = scalarBits(f);
            Object raw = missing ? (Object) 0.0 : toRaw(f, v, path);
            double x = raw instanceof Double ? (Double) raw : Double.parseDouble((String) raw);
            if (n == 32) w.bits(Float.floatToIntBits((float) x) & 0xFFFFFFFFL, 32, little);
            else w.bits(Double.doubleToLongBits(x), 64, little);
            return x;
        }
        byte[] data;
        if (missing) {
            data = new byte[0];
        } else if (t.equals("bytes")) {
            data = hexToBytes(v, path);
        } else if (t.equals("string")) {
            data = String.valueOf(v).getBytes(StandardCharsets.UTF_8);
        } else if (t.equals("bcd")) {
            String ds = String.valueOf(v).toLowerCase(Locale.ROOT);
            if (!ds.matches("[0-9a-e]*")) throw new Fail("ENCODE_OUT_OF_RANGE", path + ": invalid BCD digits", path);
            data = new byte[(ds.length() + 1) / 2];
            for (int k = 0; k < ds.length(); k += 2) {
                int hi = Character.digit(ds.charAt(k), 16);
                int lo = k + 1 < ds.length() ? Character.digit(ds.charAt(k + 1), 16) : 15;
                data[k / 2] = (byte) ((hi << 4) | lo);
            }
        } else {
            throw new Fail("INVALID_SPEC", path + ": unknown type " + t, path);
        }
        if (!"remaining".equals(f.get("length"))) {
            Double l = num(f, "length");
            if (l == null) throw new Fail("INVALID_SPEC", path + ": length required", path);
            int len = l.intValue();
            if (data.length > len) throw new Fail("ENCODE_OUT_OF_RANGE", path + ": " + data.length + " bytes exceed length " + len, path);
            int had = data.length;
            data = Arrays.copyOf(data, len);
            if (t.equals("bcd")) for (int k = had; k < len; k++) data[k] = (byte) 0xFF;
        }
        for (byte b : data) w.bits(b & 0xFF, 8, false);
        return t.equals("bytes") ? hex(data) : v;
    }

    /** Records ENCODE_* failures and writes a zero placeholder so encoding can report every error. */
    private static Object writeScalarSafe(Writer w, Map<String, Object> f, Object v, String path, boolean missing) {
        try {
            return writeScalar(w, f, v, path, missing);
        } catch (Fail e) {
            if (!e.error.code.startsWith("ENCODE_")) throw e;
            w.errors.add(e.error);
            return writeScalar(w, f, null, path, true);
        }
    }

    private static boolean declares(List<Object> fields, String name) {
        for (Object fo : fields) {
            Map<String, Object> f = asMap(fo);
            String kind = kindOf(f);
            if ((kind.equals("scalar") || kind.equals("const")) && str(f, "name").equals(name)) return true;
            if (kind.equals("switch")) {
                Map<String, Object> cases = asMap(f.get("cases"));
                if (cases != null) for (Object c : cases.values()) if (asList(c) != null && declares(asList(c), name)) return true;
                if (asList(f.get("default")) != null && declares(asList(f.get("default")), name)) return true;
            }
        }
        return false;
    }

    private static final class Frame {
        final Map<String, Object> obj;
        final List<Object> fields;

        Frame(Map<String, Object> obj, List<Object> fields) {
            this.obj = obj;
            this.fields = fields;
        }
    }

    /** Semantics 7: a {ref} count field omitted by the caller is set to the array length. */
    private static void autoCounts(List<Object> fields, Map<String, Object> obj, List<Frame> stack) {
        for (Object fo : fields) {
            Map<String, Object> f = asMap(fo);
            Map<String, Object> c = asMap(f.get("count"));
            if (!kindOf(f).equals("repeat") || c == null) continue;
            List<Object> arr = asList(obj.get(str(f, "name")));
            if (arr == null) continue;
            String ref = str(c, "ref");
            if (ref.contains(".")) {
                String[] parts = ref.split("\\.");
                Map<String, Object> cur = stack.get(0).obj;
                for (int p = 0; p < parts.length - 1 && cur != null; p++) {
                    Map<String, Object> next = asMap(cur.get(parts[p]));
                    if (next == null && cur.get(parts[p]) == null) {
                        next = new LinkedHashMap<>();
                        cur.put(parts[p], next);
                    }
                    cur = next;
                }
                if (cur != null && cur.get(parts[parts.length - 1]) == null) cur.put(parts[parts.length - 1], (double) arr.size());
            } else {
                for (int s = stack.size() - 1; s >= 0; s--) {
                    if (declares(stack.get(s).fields, ref)) {
                        if (stack.get(s).obj.get(ref) == null) stack.get(s).obj.put(ref, (double) arr.size());
                        break;
                    }
                }
            }
        }
    }

    private static void encodeFields(Writer w, List<Object> fields, Map<String, Object> obj, Map<String, Object> raws,
                                     List<Map<String, Object>> scopes, List<Frame> stack, String prefix) {
        autoCounts(fields, obj, stack);
        for (Object fo : fields) {
            Map<String, Object> f = asMap(fo);
            String name = str(f, "name");
            String path = prefix + name;
            String kind = kindOf(f);
            switch (kind) {
                case "scalar": {
                    Object v = obj.get(name);
                    boolean missing = false;
                    if (v == null) {
                        if (f.get("default") != null) {
                            v = f.get("default");
                        } else if (Boolean.TRUE.equals(f.get("hidden"))) {
                            missing = true;
                        } else {
                            w.errors.add(new CodecError("ENCODE_MISSING_FIELD", "missing field " + path, path));
                            missing = true;
                        }
                    }
                    raws.put(name, writeScalarSafe(w, f, v, path, missing));
                    break;
                }
                case "const": {
                    int bits = scalarBits(f);
                    double value = num(f, "value");
                    long u = (long) value;
                    if (bits < 64) u &= (1L << bits) - 1;
                    w.bits(u, bits, endianLittle(f));
                    raws.put(name, value);
                    break;
                }
                case "checksum": {
                    if (w.pos % 8 != 0) throw new Fail("INVALID_SPEC", path + ": checksum must be byte-aligned", path);
                    Integer width = CHECKSUM_BYTES.get(str(f, "algo"));
                    if (width == null) throw new Fail("INVALID_SPEC", "unknown checksum " + str(f, "algo"), path);
                    w.bits(checksum(str(f, "algo"), w.buf, w.pos / 8), width * 8, endianLittle(f));
                    break;
                }
                case "group": {
                    Map<String, Object> g = asMap(obj.get(name));
                    if (g == null) {
                        g = new LinkedHashMap<>();
                        obj.put(name, g);
                    }
                    Map<String, Object> graw = new LinkedHashMap<>();
                    raws.put(name, graw);
                    encodeFields(w, list(f, "fields"), g, graw, with(scopes, graw), with(stack, new Frame(g, list(f, "fields"))), path + ".");
                    break;
                }
                case "repeat": {
                    List<Object> arr = asList(obj.get(name));
                    if (arr == null) {
                        w.errors.add(new CodecError("ENCODE_MISSING_FIELD", "missing array " + path, path));
                        break;
                    }
                    double want = -1;
                    Object c = f.get("count");
                    if (c instanceof Number) {
                        want = ((Number) c).doubleValue();
                    } else if (asMap(c) != null) {
                        Object x = resolve(scopes, str(asMap(c), "ref"), path);
                        if (x instanceof Double) want = (Double) x;
                    }
                    if (want >= 0 && want != arr.size()) {
                        w.errors.add(new CodecError("ENCODE_OUT_OF_RANGE", path + ": expected " + fmtNum(want) + " items, got " + arr.size(), path));
                        break;
                    }
                    List<Object> rarr = new ArrayList<>();
                    raws.put(name, rarr);
                    for (int j = 0; j < arr.size(); j++) {
                        Map<String, Object> item = asMap(arr.get(j));
                        if (item == null) item = new LinkedHashMap<>();
                        Map<String, Object> iraw = new LinkedHashMap<>();
                        rarr.add(iraw);
                        encodeFields(w, list(f, "fields"), item, iraw, with(scopes, iraw), with(stack, new Frame(item, list(f, "fields"))), path + "[" + j + "].");
                    }
                    break;
                }
                case "switch": {
                    Object on = resolve(scopes, str(f, "on"), path);
                    List<Object> chosen = pickCase(f, on);
                    if (chosen != null) encodeFields(w, chosen, obj, raws, scopes, stack, prefix);
                    else w.warnings.add(path + ": no case for " + fmtAny(on));
                    break;
                }
                default:
                    throw new Fail("INVALID_SPEC", path + ": unknown field kind " + kind, path);
            }
        }
    }

    /** Deep copy of caller data into mutable LinkedHashMap / ArrayList. */
    private static Object copy(Object v) {
        Map<String, Object> m = asMap(v);
        if (m != null) {
            Map<String, Object> out = new LinkedHashMap<>();
            for (Map.Entry<String, Object> e : m.entrySet()) out.put(e.getKey(), copy(e.getValue()));
            return out;
        }
        if (v instanceof List) {
            List<Object> out = new ArrayList<>();
            for (Object x : (List<?>) v) out.add(copy(x));
            return out;
        }
        return v;
    }

    /** Encode a message by name (downlinks first, then uplinks — useful for simulators). */
    public static EncodeResult encode(String message, Map<String, Object> data) {
        Map<String, Object> m = null;
        for (String dir : new String[] {"downlink", "uplink"}) {
            for (Object mo : list(SPEC, dir)) {
                if (m == null && str(asMap(mo), "name").equals(message)) m = asMap(mo);
            }
        }
        if (m == null) {
            List<CodecError> errs = new ArrayList<>();
            errs.add(new CodecError("NO_MATCHING_MESSAGE", "unknown message '" + message + "'", null));
            return new EncodeResult(false, null, null, new ArrayList<>(), errs);
        }
        Writer w = new Writer();
        try {
            Map<String, Object> obj = asMap(copy(data == null ? new LinkedHashMap<String, Object>() : data));
            Map<String, Object> raws = new LinkedHashMap<>();
            List<Map<String, Object>> scopes = new ArrayList<>();
            scopes.add(raws);
            List<Frame> stack = new ArrayList<>();
            stack.add(new Frame(obj, list(m, "fields")));
            encodeFields(w, list(m, "fields"), obj, raws, scopes, stack, "");
        } catch (Fail e) {
            w.errors.add(e.error);
        }
        if (!w.errors.isEmpty()) return new EncodeResult(false, null, null, w.warnings, w.errors);
        Integer port = null;
        Object p = asMap(m.get("when")) == null ? null : asMap(m.get("when")).get("port");
        if (p instanceof Number) port = ((Number) p).intValue();
        else if (asList(p) != null && !asList(p).isEmpty()) port = ((Number) asList(p).get(0)).intValue();
        return new EncodeResult(true, Arrays.copyOf(w.buf, w.length()), port, w.warnings, new ArrayList<>());
    }

/** Minimal JSON reader (objects -> LinkedHashMap, arrays -> ArrayList, numbers -> Double). */
static final class Json {
    private final String s;
    private int i;

    private Json(String s) {
        this.s = s;
    }

    static Object parse(String s) {
        Json j = new Json(s);
        j.ws();
        Object v = j.value();
        j.ws();
        if (j.i != s.length()) throw new IllegalArgumentException("trailing characters at " + j.i);
        return v;
    }

    private void ws() {
        while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
    }

    private void expect(char c) {
        if (i >= s.length() || s.charAt(i) != c) throw new IllegalArgumentException("expected '" + c + "' at " + i);
        i++;
    }

    private Object value() {
        char c = s.charAt(i);
        if (c == '{') {
            i++;
            Map<String, Object> m = new LinkedHashMap<>();
            ws();
            if (s.charAt(i) == '}') {
                i++;
                return m;
            }
            while (true) {
                ws();
                String k = string();
                ws();
                expect(':');
                ws();
                m.put(k, value());
                ws();
                if (s.charAt(i) == ',') {
                    i++;
                    continue;
                }
                expect('}');
                return m;
            }
        }
        if (c == '[') {
            i++;
            List<Object> l = new ArrayList<>();
            ws();
            if (s.charAt(i) == ']') {
                i++;
                return l;
            }
            while (true) {
                ws();
                l.add(value());
                ws();
                if (s.charAt(i) == ',') {
                    i++;
                    continue;
                }
                expect(']');
                return l;
            }
        }
        if (c == '"') return string();
        if (s.startsWith("true", i)) {
            i += 4;
            return Boolean.TRUE;
        }
        if (s.startsWith("false", i)) {
            i += 5;
            return Boolean.FALSE;
        }
        if (s.startsWith("null", i)) {
            i += 4;
            return null;
        }
        int start = i;
        while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
        return Double.parseDouble(s.substring(start, i));
    }

    private String string() {
        expect('"');
        StringBuilder b = new StringBuilder();
        while (true) {
            char c = s.charAt(i++);
            if (c == '"') return b.toString();
            if (c != '\\') {
                b.append(c);
                continue;
            }
            char e = s.charAt(i++);
            switch (e) {
                case 'n': b.append('\n'); break;
                case 't': b.append('\t'); break;
                case 'r': b.append('\r'); break;
                case 'b': b.append('\b'); break;
                case 'f': b.append('\f'); break;
                case 'u':
                    b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                    i += 4;
                    break;
                default: b.append(e);
            }
        }
    }
}
}
`;

export function javaPackage(spec: DeviceCodecSpec): string {
  const s = slug(spec);
  return `dev.hash8.codecs.${/^[a-z]/.test(s) ? s : `c_${s}`}`;
}

/** Java string expression for arbitrary text, split into readable chunks (avoids the 64 KB constant limit). */
function javaString(text: string, indent: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 100) chunks.push(strLit(text.slice(i, i + 100)));
  if (chunks.length <= 1) return chunks[0] ?? '""';
  return `String.join("",\n${chunks.map((c) => `${indent}${c}`).join(",\n")})`;
}

function javaMain(spec: DeviceCodecSpec): string {
  const pkg = javaPackage(spec);
  return `${blockHeader(spec, "Java codec (Java 11+, no dependencies)")}package ${pkg};

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * ${spec.device.vendor} ${spec.device.model} payload codec.
 *
 * <pre>
 * Codec.DecodeResult r = Codec.decode(payload, 1, null);
 * if (r.ok) System.out.println(r.message + " " + r.data);
 * Codec.EncodeResult e = Codec.encode("&lt;message&gt;", data);
 * </pre>
 */
public final class Codec {
    public static final String CODEC_ID = ${strLit(spec.id)};
    public static final String CODEC_VERSION = ${strLit(spec.version)};

    /** The Device Codec Spec this class interprets (layout + semantics). */
    static final String SPEC_JSON = ${javaString(JSON.stringify(runtimeSpec(spec)), "            ")};
${JAVA_ENGINE}`;
}

function javaTest(spec: DeviceCodecSpec): string {
  const pkg = javaPackage(spec);
  const vs = vectors(spec).map((v) => ({ ...v, hex: cleanHex(v.hex) }));
  return `${blockHeader(spec, "Java codec test vectors")}package ${pkg};

import java.util.List;
import java.util.Map;

/** Runs every test vector of the spec. Exit code 1 on failure (no test framework needed). */
public final class CodecTest {
    static final String VECTORS_JSON = ${javaString(JSON.stringify(vs), "            ")};

    static boolean same(Object a, Object b) {
        if (a instanceof Double && b instanceof Double) {
            double x = (Double) a, y = (Double) b;
            return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x));
        }
        if (a instanceof List) {
            if (!(b instanceof List) || ((List<?>) a).size() != ((List<?>) b).size()) return false;
            for (int i = 0; i < ((List<?>) a).size(); i++) if (!same(((List<?>) a).get(i), ((List<?>) b).get(i))) return false;
            return true;
        }
        if (a instanceof Map) {
            if (!(b instanceof Map) || ((Map<?, ?>) a).size() != ((Map<?, ?>) b).size()) return false;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) a).entrySet()) if (!same(e.getValue(), ((Map<?, ?>) b).get(e.getKey()))) return false;
            return true;
        }
        return a == null ? b == null : a.equals(b);
    }

    static byte[] unhex(String h) {
        byte[] out = new byte[h.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(h.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x & 0xFF));
        return sb.toString();
    }

    public static void main(String[] args) {
        int failed = 0;
        for (Object vo : Codec.asList(Codec.Json.parse(VECTORS_JSON))) {
            Map<String, Object> v = Codec.asMap(vo);
            String name = (String) v.get("name");
            String hexStr = (String) v.get("hex");
            String message = (String) v.get("message");
            Map<String, Object> data = Codec.asMap(v.get("data"));
            boolean ok;
            if ("downlink".equals(v.get("direction"))) {
                Codec.EncodeResult r = Codec.encode(message, data);
                ok = r.ok && hex(r.bytes).equals(hexStr);
            } else {
                Integer port = v.get("port") == null ? null : ((Double) v.get("port")).intValue();
                Codec.DecodeResult r = Codec.decode(unhex(hexStr), port, (String) v.get("topic"));
                ok = r.ok && (message == null || message.equals(r.message)) && same(data, r.data);
                if (r.ok) {
                    Codec.EncodeResult back = Codec.encode(r.message, r.data);
                    ok = ok && back.ok && hex(back.bytes).equals(hexStr);
                } else {
                    System.out.println("  errors: " + r.errors);
                }
            }
            System.out.println((ok ? "ok   " : "FAIL ") + name);
            if (!ok) failed++;
        }
        if (failed > 0) {
            System.out.println(failed + " vector(s) failed");
            System.exit(1);
        }
    }
}
`;
}

export function generateJava(spec: DeviceCodecSpec): GeneratedFile[] {
  const dir = javaPackage(spec).replace(/\./g, "/");
  return [
    { path: `java/src/main/java/${dir}/Codec.java`, content: javaMain(spec) },
    { path: `java/src/test/java/${dir}/CodecTest.java`, content: javaTest(spec) },
  ];
}
