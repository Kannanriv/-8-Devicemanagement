import { z } from "zod";

/**
 * Device Codec Spec (DCS) v1 — the canonical, machine-readable replacement for
 * OEM "message spec" Excel sheets. One DCS fully describes how a device model's
 * uplink/downlink payloads are laid out (layer A), what they mean (layer B) and
 * how to prove a codec is correct (layer C, test vectors).
 *
 * Layout model: fields are read sequentially by a cursor over the payload.
 * Normative semantics live in docs/dcs-semantics.md.
 */

export const Endian = z.enum(["big", "little"]);
export type Endian = z.infer<typeof Endian>;

/** Where a field came from in the OEM's original document — every AI-extracted field must carry one. */
export const SourceRef = z.object({
  file: z.string().optional(),
  sheet: z.string().optional(),
  cell: z.string().optional(),
  row: z.number().int().optional(),
  page: z.number().int().optional(),
  text: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

const FieldMeta = {
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "field names must be identifiers"),
  description: z.string().optional(),
  source: SourceRef.optional(),
};

/** Semantic (layer B) annotations shared by value-producing fields. */
const Semantics = {
  /** Physical value = raw * scale + offset. */
  scale: z.number().optional(),
  offset: z.number().optional(),
  /** Round the physical value to N decimals (avoids float noise like 21.299999). */
  decimals: z.number().int().min(0).max(12).optional(),
  /** UCUM unit code, e.g. "Cel", "%", "V", "kW.h", "deg". */
  unit: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** Map raw integer value -> label. Decoded output is the label; unknown values stay numeric with a warning. */
  enum: z.record(z.string(), z.string()).optional(),
  /** Optional standard mapping, e.g. "lwm2m:3303/5700". */
  semantic: z.string().optional(),
};

export const ScalarType = z.enum(["uint", "int", "float", "bool", "bytes", "string", "bcd"]);
export type ScalarType = z.infer<typeof ScalarType>;

export const ScalarField = z.object({
  kind: z.literal("scalar").default("scalar"),
  ...FieldMeta,
  ...Semantics,
  type: ScalarType,
  /** Width in bits for uint/int/bool (1..64, need not be a byte multiple); float must be 32 or 64. */
  bits: z.number().int().min(1).max(64).optional(),
  /** Width in bytes for bytes/string/bcd; or "remaining" to consume the rest of the payload (minus trailing checksum). */
  length: z.union([z.number().int().min(0), z.literal("remaining")]).optional(),
  endian: Endian.optional(),
  /** Read and validate but do not emit (reserved / padding). */
  hidden: z.boolean().optional(),
  /** Encoding default when a downlink omits this field. */
  default: z.union([z.number(), z.string(), z.boolean()]).optional(),
});
export type ScalarField = z.infer<typeof ScalarField>;

/** A fixed marker (magic byte, protocol version). Mismatch => message does not match. */
export const ConstField = z.object({
  kind: z.literal("const"),
  ...FieldMeta,
  type: z.enum(["uint"]).default("uint"),
  bits: z.number().int().min(1).max(64),
  endian: Endian.optional(),
  value: z.number().int(),
});
export type ConstField = z.infer<typeof ConstField>;

/** Trailing integrity check over the bytes from message start up to (not including) the checksum. */
export const ChecksumField = z.object({
  kind: z.literal("checksum"),
  ...FieldMeta,
  algo: z.enum(["crc8", "crc16-ccitt", "crc16-modbus", "crc32", "xor8", "sum8"]),
  endian: Endian.optional(),
});
export type ChecksumField = z.infer<typeof ChecksumField>;

export type Field =
  | ScalarField
  | ConstField
  | ChecksumField
  | GroupField
  | RepeatField
  | SwitchField;

export interface GroupField {
  kind: "group";
  name: string;
  description?: string;
  source?: SourceRef;
  fields: Field[];
}

export interface RepeatField {
  kind: "repeat";
  name: string;
  description?: string;
  source?: SourceRef;
  /** Fixed count, a reference to an earlier decoded numeric field (dot path), or "remaining" (until payload end). */
  count: number | { ref: string } | "remaining";
  fields: Field[];
}

export interface SwitchField {
  kind: "switch";
  name: string;
  description?: string;
  source?: SourceRef;
  /** Dot path to an earlier decoded field (raw numeric value, before enum mapping). */
  on: string;
  /** Keys are decimal or 0x-hex raw values. */
  cases: Record<string, Field[]>;
  default?: Field[];
}

export const GroupField: z.ZodType<GroupField, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({ kind: z.literal("group"), ...FieldMeta, fields: z.array(FieldSchema) }),
);
export const RepeatField: z.ZodType<RepeatField, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    kind: z.literal("repeat"),
    ...FieldMeta,
    count: z.union([z.number().int().min(0), z.object({ ref: z.string() }), z.literal("remaining")]),
    fields: z.array(FieldSchema),
  }),
);
export const SwitchField: z.ZodType<SwitchField, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    kind: z.literal("switch"),
    ...FieldMeta,
    on: z.string(),
    cases: z.record(z.string(), z.array(FieldSchema)),
    default: z.array(FieldSchema).optional(),
  }),
);

