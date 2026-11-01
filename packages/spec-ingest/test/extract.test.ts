import { describe, it, expect } from "vitest";
import { safeParseSpec, type ScalarField, type ConstField } from "@hash8/dcs-schema";
import { extractFromWorkbook, workbookToText } from "../src";
import { makeWorkbook } from "./helpers";

const lora = () =>
  makeWorkbook([
    { name: "Cover", rows: [["ENVIRO SENSE LTD"], [], ["Document", "TH Payload Spec"], ["Revision", "1.4"]] },
    {
      name: "Uplink",
      merges: ["A1:H1"],
      rows: [
        ["Uplink – fPort: 1 – Periodic report"],
        ["Note: all multi-byte values are big endian"],
        [],
        ["Byte", "Size", "Field", "Data type", "Unit", "Resolution", "Values", "Description", "Example"],
        [0, 2, "Temperature", "int16", "°C", "0.01", "", "Ambient temperature", 21.5],
        [2, 1, "Humidity", "U8", "%RH", "x0.5", "", "", 45],
        ["Byte 3 bit 4-7", "", "Battery level", "", "", "", "", "0..15", 9],
        ["Byte 3 bit 0-3", "", "Status", "", "", "", "0=OK;1=Low battery;2=Sensor fault", "", "OK"],
        [5, 2, "Counter", "UINT16", "", "", "", "Frame counter", 7],
        [],
        ["Example payload: 08 66 5A 90 00 00 07"],
      ],
    },
  ]);

