import { describe, it, expect } from "vitest";
import { checksum } from "../src";

const check = new TextEncoder().encode("123456789");

describe("checksum", () => {
  it("crc8 check value", () => expect(checksum("crc8", check)).toBe(0xf4));
  it("crc16-ccitt (CCITT-FALSE) check value", () => expect(checksum("crc16-ccitt", check)).toBe(0x29b1));
  it("crc16-modbus check value", () => expect(checksum("crc16-modbus", check)).toBe(0x4b37));
  it("crc32 check value (unsigned)", () => expect(checksum("crc32", check)).toBe(0xcbf43926));
  it("xor8 check value", () => expect(checksum("xor8", check)).toBe(0x31));
  it("sum8 check value", () => expect(checksum("sum8", check)).toBe(0xdd));
  it("empty input returns init/xorout values", () => {
    expect(checksum("crc16-ccitt", new Uint8Array())).toBe(0xffff);
    expect(checksum("crc32", new Uint8Array())).toBe(0);
    expect(checksum("xor8", new Uint8Array())).toBe(0);
  });
});