export const FieldSchema: z.ZodType<Field, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    ScalarField.extend({ kind: z.literal("scalar") }),
    ConstField,
    ChecksumField,
    GroupField,
    RepeatField,
    SwitchField,
    // kind omitted => scalar
    ScalarField.omit({ kind: true }).transform((f) => ({ ...f, kind: "scalar" as const })),
  ]),
) as z.ZodType<Field, z.ZodTypeDef, unknown>;

/** A message is selected when ALL of its `when` conditions match (LoRaWAN fPort, MQTT topic, or leading const fields). */
export const MessageDef = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  description: z.string().optional(),
  when: z
    .object({
      port: z.union([z.number().int(), z.array(z.number().int())]).optional(),
      topic: z.string().optional(),
    })
    .optional(),
  fields: z.array(FieldSchema),
  source: SourceRef.optional(),
});
export type MessageDef = z.infer<typeof MessageDef>;

export const TestVector = z.object({
  name: z.string(),
  direction: z.enum(["uplink", "downlink"]).default("uplink"),
  port: z.number().int().optional(),
  topic: z.string().optional(),
  /** Hex payload, case-insensitive, whitespace ignored. */
  hex: z.string(),
  message: z.string().optional(),
  /** Expected decoded data (uplink) or the input object to encode (downlink). */
  data: z.record(z.string(), z.unknown()),
});
export type TestVector = z.infer<typeof TestVector>;

export const DeviceInfo = z.object({
  vendor: z.string(),
  model: z.string(),
  description: z.string().optional(),
  /** semver range of firmware this codec applies to, e.g. ">=2.0.0 <3.0.0". */
  firmware: z.string().optional(),
  protocols: z.array(z.enum(["lorawan", "mqtt", "coap", "lwm2m", "http", "udp", "tcp", "nbiot", "sigfox"])).optional(),
  category: z.string().optional(),
});

export const DeviceCodecSpec = z.object({
  dcs: z.literal("1.0"),
  /** Stable id: "<vendor>.<model>" lowercase, dot/dash separated. */
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  /** Codec semver. Breaking layout changes require a major bump. */
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
  device: DeviceInfo,
  defaults: z.object({ endian: Endian.default("big") }).default({ endian: "big" }),
  uplink: z.array(MessageDef).min(1),
  downlink: z.array(MessageDef).optional(),
  vectors: z.array(TestVector).default([]),
  meta: z
    .object({
      createdBy: z.string().optional(),
      sourceDocument: z.string().optional(),
      license: z.string().optional(),
      changelog: z.array(z.string()).optional(),
    })
    .optional(),
});
export type DeviceCodecSpec = z.infer<typeof DeviceCodecSpec>;
export type DeviceCodecSpecInput = z.input<typeof DeviceCodecSpec>;
