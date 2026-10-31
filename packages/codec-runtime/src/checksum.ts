import type { ChecksumField } from "@hash8/dcs-schema";

export type ChecksumAlgo = ChecksumField["algo"];

/** Width in bits of each checksum algorithm's output. */
export const CHECKSUM_BITS: Record<ChecksumAlgo, number> = {
  crc8: 8,
  "crc16-ccitt": 16,
  "crc16-modbus": 16,
  crc32: 32,
  xor8: 8,
  sum8: 8,
};

function makeTable(fn: (n: number) => number): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) t[n] = fn(n);
  return t;
}

const CRC8 = makeTable((n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  return c;
});
const CCITT = makeTable((n) => {
  let c = n << 8;
  for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  return c;
});
const MODBUS = makeTable((n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
  return c;
});
const CRC32 = makeTable((n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  return c >>> 0;
});

/** Compute a checksum over `bytes[start, end)` (defaults: whole array). Result is an unsigned integer. */
export function checksum(algo: ChecksumAlgo, bytes: Uint8Array, start = 0, end = bytes.length): number {
  switch (algo) {
    case "crc8": {
      let c = 0;
      for (let i = start; i < end; i++) c = CRC8[c ^ bytes[i]!]!;
      return c;
    }
    case "crc16-ccitt": {
      let c = 0xffff;
      for (let i = start; i < end; i++) c = ((c << 8) & 0xffff) ^ CCITT[((c >>> 8) ^ bytes[i]!) & 0xff]!;
      return c;
    }
    case "crc16-modbus": {
      let c = 0xffff;
      for (let i = start; i < end; i++) c = (c >>> 8) ^ MODBUS[(c ^ bytes[i]!) & 0xff]!;
      return c;
    }
    case "crc32": {
      let c = 0xffffffff;
      for (let i = start; i < end; i++) c = (c >>> 8) ^ CRC32[(c ^ bytes[i]!) & 0xff]!;
      return (c ^ 0xffffffff) >>> 0;
    }
    case "xor8": {
      let c = 0;
      for (let i = start; i < end; i++) c ^= bytes[i]!;
      return c;
    }
    case "sum8": {
      let c = 0;
      for (let i = start; i < end; i++) c = (c + bytes[i]!) & 0xff;
      return c;
    }
    default:
      throw new Error(`unknown checksum algorithm "${algo as string}"`);
  }
}
