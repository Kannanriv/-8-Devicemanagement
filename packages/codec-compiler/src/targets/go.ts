import type { DeviceCodecSpec } from "@hash8/dcs-schema";
import { cleanHex, lineHeader, runtimeSpec, slug, vectors, type GeneratedFile } from "../common";

/** Go port of the JS engine (src/engine-js.ts) — keep function-for-function parity. */
const GO_ENGINE = String.raw`
// CodecError is a decode/encode failure with a stable code (see DCS semantics).
type CodecError struct {
	Code    string ` + "`json:\"code\"`" + String.raw`
	Message string ` + "`json:\"message\"`" + String.raw`
	Path    string ` + "`json:\"path,omitempty\"`" + String.raw`
}

func (e *CodecError) Error() string { return e.Code + ": " + e.Message }

// Result of Decode. On success OK is true and Message/Data are set; otherwise Errors explains why.
type Result struct {
	OK       bool           ` + "`json:\"ok\"`" + String.raw`
	Message  string         ` + "`json:\"message,omitempty\"`" + String.raw`
	Data     map[string]any ` + "`json:\"data,omitempty\"`" + String.raw`
	Warnings []string       ` + "`json:\"warnings\"`" + String.raw`
	Errors   []CodecError   ` + "`json:\"errors,omitempty\"`" + String.raw`
}

// EncodeResult of Encode. Port is the message's first when.port, if any.
type EncodeResult struct {
	OK       bool         ` + "`json:\"ok\"`" + String.raw`
	Bytes    []byte       ` + "`json:\"bytes,omitempty\"`" + String.raw`
	Port     *int         ` + "`json:\"port,omitempty\"`" + String.raw`
	Warnings []string     ` + "`json:\"warnings\"`" + String.raw`
	Errors   []CodecError ` + "`json:\"errors,omitempty\"`" + String.raw`
}

// Port is a convenience for passing a literal port to Decode: Decode(b, Port(1), "").
func Port(p int) *int { return &p }

var spec map[string]any

func init() {
	if err := json.Unmarshal([]byte(specJSON), &spec); err != nil {
		panic("invalid embedded spec: " + err.Error())
	}
}

var checksumBytes = map[string]int{"crc8": 1, "xor8": 1, "sum8": 1, "crc16-ccitt": 2, "crc16-modbus": 2, "crc32": 4}

const two53 = uint64(1) << 53

func fail(code, message, path string) {
	panic(&CodecError{Code: code, Message: message, Path: path})
}

// ---------------------------------------------------------------- spec accessors

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

func num(m map[string]any, k string) (float64, bool) {
	v, ok := m[k].(float64)
	return v, ok
}

func list(m map[string]any, k string) []any {
	l, _ := m[k].([]any)
	return l
}

func kindOf(f map[string]any) string {
	if k := str(f, "kind"); k != "" {
		return k
	}
	return "scalar"
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func withScope(scopes []map[string]any, s map[string]any) []map[string]any {
	out := make([]map[string]any, len(scopes)+1)
	copy(out, scopes)
	out[len(scopes)] = s
	return out
}

func parseKey(k string) float64 {
	s := strings.TrimSpace(k)
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	var v float64
	if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
		n, err := strconv.ParseUint(s[2:], 16, 64)
		if err != nil {
			return math.NaN()
		}
		v = float64(n)
	} else {
		n, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return math.NaN()
		}
		v = n
	}
	if neg {
		return -v
	}
	return v
}

func fmtNum(v float64) string {
	a := math.Abs(v)
	if a == 0 || (a >= 1e-6 && a < 1e21) {
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}

func fmtAny(v any) string {
	switch x := v.(type) {
	case float64:
		return fmtNum(x)
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	}
	return fmt.Sprint(v)
}

// roundFixed matches JavaScript Number(v.toFixed(d)): exact decimal value, ties away from zero.
func roundFixed(v float64, d int) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) >= 1e21 {
		return v
	}
	s := strconv.FormatFloat(math.Abs(v), 'f', d+30, 64)
	dot := strings.IndexByte(s, '.')
	digits := []byte(s[:dot] + s[dot+1:dot+1+d])
	if s[dot+1+d] >= '5' {
		i := len(digits) - 1
		for ; i >= 0; i-- {
			if digits[i] == '9' {
				digits[i] = '0'
				continue
			}
			digits[i]++
			break
		}
		if i < 0 {
			digits = append([]byte{'1'}, digits...)
		}
	}
	intLen := len(digits) - d
	out := string(digits[:intLen])
	if d > 0 {
		out += "." + string(digits[intLen:])
	}
	r, _ := strconv.ParseFloat(out, 64)
	if v < 0 {
		return -r
	}
	return r
}

func isInt(x float64) bool { return x == math.Floor(x) && !math.IsInf(x, 0) }

func endianLittle(f map[string]any) bool {
	e := str(f, "endian")
	if e == "" {
		e = str(asMap(spec["defaults"]), "endian")
	}
	return e == "little"
}

func scalarBits(f map[string]any) int {
	if b, ok := num(f, "bits"); ok && b > 0 {
		return int(b)
	}
	switch str(f, "type") {
	case "bool":
		return 1
	case "float":
		return 32
	}
	return 8
}

func trailingBits(fields []any, i int) int {
	n := 0
	for _, g := range fields[i+1:] {
		gm := asMap(g)
		if kindOf(gm) == "checksum" {
			n += 8 * checksumBytes[str(gm, "algo")]
		}
	}
	return n
}

// Checksum computes a DCS checksum ("crc8", "crc16-ccitt", "crc16-modbus", "crc32", "xor8", "sum8").
func Checksum(algo string, b []byte) uint32 {
	var c uint32
	switch algo {
	case "crc8":
		for _, x := range b {
			c ^= uint32(x)
			for k := 0; k < 8; k++ {
				if c&0x80 != 0 {
					c = ((c << 1) ^ 0x07) & 0xFF
				} else {
					c = (c << 1) & 0xFF
				}
			}
		}
	case "crc16-ccitt":
		c = 0xFFFF
		for _, x := range b {
			c ^= uint32(x) << 8
			for k := 0; k < 8; k++ {
				if c&0x8000 != 0 {
					c = ((c << 1) ^ 0x1021) & 0xFFFF
				} else {
					c = (c << 1) & 0xFFFF
				}
			}
		}
	case "crc16-modbus":
		c = 0xFFFF
		for _, x := range b {
			c ^= uint32(x)
			for k := 0; k < 8; k++ {
				if c&1 != 0 {
					c = (c >> 1) ^ 0xA001
				} else {
					c >>= 1
				}
			}
		}
	case "crc32":
		c = 0xFFFFFFFF
		for _, x := range b {
			c ^= uint32(x)
			for k := 0; k < 8; k++ {
				if c&1 != 0 {
					c = (c >> 1) ^ 0xEDB88320
				} else {
					c >>= 1
				}
			}
		}
		c ^= 0xFFFFFFFF
	case "xor8":
		for _, x := range b {
			c ^= uint32(x)
		}
	case "sum8":
		for _, x := range b {
			c = (c + uint32(x)) & 0xFF
		}
	default:
		fail("INVALID_SPEC", "unknown checksum "+algo, "")
	}
	return c
}

// resolve looks a field reference up in the raw-value scope chain (innermost last).
func resolve(scopes []map[string]any, ref, path string) any {
	if strings.Contains(ref, ".") {
		var cur any = scopes[0]
		for _, p := range strings.Split(ref, ".") {
			switch c := cur.(type) {
			case map[string]any:
				v, ok := c[p]
				if !ok {
					fail("BAD_REFERENCE", "cannot resolve '"+ref+"'", path)
				}
				cur = v
			case []any:
				i, err := strconv.Atoi(p)
				if err != nil || i < 0 || i >= len(c) {
					fail("BAD_REFERENCE", "cannot resolve '"+ref+"'", path)
				}
				cur = c[i]
			default:
				fail("BAD_REFERENCE", "cannot resolve '"+ref+"'", path)
			}
		}
		return cur
	}
	for s := len(scopes) - 1; s >= 0; s-- {
		if v, ok := scopes[s][ref]; ok {
			return v
		}
	}
	fail("BAD_REFERENCE", "cannot resolve '"+ref+"'", path)
	return nil
}

func magnitude(u uint64, neg bool) any {
	if u <= two53 {
		f := float64(u)
		if neg {
			f = -f
		}
		return f
	}
	s := strconv.FormatUint(u, 10)
	if neg {
		s = "-" + s
	}
	return s
}

func pickCase(f map[string]any, on any) []any {
	cases := asMap(f["cases"])
	keys := make([]string, 0, len(cases))
	for k := range cases {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		switch x := on.(type) {
		case float64:
			if parseKey(k) == x {
				return list(cases, k)
			}
		case string:
			if k == x {
				return list(cases, k)
			}
		}
	}
	if d, ok := f["default"].([]any); ok {
		return d
	}
	return nil
}

func whenMatches(when map[string]any, port *int, topic string) bool {
	if when == nil {
		return true
	}
	if wp, ok := when["port"]; ok && wp != nil && port != nil {
		match := false
		switch p := wp.(type) {
		case float64:
			match = int(p) == *port
		case []any:
			for _, x := range p {
				if xf, ok := x.(float64); ok && int(xf) == *port {
					match = true
				}
			}
		}
		if !match {
			return false
		}
	}
	if wt, ok := when["topic"].(string); ok && topic != "" && !topicMatches(wt, topic) {
		return false
	}
	return true
}

func topicMatches(pattern, topic string) bool {
	p, t := strings.Split(pattern, "/"), strings.Split(topic, "/")
	for i, seg := range p {
		if seg == "#" {
			return true
		}
		if i >= len(t) {
			return false
		}
		if seg != "+" && seg != t[i] {
			return false
		}
	}
	return len(p) == len(t)
}

// ---------------------------------------------------------------- decode

type reader struct {
	data     []byte
	pos, end int
	warnings []string
	path     string
}

// bits reads n <= 64 bits MSB-first; byte order is reversed only for aligned, whole-byte little-endian fields.
func (r *reader) bits(n int, little bool) uint64 {
	if r.pos+n > r.end {
		fail("PAYLOAD_TOO_SHORT", fmt.Sprintf("need %d bits at bit %d, payload has %d", n, r.pos, r.end), r.path)
	}
	var v uint64
	if r.pos%8 == 0 && n%8 == 0 {
		start := r.pos / 8
		for i := 0; i < n/8; i++ {
			b := uint64(r.data[start+i])
			if little {
				v |= b << (8 * uint(i))
			} else {
				v = v<<8 | b
			}
		}
	} else {
		for k := 0; k < n; k++ {
			p := r.pos + k
			v = v<<1 | uint64((r.data[p>>3]>>uint(7-(p&7)))&1)
		}
	}
	r.pos += n
	return v
}

func (r *reader) bytes(n int) []byte {
	if r.pos+n*8 > r.end {
		fail("PAYLOAD_TOO_SHORT", fmt.Sprintf("need %d bytes at bit %d, payload has %d bits", n, r.pos, r.end), r.path)
	}
	out := make([]byte, n)
	for i := range out {
		out[i] = byte(r.bits(8, false))
	}
	return out
}

func semantics(r *reader, f map[string]any, raw any, path string) any {
	if str(f, "type") == "bool" {
		switch x := raw.(type) {
		case float64:
			return x != 0
		case string:
			return x != "0"
		}
		return false
	}
	x, ok := raw.(float64)
	if !ok {
		return raw
	}
	if e := asMap(f["enum"]); e != nil {
		if label, ok := e[fmtNum(x)]; ok {
			return label
		}
		r.warnings = append(r.warnings, path+": unknown enum value "+fmtNum(x))
		return x
	}
	scale, offset := 1.0, 0.0
	if s, ok := num(f, "scale"); ok {
		scale = s
	}
	if o, ok := num(f, "offset"); ok {
		offset = o
	}
	v := float64(x*scale) + offset // explicit conversion prevents fused multiply-add
	if d, ok := num(f, "decimals"); ok {
		v = roundFixed(v, int(d))
	} else if !isInt(scale) || !isInt(offset) {
		v = roundFixed(v, 10)
	}
	lo, hasLo := num(f, "min")
	hi, hasHi := num(f, "max")
	if (hasLo && v < lo) || (hasHi && v > hi) {
		los, his := "-Infinity", "Infinity"
		if hasLo {
			los = fmtNum(lo)
		}
		if hasHi {
			his = fmtNum(hi)
		}
		r.warnings = append(r.warnings, path+": value "+fmtNum(v)+" outside ["+los+","+his+"]")
	}
	return v
}

func byteLength(r *reader, f map[string]any, reserve int) int {
	if str(f, "length") == "remaining" {
		n := (r.end - reserve - r.pos) / 8
		if n < 0 {
			return 0
		}
		return n
	}
	l, ok := num(f, "length")
	if !ok {
		fail("INVALID_SPEC", str(f, "name")+": length required", r.path)
	}
	return int(l)
}

func readScalar(r *reader, f map[string]any, reserve int) any {
	little := endianLittle(f)
	switch t := str(f, "type"); t {
	case "uint", "bool":
		return magnitude(r.bits(scalarBits(f), little), false)
	case "int":
		n := scalarBits(f)
		u := r.bits(n, little)
		if (u>>uint(n-1))&1 == 1 {
			mask := ^uint64(0)
			if n < 64 {
				mask = (uint64(1) << uint(n)) - 1
			}
			return magnitude((^u+1)&mask, true)
		}
		return magnitude(u, false)
	case "float":
		n := scalarBits(f)
		if n != 32 && n != 64 {
			fail("INVALID_SPEC", str(f, "name")+": float must be 32 or 64 bits", r.path)
		}
		u := r.bits(n, little)
		if n == 32 {
			return float64(math.Float32frombits(uint32(u)))
		}
		return math.Float64frombits(u)
	case "bytes", "string", "bcd":
		b := r.bytes(byteLength(r, f, reserve))
		switch t {
		case "bytes":
			return hex.EncodeToString(b)
		case "string":
			e := len(b)
			for e > 0 && b[e-1] == 0 {
				e--
			}
			return strings.ToValidUTF8(string(b[:e]), "�")
		default:
			var sb strings.Builder
			for _, x := range b {
				for _, nib := range []byte{x >> 4, x & 15} {
					if nib != 15 {
						sb.WriteString(strconv.FormatUint(uint64(nib), 16))
					}
				}
			}
			return sb.String()
		}
	default:
		fail("INVALID_SPEC", str(f, "name")+": unknown type "+t, r.path)
	}
	return nil
}

func decodeFields(r *reader, fields []any, out, raws map[string]any, scopes []map[string]any, prefix string, reserve int) {
	for i, fv := range fields {
		f := asMap(fv)
		name := str(f, "name")
		path := prefix + name
		trailing := reserve + trailingBits(fields, i)
		r.path = path
		switch kind := kindOf(f); kind {
		case "scalar":
			raw := readScalar(r, f, trailing)
			raws[name] = raw
			if h, _ := f["hidden"].(bool); !h {
				out[name] = semantics(r, f, raw, path)
			}
		case "const":
			bits := scalarBits(f)
			cv := r.bits(bits, endianLittle(f))
			value, _ := num(f, "value")
			want := uint64(int64(value))
			if bits < 64 {
				want &= (uint64(1) << uint(bits)) - 1
			}
			if cv != want {
				fail("CONST_MISMATCH", fmt.Sprintf("%s: expected %s, got %d", path, fmtNum(value), cv), path)
			}
			raws[name] = magnitude(cv, false)
		case "checksum":
			if r.pos%8 != 0 {
				fail("INVALID_SPEC", path+": checksum must be byte-aligned", path)
			}
			at := r.pos / 8
			width := checksumBytes[str(f, "algo")]
			if width == 0 {
				fail("INVALID_SPEC", "unknown checksum "+str(f, "algo"), path)
			}
			got := r.bits(width*8, endianLittle(f))
			calc := Checksum(str(f, "algo"), r.data[:at])
			if got != uint64(calc) {
				fail("CHECKSUM_MISMATCH", fmt.Sprintf("%s: %s expected %x, got %x", path, str(f, "algo"), calc, got), path)
			}
		case "group":
			gout, graw := map[string]any{}, map[string]any{}
			raws[name] = graw
			decodeFields(r, list(f, "fields"), gout, graw, withScope(scopes, graw), path+".", trailing)
			out[name] = gout
		case "repeat":
			arr, rarr := []any{}, []any{}
			count := -1
			switch c := f["count"].(type) {
			case float64:
				count = int(c)
			case map[string]any:
				v, ok := resolve(scopes, str(c, "ref"), path).(float64)
				if !ok || v < 0 || !isInt(v) {
					fail("BAD_REFERENCE", path+": count '"+str(c, "ref")+"' is not a non-negative integer", path)
				}
				count = int(v)
			}
			for k := 0; count < 0 || k < count; k++ {
				if count < 0 && r.end-trailing-r.pos < 8 {
					break
				}
				start := r.pos
				iout, iraw := map[string]any{}, map[string]any{}
				rarr = append(rarr, iraw)
				raws[name] = rarr
				decodeFields(r, list(f, "fields"), iout, iraw, withScope(scopes, iraw), fmt.Sprintf("%s[%d].", path, k), trailing)
				arr = append(arr, iout)
				if count < 0 && r.pos == start {
					break
				}
			}
			raws[name] = rarr
			out[name] = arr
		case "switch":
			on := resolve(scopes, str(f, "on"), path)
			if chosen := pickCase(f, on); chosen != nil {
				decodeFields(r, chosen, out, raws, scopes, prefix, trailing)
			} else {
				r.warnings = append(r.warnings, path+": no case for "+fmtAny(on))
			}
		default:
			fail("INVALID_SPEC", path+": unknown field kind "+kind, path)
		}
	}
}

func decodeList(payload []byte, port *int, topic string, direction string) Result {
	var errs []CodecError
	tried := 0
	for _, mv := range list(spec, direction) {
		m := asMap(mv)
		if !whenMatches(asMap(m["when"]), port, topic) {
			continue
		}
		tried++
		r := &reader{data: payload, end: len(payload) * 8, warnings: []string{}}
		data, err := decodeMessage(r, m)
		if err == nil {
			return Result{OK: true, Message: str(m, "name"), Data: data, Warnings: r.warnings}
		}
		e := *err
		e.Message = str(m, "name") + ": " + e.Message
		errs = append(errs, e)
	}
	all := append([]CodecError{{Code: "NO_MATCHING_MESSAGE", Message: fmt.Sprintf("no message matched (%d candidate(s) tried)", tried)}}, errs...)
	return Result{OK: false, Errors: all, Warnings: []string{}}
}

func decodeMessage(r *reader, m map[string]any) (data map[string]any, err *CodecError) {
	defer func() {
		if p := recover(); p != nil {
			ce, ok := p.(*CodecError)
			if !ok {
				panic(p)
			}
			data, err = nil, ce
		}
	}()
	out, raws := map[string]any{}, map[string]any{}
	decodeFields(r, list(m, "fields"), out, raws, []map[string]any{raws}, "", 0)
	if used := (r.pos + 7) / 8; used < len(r.data) {
		fail("TRAILING_BYTES", fmt.Sprintf("%d unread byte(s)", len(r.data)-used), "")
	}
	return out, nil
}

// Decode decodes an uplink payload. port (LoRaWAN fPort) may be nil; topic (MQTT) may be "".
func Decode(payload []byte, port *int, topic string) Result {
	return decodeList(payload, port, topic, "uplink")
}

// DecodeDownlink decodes a downlink payload (e.g. to display queued commands).
func DecodeDownlink(payload []byte, port *int) Result {
	return decodeList(payload, port, "", "downlink")
}

// ---------------------------------------------------------------- encode

type writer struct {
	buf      []byte
	pos      int
	warnings []string
	errors   []CodecError
}

func (w *writer) addError(code, message, path string) {
	w.errors = append(w.errors, CodecError{Code: code, Message: message, Path: path})
}

// writeScalarSafe records ENCODE_* failures and writes a zero placeholder so encoding can report every error.
func writeScalarSafe(w *writer, f map[string]any, v any, path string, missing bool) (raw any) {
	defer func() {
		if p := recover(); p != nil {
			ce, ok := p.(*CodecError)
			if !ok || !strings.HasPrefix(ce.Code, "ENCODE_") {
				panic(p)
			}
			w.errors = append(w.errors, *ce)
			raw = writeScalar(w, f, nil, path, true)
		}
	}()
	return writeScalar(w, f, v, path, missing)
}

// bits writes the low n <= 64 bits of v MSB-first.
func (w *writer) bits(v uint64, n int, little bool) {
	if w.pos%8 == 0 && n%8 == 0 && little {
		var rv uint64
		for i := 0; i < n/8; i++ {
			rv = rv<<8 | (v>>(8*uint(i)))&0xFF
		}
		v = rv
	}
	for k := 0; k < n; k++ {
		p := w.pos + k
		for len(w.buf) <= p>>3 {
			w.buf = append(w.buf, 0)
		}
		if (v>>uint(n-1-k))&1 == 1 {
			w.buf[p>>3] |= 1 << uint(7-(p&7))
		}
	}
	w.pos += n
}

func isDec(s string) bool {
	s = strings.TrimPrefix(strings.TrimSpace(s), "-")
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// intBits converts an integer raw (float64 or decimal string) to n-bit two's complement.
func intBits(raw any, n int, signed bool) (uint64, bool) {
	v := new(big.Int)
	switch x := raw.(type) {
	case string:
		if _, ok := v.SetString(strings.TrimSpace(x), 10); !ok {
			return 0, false
		}
	case float64:
		if math.IsNaN(x) || math.Abs(x) >= 1e21 {
			return 0, false
		}
		new(big.Float).SetFloat64(math.Round(x)).Int(v)
	default:
		return 0, false
	}
	one := big.NewInt(1)
	if signed {
		lo := new(big.Int).Neg(new(big.Int).Lsh(one, uint(n-1)))
		hi := new(big.Int).Sub(new(big.Int).Lsh(one, uint(n-1)), one)
		if v.Cmp(lo) < 0 || v.Cmp(hi) > 0 {
			return 0, false
		}
		if v.Sign() < 0 {
			v.Add(v, new(big.Int).Lsh(one, uint(n)))
		}
		return v.Uint64(), true
	}
	hi := new(big.Int).Sub(new(big.Int).Lsh(one, uint(n)), one)
	if v.Sign() < 0 || v.Cmp(hi) > 0 {
		return 0, false
	}
	return v.Uint64(), true
}

// toRaw is the inverse semantics pipeline: enum label -> key; else round((v - offset) / scale).
func toRaw(f map[string]any, v any, path string) any {
	if b, ok := v.(bool); ok {
		if b {
			return 1.0
		}
		return 0.0
	}
	if str(f, "type") == "bool" {
		if x, ok := v.(float64); ok && x == 0 {
			return 0.0
		}
		if s, ok := v.(string); ok && (s == "" || s == "0") {
			return 0.0
		}
		return 1.0
	}
	enum := asMap(f["enum"])
	if s, ok := v.(string); ok {
		if enum != nil {
			keys := make([]string, 0, len(enum))
			for k := range enum {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if label, _ := enum[k].(string); label == s {
					return parseKey(k)
				}
			}
			if !isDec(s) {
				fail("ENCODE_OUT_OF_RANGE", path+": unknown enum label '"+s+"'", path)
			}
		}
		if isDec(s) {
			return strings.TrimSpace(s)
		}
		fail("ENCODE_OUT_OF_RANGE", path+": not a number: '"+s+"'", path)
	}
	x, ok := v.(float64)
	if !ok || math.IsNaN(x) {
		fail("ENCODE_OUT_OF_RANGE", path+": not a number", path)
	}
	if enum != nil {
		return x
	}
	scale, offset := 1.0, 0.0
	if s, ok := num(f, "scale"); ok {
		scale = s
	}
	if o, ok := num(f, "offset"); ok {
		offset = o
	}
	if str(f, "type") == "float" {
		return (x - offset) / scale
	}
	return math.Floor((x-offset)/scale + 0.5)
}

func hexToBytes(v any, path string) []byte {
	switch x := v.(type) {
	case []byte:
		return append([]byte(nil), x...)
	case string:
		c := strings.NewReplacer(" ", "", "\t", "", "\n", "", ":", "", "-", "").Replace(x)
		b, err := hex.DecodeString(c)
		if err != nil {
			fail("ENCODE_OUT_OF_RANGE", path+": invalid hex", path)
		}
		return b
	}
	fail("ENCODE_OUT_OF_RANGE", path+": expected hex string", path)
	return nil
}

func writeScalar(w *writer, f map[string]any, v any, path string, missing bool) any {
	little := endianLittle(f)
	t := str(f, "type")
	switch t {
	case "uint", "int", "bool":
		n := scalarBits(f)
		var raw any = 0.0
		if !missing {
			raw = toRaw(f, v, path)
		}
		u, ok := intBits(raw, n, t == "int")
		if !ok {
			fail("ENCODE_OUT_OF_RANGE", fmt.Sprintf("%s: %s does not fit %s%d", path, fmtAny(raw), t, n), path)
		}
		w.bits(u, n, little)
		return raw
	case "float":
		n := scalarBits(f)
		x := 0.0
		if !missing {
			x, _ = toRaw(f, v, path).(float64)
		}
		if n == 32 {
			w.bits(uint64(math.Float32bits(float32(x))), 32, little)
		} else {
			w.bits(math.Float64bits(x), 64, little)
		}
		return x
	}
	var data []byte
	if !missing {
		switch t {
		case "bytes":
			data = hexToBytes(v, path)
		case "string":
			data = []byte(fmtAny(v))
		case "bcd":
			ds := strings.ToLower(fmtAny(v))
			for _, c := range ds {
				if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'e')) {
					fail("ENCODE_OUT_OF_RANGE", path+": invalid BCD digits", path)
				}
			}
			for k := 0; k < len(ds); k += 2 {
				hi, _ := strconv.ParseUint(ds[k:k+1], 16, 8)
				lo := uint64(15)
				if k+1 < len(ds) {
					lo, _ = strconv.ParseUint(ds[k+1:k+2], 16, 8)
				}
				data = append(data, byte(hi<<4|lo))
			}
		default:
			fail("INVALID_SPEC", path+": unknown type "+t, path)
		}
	}
	if str(f, "length") != "remaining" {
		l, ok := num(f, "length")
		if !ok {
			fail("INVALID_SPEC", path+": length required", path)
		}
		if len(data) > int(l) {
			fail("ENCODE_OUT_OF_RANGE", fmt.Sprintf("%s: %d bytes exceed length %d", path, len(data), int(l)), path)
		}
		for len(data) < int(l) {
			if t == "bcd" {
				data = append(data, 0xFF)
			} else {
				data = append(data, 0)
			}
		}
	}
	for _, b := range data {
		w.bits(uint64(b), 8, false)
	}
	if t == "bytes" {
		return hex.EncodeToString(data)
	}
	return v
}

func declares(fields []any, name string) bool {
	for _, fv := range fields {
		f := asMap(fv)
		switch kindOf(f) {
		case "scalar", "const":
			if str(f, "name") == name {
				return true
			}
		case "switch":
			for _, c := range asMap(f["cases"]) {
				if cl, ok := c.([]any); ok && declares(cl, name) {
					return true
				}
			}
			if d, ok := f["default"].([]any); ok && declares(d, name) {
				return true
			}
		}
	}
	return false
}

type frame struct {
	obj    map[string]any
	fields []any
}

// autoCounts implements semantics 7: a {ref} count field omitted by the caller is set to the array length.
func autoCounts(fields []any, obj map[string]any, stack []frame) {
	for _, fv := range fields {
		f := asMap(fv)
		c := asMap(f["count"])
		if kindOf(f) != "repeat" || c == nil {
			continue
		}
		arr, ok := obj[str(f, "name")].([]any)
		if !ok {
			continue
		}
		ref := str(c, "ref")
		if strings.Contains(ref, ".") {
			parts := strings.Split(ref, ".")
			cur := stack[0].obj
			for _, p := range parts[:len(parts)-1] {
				next := asMap(cur[p])
				if next == nil {
					if cur[p] != nil {
						cur = nil
						break
					}
					next = map[string]any{}
					cur[p] = next
				}
				cur = next
			}
			if cur != nil && cur[parts[len(parts)-1]] == nil {
				cur[parts[len(parts)-1]] = float64(len(arr))
			}
		} else {
			for s := len(stack) - 1; s >= 0; s-- {
				if declares(stack[s].fields, ref) {
					if stack[s].obj[ref] == nil {
						stack[s].obj[ref] = float64(len(arr))
					}
					break
				}
			}
		}
	}
}

func withFrame(stack []frame, fr frame) []frame {
	out := make([]frame, len(stack)+1)
	copy(out, stack)
	out[len(stack)] = fr
	return out
}

func encodeFields(w *writer, fields []any, obj, raws map[string]any, scopes []map[string]any, stack []frame, prefix string) {
	autoCounts(fields, obj, stack)
	for _, fv := range fields {
		f := asMap(fv)
		name := str(f, "name")
		path := prefix + name
		switch kind := kindOf(f); kind {
		case "scalar":
			v := obj[name]
			missing := false
			if v == nil {
				if d, ok := f["default"]; ok && d != nil {
					v = d
				} else if h, _ := f["hidden"].(bool); h {
					missing = true
				} else {
					w.addError("ENCODE_MISSING_FIELD", "missing field "+path, path)
					missing = true
				}
			}
			raws[name] = writeScalarSafe(w, f, v, path, missing)
		case "const":
			bits := scalarBits(f)
			value, _ := num(f, "value")
			u := uint64(int64(value))
			if bits < 64 {
				u &= (uint64(1) << uint(bits)) - 1
			}
			w.bits(u, bits, endianLittle(f))
			raws[name] = value
		case "checksum":
			if w.pos%8 != 0 {
				fail("INVALID_SPEC", path+": checksum must be byte-aligned", path)
			}
			width := checksumBytes[str(f, "algo")]
			if width == 0 {
				fail("INVALID_SPEC", "unknown checksum "+str(f, "algo"), path)
			}
			w.bits(uint64(Checksum(str(f, "algo"), w.buf[:w.pos/8])), width*8, endianLittle(f))
		case "group":
			g := asMap(obj[name])
			if g == nil {
				g = map[string]any{}
				obj[name] = g
			}
			graw := map[string]any{}
			raws[name] = graw
			encodeFields(w, list(f, "fields"), g, graw, withScope(scopes, graw), withFrame(stack, frame{g, list(f, "fields")}), path+".")
		case "repeat":
			arr, ok := obj[name].([]any)
			if !ok {
				w.addError("ENCODE_MISSING_FIELD", "missing array "+path, path)
				continue
			}
			want := -1.0
			switch c := f["count"].(type) {
			case float64:
				want = c
			case map[string]any:
				if x, ok := resolve(scopes, str(c, "ref"), path).(float64); ok {
					want = x
				}
			}
			if want >= 0 && int(want) != len(arr) {
				w.addError("ENCODE_OUT_OF_RANGE", fmt.Sprintf("%s: expected %s items, got %d", path, fmtNum(want), len(arr)), path)
				continue
			}
			rarr := []any{}
			for j, item := range arr {
				im := asMap(item)
				if im == nil {
					im = map[string]any{}
				}
				iraw := map[string]any{}
				rarr = append(rarr, iraw)
				raws[name] = rarr
				encodeFields(w, list(f, "fields"), im, iraw, withScope(scopes, iraw), withFrame(stack, frame{im, list(f, "fields")}), fmt.Sprintf("%s[%d].", path, j))
			}
			raws[name] = rarr
		case "switch":
			on := resolve(scopes, str(f, "on"), path)
			if chosen := pickCase(f, on); chosen != nil {
				encodeFields(w, chosen, obj, raws, scopes, stack, prefix)
			} else {
				w.warnings = append(w.warnings, path+": no case for "+fmtAny(on))
			}
		default:
			fail("INVALID_SPEC", path+": unknown field kind "+kind, path)
		}
	}
}

// normalize deep-copies caller data, converting Go numeric types to float64
// (or decimal strings beyond 2^53) and typed slices/maps to []any / map[string]any.
func normalize(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = normalize(e)
		}
		return out
	case []map[string]any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = normalize(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = normalize(e)
		}
		return out
	case int:
		return normInt(int64(x))
	case int8:
		return float64(x)
	case int16:
		return float64(x)
	case int32:
		return float64(x)
	case int64:
		return normInt(x)
	case uint:
		return normUint(uint64(x))
	case uint8:
		return float64(x)
	case uint16:
		return float64(x)
	case uint32:
		return float64(x)
	case uint64:
		return normUint(x)
	case float32:
		return float64(x)
	case json.Number:
		if i, err := x.Int64(); err == nil {
			return normInt(i)
		}
		f, _ := x.Float64()
		return f
	}
	return v
}

func normInt(i int64) any {
	if i > int64(two53) || i < -int64(two53) {
		return strconv.FormatInt(i, 10)
	}
	return float64(i)
}

func normUint(u uint64) any {
	if u > two53 {
		return strconv.FormatUint(u, 10)
	}
	return float64(u)
}

// Encode encodes a message by name (downlinks first, then uplinks — useful for simulators).
func Encode(message string, data map[string]any) EncodeResult {
	var m map[string]any
	for _, dir := range []string{"downlink", "uplink"} {
		for _, mv := range list(spec, dir) {
			if str(asMap(mv), "name") == message && m == nil {
				m = asMap(mv)
			}
		}
	}
	if m == nil {
		return EncodeResult{Errors: []CodecError{{Code: "NO_MATCHING_MESSAGE", Message: "unknown message '" + message + "'"}}, Warnings: []string{}}
	}
	w := &writer{warnings: []string{}}
	if err := encodeMessage(w, m, data); err != nil {
		w.errors = append(w.errors, *err)
	}
	if len(w.errors) > 0 {
		return EncodeResult{Errors: w.errors, Warnings: w.warnings}
	}
	res := EncodeResult{OK: true, Bytes: w.buf, Warnings: w.warnings}
	if res.Bytes == nil {
		res.Bytes = []byte{}
	}
	switch p := asMap(m["when"])["port"].(type) {
	case float64:
		res.Port = Port(int(p))
	case []any:
		if len(p) > 0 {
			if f, ok := p[0].(float64); ok {
				res.Port = Port(int(f))
			}
		}
	}
	return res
}

func encodeMessage(w *writer, m map[string]any, data map[string]any) (err *CodecError) {
	defer func() {
		if p := recover(); p != nil {
			ce, ok := p.(*CodecError)
			if !ok {
				panic(p)
			}
			err = ce
		}
	}()
	obj, _ := normalize(data).(map[string]any)
	if obj == nil {
		obj = map[string]any{}
	}
	raws := map[string]any{}
	encodeFields(w, list(m, "fields"), obj, raws, []map[string]any{raws}, []frame{{obj, list(m, "fields")}}, "")
	return nil
}
`;