describe("extractFromWorkbook", () => {
  it("extracts a LoRaWAN uplink table into a valid DCS draft", async () => {
    const r = await extractFromWorkbook(await lora(), { fileName: "Envio_TH.xlsx", vendor: "Envio", model: "TH-Sense" });
    const v = safeParseSpec(r.draft);
    expect(v.success, JSON.stringify(v.success ? "" : v.error.issues)).toBe(true);
    expect(r.draft.id).toBe("envio.th-sense");
    expect(r.draft.uplink).toHaveLength(1);
    const msg = r.draft.uplink[0]!;
    expect(msg.when).toEqual({ port: 1 });
    const names = msg.fields.map((f) => (f as { name: string }).name);
    expect(names).toEqual(["temperature", "humidity", "batteryLevel", "status", "reserved4", "counter"]);
    const temp = msg.fields[0] as ScalarField;
    expect(temp).toMatchObject({ type: "int", bits: 16, scale: 0.01, unit: "Cel" });
    const hum = msg.fields[1] as ScalarField;
    expect(hum).toMatchObject({ type: "uint", bits: 8, scale: 0.5, unit: "%" });
    expect(msg.fields[2]).toMatchObject({ type: "uint", bits: 4, min: 0, max: 15 });
    expect(msg.fields[3]).toMatchObject({ type: "uint", bits: 4, enum: { "0": "OK", "1": "Low battery", "2": "Sensor fault" } });
    expect(msg.fields[4]).toMatchObject({ type: "uint", bits: 8, hidden: true });
    expect(r.issues.some((i) => /gap/i.test(i) && /byte 4/i.test(i))).toBe(true);
    // trace: every visible field points at its source row on the Uplink sheet
    expect(r.trace["periodicReport.temperature"]).toMatchObject({ sheet: "Uplink", row: 5, cell: "C5", file: "Envio_TH.xlsx" });
    expect(r.trace["periodicReport.status"]!.confidence).toBeGreaterThan(0.5);
    expect(r.confidence).toBeGreaterThan(0.6);
    expect(r.confidence).toBeLessThanOrEqual(1);
    // example column + example payload -> a test vector
    expect(r.draft.vectors).toEqual([
      expect.objectContaining({
        port: 1,
        hex: "0866 5a90 0000 07".replace(/ /g, ""),
        message: "periodicReport",
        data: { temperature: 21.5, humidity: 45, batteryLevel: 9, status: "OK", counter: 7 },
      }),
    ]);
    expect(r.sheets.find((s) => s.name === "Uplink")).toMatchObject({ tables: 1, role: "messages" });
    expect(r.sheets.find((s) => s.name === "Cover")).toMatchObject({ tables: 0 });
  });

  it("handles multiple tables per sheet, message-id consts, little endian and downlinks", async () => {
    const data = await makeWorkbook([
      {
        name: "Protocol",
        rows: [
          ["ACME GT200 Communication Protocol"],
          ["Byte order: LSB first (little endian)"],
          [],
          ["Message ID 0x01 – Location Report"],
          ["Offset", "Len", "Parameter", "Format", "Unit", "Factor", "Remark"],
          [0, 1, "Message ID", "HEX", "", "", "Fixed 0x01"],
          [1, 4, "Latitude", "signed", "°", "1/1000000", ""],
          [2 + 3, 4, "Longitude", "signed", "°", "1/1000000", ""],
          [9, 2, "Speed", "UINT16", "km/h", "0.1", ""],
          [],
          ["Message ID 0x02 – Heartbeat"],
          ["Offset", "Len", "Parameter", "Format", "Unit", "Factor", "Remark"],
          [0, 1, "Message ID", "HEX", "", "", "Fixed 0x02"],
          [1, 2, "Battery", "U16", "mV", "", ""],
          [3, 1, "Alarm", "U8", "", "", "0x00 - None\n0x01 - SOS\n0x02 - Low battery"],
        ],
      },
      {
        name: "Downlink Commands",
        rows: [
          ["Command 0x80: Set report interval"],
          ["Offset", "Len", "Parameter", "Format", "Unit", "Factor", "Remark"],
          [0, 1, "Command ID", "U8", "", "", "Fixed 0x80"],
          [1, 2, "Interval", "U16", "s", "", "10~86400"],
        ],
      },
    ]);
    const r = await extractFromWorkbook(data, { fileName: "Acme_GT200_Protocol_v2.3.xlsx" });
    expect(safeParseSpec(r.draft).success).toBe(true);
    expect(r.draft.device).toMatchObject({ vendor: "Acme", model: "GT200" });
    expect(r.draft.version).toBe("2.3.0-draft");
    expect(r.draft.defaults).toEqual({ endian: "little" });
    expect(r.draft.uplink.map((m) => m.name)).toEqual(["locationReport", "heartbeat"]);
    const loc = r.draft.uplink[0]!;
    expect(loc.fields[0]).toMatchObject({ kind: "const", bits: 8, value: 1 } satisfies Partial<ConstField>);
    expect(loc.fields[1]).toMatchObject({ name: "latitude", type: "int", bits: 32, scale: 0.000001, unit: "deg" });
    expect(r.draft.uplink[1]!.fields[0]).toMatchObject({ kind: "const", value: 2 });
    expect(r.draft.uplink[1]!.fields[2]).toMatchObject({ name: "alarm", enum: { "0": "None", "1": "SOS", "2": "Low battery" } });
    expect(r.draft.downlink?.map((m) => m.name)).toEqual(["setReportInterval"]);
    expect(r.draft.downlink![0]!.fields[0]).toMatchObject({ kind: "const", value: 0x80 });
    expect(r.draft.downlink![0]!.fields[1]).toMatchObject({ name: "interval", min: 10, max: 86400, unit: "s" });
    expect(r.trace["heartbeat.battery"]).toMatchObject({ sheet: "Protocol" });
  });

  it("treats an 'Offset' column as value offset when a byte-position column exists, and uses key columns", async () => {
    const data = await makeWorkbook([
      {
        name: "Port 3",
        rows: [
          ["Pos", "Name", "JSON key", "Type", "Offset", "Scale", "Unit", "Min", "Max"],
          ["0-1", "Ambient temp", "temp_c", "S16", "-40", "0.1", "C", "-40", "85"],
          ["2", "Flags", "flags", "U8", "", "", "", "", ""],
        ],
      },
    ]);
    const r = await extractFromWorkbook(data, { vendor: "X", model: "Y" });
    const m = r.draft.uplink[0]!;
    expect(m.when).toEqual({ port: 3 });
    expect(m.fields[0]).toMatchObject({ name: "temp_c", type: "int", bits: 16, offset: -40, scale: 0.1, unit: "Cel", min: -40, max: 85 });
    expect(m.fields[1]).toMatchObject({ name: "flags", bits: 8 });
  });

  it("flags low-confidence guesses and still produces a valid draft for a bare table", async () => {
    const data = await makeWorkbook([{ name: "Sheet1", rows: [["Field", "Bytes"], ["a", 1], ["b", 2]] }]);
    const r = await extractFromWorkbook(data);
    expect(safeParseSpec(r.draft).success).toBe(true);
    expect(r.draft.uplink[0]!.fields.map((f) => (f as { name: string }).name)).toEqual(["a", "b"]);
    expect(r.issues.join("\n")).toMatch(/type/i);
    expect(r.confidence).toBeLessThan(0.9);
  });

  it("returns a placeholder draft and an issue when no table is found", async () => {
    const data = await makeWorkbook([{ name: "Notes", rows: [["hello"], ["world"]] }]);
    const r = await extractFromWorkbook(data, { vendor: "X", model: "Y" });
    expect(r.issues.join(" ")).toMatch(/no field table/i);
    expect(r.confidence).toBe(0);
    expect(safeParseSpec(r.draft).success).toBe(true);
  });
});

describe("workbookToText", () => {
  it("renders compact cell-addressed text", async () => {
    const txt = await workbookToText(await lora());
    expect(txt).toContain("## Sheet: Uplink");
    expect(txt).toContain("A1: Uplink – fPort: 1 – Periodic report");
    expect(txt).toMatch(/C5: Temperature/);
    expect(txt).toContain("merged A1:H1");
  });
});

