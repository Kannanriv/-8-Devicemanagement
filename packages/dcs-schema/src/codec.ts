import type { DeviceCodecSpec } from "./spec";

/** Context a transport adapter knows about a payload. */
export interface PayloadContext {
  /** LoRaWAN fPort or equivalent channel. */
  port?: number;
  /** MQTT topic. */
  topic?: string;
}

export type DecodedData = Record<string, unknown>;

export interface DecodeSuccess {
  ok: true;
  /** Name of the matched MessageDef. */
  message: string;
  data: DecodedData;
  warnings: string[];
}

export interface CodecError {
  code:
    | "NO_MATCHING_MESSAGE"
    | "PAYLOAD_TOO_SHORT"
    | "TRAILING_BYTES"
    | "CONST_MISMATCH"
    | "CHECKSUM_MISMATCH"
    | "BAD_REFERENCE"
    | "ENCODE_MISSING_FIELD"
    | "ENCODE_OUT_OF_RANGE"
    | "INVALID_SPEC";
  message: string;
  /** Dot path of the field involved, if any. */
  path?: string;
}

export interface DecodeFailure {
  ok: false;
  errors: CodecError[];
  warnings: string[];
}

export type DecodeResult = DecodeSuccess | DecodeFailure;

export type EncodeResult =
  | { ok: true; bytes: Uint8Array; port?: number; warnings: string[] }
  | { ok: false; errors: CodecError[]; warnings: string[] };

export interface VectorResult {
  name: string;
  pass: boolean;
  expected: unknown;
  actual: unknown;
  diff?: string[];
}

/** The contract every codec implementation (runtime interpreter or generated plugin) satisfies. */
export interface Codec {
  readonly spec: DeviceCodecSpec;
  decode(bytes: Uint8Array, ctx?: PayloadContext): DecodeResult;
  encode(message: string, data: DecodedData): EncodeResult;
}

/** Envelope every ingestion adapter produces before decoding. */
export interface RawEnvelope {
  id: string;
  tenantId: string;
  deviceId: string;
  receivedAt: string; // ISO-8601
  transport: "mqtt" | "http" | "udp" | "tcp" | "coap" | "lorawan";
  port?: number;
  topic?: string;
  payloadHex: string;
  meta?: Record<string, unknown>;
}

export interface DecodedEnvelope extends RawEnvelope {
  codecId: string;
  codecVersion: string;
  message: string;
  data: DecodedData;
  warnings: string[];
}