export function goPackage(spec: DeviceCodecSpec): string {
  const p = spec.id.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /^[a-z]/.test(p) ? p : `codec${p}`;
}

function goString(s: string): string {
  // Raw string literal when possible (readable JSON), quoted otherwise.
  return s.includes("`") ? JSON.stringify(s) : "`" + s + "`";
}

function goMain(spec: DeviceCodecSpec): string {
  const pkg = goPackage(spec);
  return `${lineHeader(spec, "Go codec (standard library only)", "//")}
// Package ${pkg} decodes and encodes ${spec.device.vendor} ${spec.device.model} payloads.
//
//	r := ${pkg}.Decode(payload, ${pkg}.Port(1), "")
//	if r.OK { fmt.Println(r.Message, r.Data) }
//	e := ${pkg}.Encode("<message>", map[string]any{ ... })
package ${pkg}

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
)

// CodecID and CodecVersion identify the Device Codec Spec this package was generated from.
const (
	CodecID      = ${JSON.stringify(spec.id)}
	CodecVersion = ${JSON.stringify(spec.version)}
)

// specJSON is the Device Codec Spec this package interprets (layout + semantics).
const specJSON = ${goString(JSON.stringify(runtimeSpec(spec), null, 1))}
${GO_ENGINE}`;
}

