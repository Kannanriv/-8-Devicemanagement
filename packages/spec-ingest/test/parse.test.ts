import { describe, it, expect } from "vitest";
import {
  parseScale,
  parseType,
  parseUnit,
  parseEnum,
  parseRange,
  parsePosition,
  parseBitRange,
  toIdentifier,
  detectMessageMarker,
  detectEndian,
} from "../src/parse";

describe("parseScale", () => {
  it.each([
    ["0.1", 0.1],
    ["x0.01", 0.01],
    ["×0.1", 0.1],
    ["1/100", 0.01],
    ["/10", 0.1],
    ["÷ 1000", 0.001],
    ["0.1 °C", 0.1],
    ["1", 1],
    ["10", 10],
    ["Resolution: 0.5", 0.5],
  ])("%s -> %d", (txt, v) => {
    expect(parseScale(txt)).toBeCloseTo(v, 12);
  });
  it("returns undefined for junk", () => {
    expect(parseScale("")).toBeUndefined();
    expect(parseScale("n/a")).toBeUndefined();
    expect(parseScale("-")).toBeUndefined();
  });
});

describe("parseType", () => {
  it.each([
    ["U8", { type: "uint", bits: 8 }],
    ["UINT16", { type: "uint", bits: 16 }],
    ["uint32_t", { type: "uint", bits: 32 }],
    ["int16_t", { type: "int", bits: 16 }],
    ["S16", { type: "int", bits: 16 }],
    ["I32", { type: "int", bits: 32 }],
    ["WORD", { type: "uint", bits: 16 }],
    ["DWORD", { type: "uint", bits: 32 }],
    ["FLOAT32", { type: "float", bits: 32 }],
    ["float", { type: "float", bits: 32 }],
    ["double", { type: "float", bits: 64 }],
    ["ASCII", { type: "string" }],
    ["BCD", { type: "bcd" }],
    ["HEX", { type: "bytes" }],
    ["bool", { type: "bool" }],
    ["signed", { type: "int" }],
    ["unsigned", { type: "uint" }],
    ["Unsigned 16-bit", { type: "uint", bits: 16 }],
    ["Signed int (2 bytes)", { type: "int", bits: 16 }],
  ])("%s", (txt, expected) => {
    expect(parseType(txt)).toMatchObject(expected);
  });
  it("undefined for empty", () => expect(parseType("")).toBeUndefined());
});

describe("parseUnit", () => {
  it.each([
    ["°C", "Cel"],
    ["℃", "Cel"],
    ["degC", "Cel"],
    ["%RH", "%"],
    ["%", "%"],
    ["mV", "mV"],
    ["kWh", "kW.h"],
    ["kvarh", "kvar.h"],
    ["Hz", "Hz"],
    ["km/h", "km/h"],
    ["deg", "deg"],
    ["°", "deg"],
    ["dBm", "dBm"],
    ["-", undefined],
    ["", undefined],
  ])("%s -> %s", (txt, u) => expect(parseUnit(txt)).toBe(u));
});

describe("parseEnum", () => {
  it("parses '0=Off;1=On'", () => expect(parseEnum("0=Off;1=On")).toEqual({ "0": "Off", "1": "On" }));
  it("parses '0: Off, 1: On'", () => expect(parseEnum("0: Off, 1: On")).toEqual({ "0": "Off", "1": "On" }));
  it("parses hex dash lines", () =>
    expect(parseEnum("0x01 - SOS\n0x02 - Low battery\n0x10 - Tamper")).toEqual({ "1": "SOS", "2": "Low battery", "16": "Tamper" }));
  it("ignores plain descriptions", () => expect(parseEnum("Battery voltage in mV")).toBeUndefined());
  it("needs at least two entries", () => expect(parseEnum("1 = enabled")).toBeUndefined());
});

describe("parseRange", () => {
  it.each([
    ["0~100", { min: 0, max: 100 }],
    ["-40 to 85", { min: -40, max: 85 }],
    ["-40..85", { min: -40, max: 85 }],
    ["-40 ~ +85", { min: -40, max: 85 }],
    ["0 - 65535", { min: 0, max: 65535 }],
  ])("%s", (t, r) => expect(parseRange(t)).toEqual(r));
  it("undefined for junk", () => expect(parseRange("see notes")).toBeUndefined());
});

describe("parsePosition", () => {
  it.each([
    ["0", { byte: 0 }],
    ["3-4", { byte: 3, endByte: 4 }],
    ["3~6", { byte: 3, endByte: 6 }],
    ["Byte 5", { byte: 5 }],
    ["Byte 5 bit 0-3", { byte: 5, bitLo: 0, bitHi: 3 }],
    ["5.4-5.7", { byte: 5, bitLo: 4, bitHi: 7 }],
    ["B7 bit 2", { byte: 7, bitLo: 2, bitHi: 2 }],
    ["0x0A", { byte: 10 }],
  ])("%s", (t, r) => expect(parsePosition(t)).toEqual(r));
});

describe("parseBitRange", () => {
  it.each([
    ["0-3", { lo: 0, hi: 3 }],
    ["bit 7", { lo: 7, hi: 7 }],
    ["4..7", { lo: 4, hi: 7 }],
    ["b6", { lo: 6, hi: 6 }],
    ["7:4", { lo: 4, hi: 7 }],
  ])("%s", (t, r) => expect(parseBitRange(t)).toEqual(r));
});

describe("toIdentifier", () => {
  it("camelCases", () => {
    expect(toIdentifier("Battery Voltage")).toBe("batteryVoltage");
    expect(toIdentifier("GPS fix (valid)")).toBe("gpsFixValid");
    expect(toIdentifier("1st value")).toBe("_1stValue");
    expect(toIdentifier("temperature")).toBe("temperature");
    expect(toIdentifier("rssi_dbm")).toBe("rssi_dbm");
    expect(toIdentifier("Température")).toBe("temperature");
  });
});

describe("detectMessageMarker", () => {
  it("finds ports, ids, direction and topic", () => {
    expect(detectMessageMarker("Uplink – fPort: 1 – Periodic report")).toMatchObject({ port: 1, direction: "uplink" });
    expect(detectMessageMarker("Port 2 (Config ACK)")).toMatchObject({ port: 2 });
    expect(detectMessageMarker("Message ID 0x01 – Location Report")).toMatchObject({ messageId: 1, title: "Location Report" });
    expect(detectMessageMarker("Downlink command 0x80: Set Interval")).toMatchObject({ direction: "downlink", messageId: 0x80 });
    expect(detectMessageMarker("MQTT topic: voltix/em3/+/rt")).toMatchObject({ topic: "voltix/em3/+/rt" });
    expect(detectMessageMarker("Battery voltage")).toBeUndefined();
  });
});

describe("detectEndian", () => {
  it("detects notes", () => {
    expect(detectEndian("All multi-byte values are little endian")).toBe("little");
    expect(detectEndian("LSB first")).toBe("little");
    expect(detectEndian("Byte order: Big-Endian (network order)")).toBe("big");
    expect(detectEndian("MSB first")).toBe("big");
    expect(detectEndian("nothing")).toBeUndefined();
  });
});
