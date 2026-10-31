# DCS v1 — Normative Semantics

This document is the single source of truth for how a Device Codec Spec (DCS) is
interpreted. The TypeScript runtime (`packages/codec-runtime`) and **every**
generated plugin (`packages/codec-compiler`) MUST produce identical output for
identical input. Test vectors are the conformance oracle.

Types: `packages/dcs-schema/src/spec.ts`. Result contracts: `packages/dcs-schema/src/codec.ts`.

## 1. Message selection (uplink decode)
1. Candidate messages = `uplink` in declaration order.
2. A message is a candidate only if its `when.port` (number or list) contains `ctx.port`
   (when both are set) and `when.topic` equals `ctx.topic` (when both are set; `+`/`#`
   MQTT wildcards allowed). A `when` key absent on either side does not constrain.
3. Try each candidate in order: decode the full layout. The **first** candidate that
   decodes with no errors wins. `const` mismatches, length mismatches and checksum
   failures make a candidate fail and fall through to the next.
4. No winner → `NO_MATCHING_MESSAGE` with the errors of every attempted candidate
   (each prefixed by message name) appended.

## 2. Cursor & bit order
- A **bit cursor** starts at 0. Each scalar/const consumes `bits` (or `length*8`).
- Bits are read **MSB-first** within the payload (network bit order): bit 0 of the
  cursor is the most significant bit of byte 0. A 4-bit uint at cursor 0 of `0xA5` is `0xA`.
- `endian` (field ?? `spec.defaults.endian`, default `big`) only applies when the
  field is byte-aligned AND `bits` is a multiple of 8. For `little`, bytes are reversed
  before interpretation. Non-aligned or non-multiple-of-8 fields are always read big-endian bitwise.
- After the layout is consumed, the cursor must be at the end of the payload (rounded
  up to the byte, trailing pad bits < 8 allowed). Otherwise error `TRAILING_BYTES`.
- Reading past the end → `PAYLOAD_TOO_SHORT`.

## 3. Scalar types
| type | width | raw value |
|---|---|---|
| `uint` | `bits` (default 8) | unsigned integer. Values > 2^53 decode as `string` decimal. |
| `int` | `bits` (default 8) | two's complement of width `bits`. |
| `bool` | `bits` (default 1) | `raw != 0`. |
| `float` | `bits` 32 or 64 (default 32) | IEEE-754. Must be byte-aligned. |
| `bytes` | `length` bytes | lowercase hex string. |
| `string` | `length` bytes | UTF-8 (ASCII expected), trailing `\0` stripped. |
| `bcd` | `length` bytes | each nibble a digit; string of digits (e.g. IMEI). Nibble `0xF` = filler, dropped. |

`length: "remaining"` consumes to payload end, minus the size of a trailing `checksum`
field at the same level if present. Byte-sized types must be byte-aligned.

## 4. Semantics pipeline (numeric fields only, in this order)
1. If `enum` is set and `String(raw)` is a key → value is the label string; **stop**
   (scale/offset are not applied). Unknown raw → keep numeric raw, add warning
   `"<path>: unknown enum value <raw>"`.
2. value = raw × (`scale` ?? 1) + (`offset` ?? 0).
3. If `decimals` set → `Number(value.toFixed(decimals))`. Else if `scale` or `offset`
   is non-integer → round to 10 significant decimals to kill float noise:
   `Number(value.toFixed(10))` then strip.
4. If `min`/`max` set and value outside → warning `"<path>: value <v> outside [min,max]"`
   (decode still succeeds).
`bool` ignores scale/offset/enum.

## 5. Output shape
- Output is a plain JSON object. Each emitted field sets `out[name] = value` at the
  current object level.
- `hidden: true` fields are read but not emitted. `const` and `checksum` are never emitted.
- `group` → `out[name] = { ...fields }` (nested object).
- `repeat` → `out[name] = [ { ...fields }, ... ]`. `count`:
  - number → exactly that many.
  - `{ref}` → value of an earlier decoded field. Path resolution: first look in the
    current object scope, then walk outward; dot paths (`header.count`) resolve from
    the message root. Must be a non-negative integer raw value.
  - `"remaining"` → repeat while unread bytes remain (excluding a trailing checksum).
- `switch` → evaluates `on` against the **raw** numeric value of the referenced field
  (enum labels are not used for matching), using the same path resolution. Matching
  case key compares numerically (`"16"` and `"0x10"` are equal). Fields of the chosen
  case are **merged into the current object** (no nesting under `name`). No match and
  no `default` → no fields, warning `"<name>: no case for <v>"`. An unresolvable
  `on`/`ref` path → error `BAD_REFERENCE`.
- To make raw values referenceable, the runtime keeps a parallel raw-value scope.

## 6. Checksums
Computed over bytes `[messageStart, checksumStart)`. Width: crc8/xor8/sum8 = 1 byte,
crc16-* = 2 bytes, crc32 = 4 bytes, read with field/default endianness.
- `crc8`: poly 0x07, init 0x00, no reflect, xorout 0x00.
- `crc16-ccitt`: CCITT-FALSE — poly 0x1021, init 0xFFFF, no reflect, xorout 0x0000.
- `crc16-modbus`: poly 0x8005 reflected (0xA001), init 0xFFFF.
- `crc32`: IEEE (zlib) — reflected 0xEDB88320, init 0xFFFFFFFF, xorout 0xFFFFFFFF.
- `xor8`: XOR of all bytes. `sum8`: sum mod 256.
Mismatch → `CHECKSUM_MISMATCH`.

## 7. Encode (downlink, and uplink for simulators)
`encode(messageName, data)` searches `downlink` then `uplink` for the name.
- Inverse pipeline per field: enum label → raw key; else raw = round((value − offset) / scale).
- Missing field → `default` if set, else `0` for hidden/reserved fields, else
  `ENCODE_MISSING_FIELD`. `const` writes its value. `checksum` is computed.
- Raw outside the representable range of `bits` → `ENCODE_OUT_OF_RANGE`.
- `repeat` with `{ref}` count: the referenced count field is auto-set to the array
  length if the caller omitted it. `switch`: the case is chosen by the raw value of the
  `on` field; the case's fields read from the same object.
- Result `port` = first port of the message's `when.port`.
- Round-trip law: for every uplink vector, `encode(msg, decode(hex).data)` == hex.
  The conformance suite enforces this.

## 8. Test vectors
- `uplink` vector passes iff `decode(hex, {port, topic})` is ok, `message` matches when
  given, and `data` deep-equals expected (numbers compared with tolerance 1e-9).
- `downlink` vector passes iff `encode(message, data)` bytes equal `hex`.

## 9. Generated plugin API (all languages, idiomatic casing)
- `decode(bytes, port?, topic?) -> DecodeResult`
- `encode(message, data) -> EncodeResult`
- TS013 JS wrapper: `decodeUplink({bytes, fPort}) -> {data, warnings, errors}`,
  `encodeDownlink({data:{message, ...}}) -> {bytes, fPort, warnings, errors}`.
- Generated code must be dependency-free.