function goTest(spec: DeviceCodecSpec): string {
  const pkg = goPackage(spec);
  const vs = vectors(spec).map((v) => ({ ...v, hex: cleanHex(v.hex) }));
  return `${lineHeader(spec, "Go codec test vectors", "//")}
package ${pkg}

import (
	"encoding/hex"
	"encoding/json"
	"math"
	"testing"
)

type vector struct {
	Name      string         \`json:"name"\`
	Direction string         \`json:"direction"\`
	Port      *int           \`json:"port"\`
	Topic     string         \`json:"topic"\`
	Hex       string         \`json:"hex"\`
	Message   string         \`json:"message"\`
	Data      map[string]any \`json:"data"\`
}

const vectorsJSON = ${goString(JSON.stringify(vs, null, 1))}

func same(a, b any) bool {
	switch x := a.(type) {
	case float64:
		y, ok := b.(float64)
		return ok && math.Abs(x-y) <= 1e-9*math.Max(1, math.Abs(x))
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !same(x[i], y[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for k, v := range x {
			if !same(v, y[k]) {
				return false
			}
		}
		return true
	}
	return a == b
}

func TestVectors(t *testing.T) {
	var vs []vector
	if err := json.Unmarshal([]byte(vectorsJSON), &vs); err != nil {
		t.Fatal(err)
	}
	for _, v := range vs {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			if v.Direction == "downlink" {
				r := Encode(v.Message, v.Data)
				if !r.OK || hex.EncodeToString(r.Bytes) != v.Hex {
					t.Fatalf("encode: %+v, want %s", r, v.Hex)
				}
				return
			}
			payload, _ := hex.DecodeString(v.Hex)
			r := Decode(payload, v.Port, v.Topic)
			if !r.OK {
				t.Fatalf("decode failed: %+v", r.Errors)
			}
			if v.Message != "" && r.Message != v.Message {
				t.Fatalf("message %s, want %s", r.Message, v.Message)
			}
			if !same(v.Data, map[string]any(r.Data)) {
				got, _ := json.Marshal(r.Data)
				t.Fatalf("data %s", got)
			}
			back := Encode(r.Message, r.Data)
			if !back.OK || hex.EncodeToString(back.Bytes) != v.Hex {
				t.Fatalf("round-trip: %+v, want %s", back, v.Hex)
			}
		})
	}
}
`;
}

export function generateGo(spec: DeviceCodecSpec): GeneratedFile[] {
  const pkg = goPackage(spec);
  return [
    { path: "go/go.mod", content: `module hash8.dev/codecs/${pkg}\n\ngo 1.18\n` },
    { path: "go/codec.go", content: goMain(spec) },
    { path: "go/codec_test.go", content: goTest(spec) },
  ];
}
