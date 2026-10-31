/**
 * Low-level MSB-first bit cursor helpers. Numbers are used for widths <= 48 bits,
 * BigInt only for wider fields (see docs/dcs-semantics.md §2–3).
 */

/** Read `n` (<= 48) bits MSB-first starting at bit `pos`. Caller guarantees bounds. */
export function readBitsBE(buf: Uint8Array, pos: number, n: number): number {
  let v = 0;
  while (n > 0) {
    const off = pos & 7;
    const avail = 8 - off;
    const take = avail < n ? avail : n;
    v = v * (1 << take) + ((buf[pos >> 3]! >> (avail - take)) & ((1 << take) - 1));
    pos += take;
    n -= take;
  }
  return v;
}

/** Build an unsigned reader for a fixed width <= 48. `little` is honoured only when the read is byte aligned. */
export function makeUintReader(bits: number, little: boolean): (buf: Uint8Array, pos: number) => number {
  const byteMultiple = bits % 8 === 0;
  const nb = bits >> 3;
  if (bits === 8) return (b, p) => ((p & 7) === 0 ? b[p >> 3]! : readBitsBE(b, p, 8));
  if (bits === 16) {
    return little
      ? (b, p) => ((p & 7) === 0 ? b[p >> 3]! | (b[(p >> 3) + 1]! << 8) : readBitsBE(b, p, 16))
      : (b, p) => ((p & 7) === 0 ? (b[p >> 3]! << 8) | b[(p >> 3) + 1]! : readBitsBE(b, p, 16));
  }
  if (bits === 32) {
    return little
      ? (b, p) => {
          if ((p & 7) !== 0) return readBitsBE(b, p, 32);
          const i = p >> 3;
          return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
        }
      : (b, p) => {
          if ((p & 7) !== 0) return readBitsBE(b, p, 32);
          const i = p >> 3;
          return ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
        };
  }
  if (byteMultiple) {
    return (b, p) => {
      if ((p & 7) !== 0) return readBitsBE(b, p, bits);
      const i = p >> 3;
      let v = 0;
      if (little) for (let k = nb - 1; k >= 0; k--) v = v * 256 + b[i + k]!;
      else for (let k = 0; k < nb; k++) v = v * 256 + b[i + k]!;
      return v;
    };
  }
  return (b, p) => readBitsBE(b, p, bits);
}

/** BigInt reader for widths > 48. */
export function readBig(buf: Uint8Array, pos: number, bits: number, little: boolean): bigint {
  if (little && (pos & 7) === 0 && bits % 8 === 0) {
    const i = pos >> 3;
    let v = 0n;
    for (let k = (bits >> 3) - 1; k >= 0; k--) v = (v << 8n) | BigInt(buf[i + k]!);
    return v;
  }
  let v = 0n;
  let n = bits;
  while (n > 0) {
    const take = n > 24 ? 24 : n;
    v = (v << BigInt(take)) | BigInt(readBitsBE(buf, pos, take));
    pos += take;
    n -= take;
  }
  return v;
}

/** Growable MSB-first bit writer. */
export class BitWriter {
  buf = new Uint8Array(64);
  pos = 0;

  private ensure(bits: number): void {
    const need = (this.pos + bits + 7) >> 3;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf);
    this.buf = nb;
  }

  /** Write unsigned `v` (0 <= v < 2^bits, bits <= 48). */
  writeUint(v: number, bits: number, little: boolean): void {
    this.ensure(bits);
    let pos = this.pos;
    if (little && (pos & 7) === 0 && bits % 8 === 0) {
      let i = pos >> 3;
      for (let k = 0; k < bits >> 3; k++) {
        this.buf[i++] = v % 256;
        v = Math.floor(v / 256);
      }
      this.pos += bits;
      return;
    }
    let n = bits;
    while (n > 0) {
      const off = pos & 7;
      const avail = 8 - off;
      const take = avail < n ? avail : n;
      const chunk = Math.floor(v / 2 ** (n - take)) % (1 << take);
      this.buf[pos >> 3]! |= chunk << (avail - take);
      pos += take;
      n -= take;
    }
    this.pos = pos;
  }

  /** Write unsigned BigInt `v` (0 <= v < 2^bits). */
  writeBig(v: bigint, bits: number, little: boolean): void {
    if (little && (this.pos & 7) === 0 && bits % 8 === 0) {
      this.ensure(bits);
      let i = this.pos >> 3;
      for (let k = 0; k < bits >> 3; k++) {
        this.buf[i++] = Number(v & 0xffn);
        v >>= 8n;
      }
      this.pos += bits;
      return;
    }
    let n = bits;
    while (n > 0) {
      const take = n > 24 ? 24 : n;
      this.writeUint(Number((v >> BigInt(n - take)) & ((1n << BigInt(take)) - 1n)), take, false);
      n -= take;
    }
  }

  /** Write whole bytes at a byte-aligned cursor. */
  writeBytes(bytes: Uint8Array): void {
    this.ensure(bytes.length * 8);
    this.buf.set(bytes, this.pos >> 3);
    this.pos += bytes.length * 8;
  }

  result(): Uint8Array {
    return this.buf.slice(0, (this.pos + 7) >> 3);
  }
}

const scratch = new DataView(new ArrayBuffer(8));

export function readFloat(buf: Uint8Array, byteIndex: number, bits: 32 | 64, little: boolean): number {
  const n = bits >> 3;
  for (let k = 0; k < n; k++) scratch.setUint8(k, buf[byteIndex + k]!);
  return bits === 32 ? scratch.getFloat32(0, little) : scratch.getFloat64(0, little);
}

export function floatBytes(v: number, bits: 32 | 64, little: boolean): Uint8Array {
  if (bits === 32) scratch.setFloat32(0, v, little);
  else scratch.setFloat64(0, v, little);
  return new Uint8Array(scratch.buffer.slice(0, bits >> 3));
}