describe("nested layouts", () => {
  it("turns a byte row followed by bit rows into a group, honours [key] message names and reserved rows", async () => {
    const data = await makeWorkbook([
      {
        name: "Uplink",
        rows: [
          ["fPort 1 – Periodic measurement [periodic]"],
          ["Byte", "Bit", "Name", "JSON key", "Type", "Example"],
          ["0-1", "", "Temperature", "temperature", "int16", 1],
          [2, "", "Status flags", "status", "bitfield", ""],
          ["", "7", "Battery low", "low_battery", "flag", "true"],
          ["", "6", "Sensor error", "sensor_error", "flag", "false"],
          ["", "5-0", "Reserved", "reserved", "", ""],
          [],
          ["Example: 0001 80"],
        ],
      },
    ]);
    const r = await extractFromWorkbook(data, { vendor: "V", model: "M" });
    const m = r.draft.uplink[0]!;
    expect(m.name).toBe("periodic");
    expect(m.fields[1]).toMatchObject({
      kind: "group",
      name: "status",
      fields: [
        { name: "low_battery", type: "bool", bits: 1 },
        { name: "sensor_error", type: "bool", bits: 1 },
        { name: "reserved", type: "uint", bits: 6, hidden: true },
      ],
    });
    expect(r.trace["periodic.status.low_battery"]).toMatchObject({ row: 5 });
    expect(r.draft.vectors![0]).toMatchObject({ hex: "000180", data: { temperature: 1, status: { low_battery: true, sensor_error: false } } });
  });

  it("models repeated blocks (fixed, remaining, count reference) and sub-structures with +n offsets", async () => {
    const data = await makeWorkbook([
      {
        name: "Frames",
        rows: [
          ["Topic: m/+/rt [realtime]"],
          ["Offset", "Size", "Parameter", "Tag", "Type", "Description"],
          [0, 4, "Meter ID", "meterId", "HEX", ""],
          [4, "", "Phase block", "phases", "", "Repeated 3 times (L1, L2, L3)"],
          ["+0", 2, "Voltage", "voltage", "U16", ""],
          ["+3", 1, "PF", "pf", "S8", ""],
          [16, 1, "Alarm", "alarm", "U8", ""],
        ],
      },
      {
        name: "Daily",
        rows: [
          ["Topic: m/+/daily [daily_summary]"],
          ["Offset", "Size", "Parameter", "Tag", "Type", "Description"],
          [0, 4, "Date", "date", "", ""],
          ["+0", 2, "Year", "year", "U16", ""],
          ["+2", 1, "Month", "month", "U8", ""],
          ["+3", 1, "Day", "day", "U8", ""],
          [4, 1, "Count", "count", "U8", "Number of interval records N"],
          [5, "3×N", "Intervals", "intervals", "", "Repeated N times (N = count)"],
          ["+0", 1, "Hour", "hour", "U8", ""],
          ["+1", 2, "Energy", "energy", "U16", ""],
          ["5+3N", 2, "CRC", "crc", "CRC-16/MODBUS", ""],
        ],
      },
      {
        name: "Log upload",
        rows: [
          ["fPort 3 [history]"],
          ["Byte", "Size", "Name", "Key", "Type", "Description"],
          [0, "", "Samples", "samples", "", "Repeated until end of payload"],
          ["+0", 1, "Age", "offset_min", "U8", ""],
          ["+1", 2, "Temp", "temperature", "S16", ""],
        ],
      },
    ]);
    const r = await extractFromWorkbook(data, { vendor: "V", model: "M" });
    const [rt, daily, hist] = r.draft.uplink;
    expect(rt!.name).toBe("realtime");
    expect(rt!.fields[1]).toMatchObject({ kind: "repeat", name: "phases", count: 3, fields: [{ name: "voltage", bits: 16 }, { name: "reserved2", hidden: true }, { name: "pf", type: "int", bits: 8 }] });
    expect(rt!.fields[2]).toMatchObject({ name: "alarm" });
    expect(daily!.fields.map((f) => (f as { name: string }).name)).toEqual(["date", "count", "intervals", "crc"]);
    expect(daily!.fields[0]).toMatchObject({ kind: "group", fields: [{ name: "year" }, { name: "month" }, { name: "day" }] });
    expect(daily!.fields[2]).toMatchObject({ kind: "repeat", count: { ref: "count" }, fields: [{ name: "hour" }, { name: "energy" }] });
    expect(daily!.fields[3]).toMatchObject({ kind: "checksum", algo: "crc16-modbus" });
    expect(hist!.when).toEqual({ port: 3 });
    expect(hist!.fields[0]).toMatchObject({ kind: "repeat", count: "remaining", fields: [{ name: "offset_min" }, { name: "temperature", type: "int" }] });
    expect(safeParseSpec(r.draft).success).toBe(true);
  });
});

describe("register maps", () => {
  it("skips Modbus register maps (no payload offsets) with an issue", async () => {
    const data = await makeWorkbook([
      { name: "Register Map", rows: [["Register (hex)", "Parameter", "Data type", "Unit"], ["0x0000", "Voltage L1", "UINT16", "V"], ["0x0002", "Current L1", "UINT16", "A"]] },
      { name: "Port 1", rows: [["Byte", "Name", "Type"], [0, "Voltage", "U16"]] },
    ]);
    const r = await extractFromWorkbook(data, { vendor: "V", model: "M" });
    expect(r.draft.uplink.map((m) => m.name)).toEqual(["port1"]);
    expect(r.sheets[0]).toMatchObject({ role: "registers", tables: 0 });
    expect(r.issues.join("\n")).toMatch(/register map/i);
  });
});
