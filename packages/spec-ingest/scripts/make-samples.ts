/**
 * Generates three deliberately messy, differently styled OEM spec workbooks into samples/excel/.
 * They describe the same devices as samples/specs/*.json, the way real OEMs ship them:
 * cover sheets, revision history, logos-as-text, merged headers, coloured rows,
 * struck-through deprecated rows, notes and example payloads.
 *
 *   npx tsx packages/spec-ingest/scripts/make-samples.ts
 */
import ExcelJS from "exceljs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = path.resolve(here, "../../../samples/excel");

type Cell = string | number | null | undefined;
interface RowStyle {
  bold?: boolean;
  italic?: boolean;
  fill?: string;
  color?: string;
  strike?: boolean;
  size?: number;
  wrap?: boolean;
}

class Sheet {
  r = 1;
  constructor(public ws: ExcelJS.Worksheet) {}
  row(cells: Cell[], style: RowStyle = {}, startCol = 1): number {
    const r = this.r++;
    cells.forEach((v, i) => {
      if (v === null || v === undefined || v === "") return;
      const c = this.ws.getCell(r, startCol + i);
      c.value = v;
      c.font = { name: "Calibri", size: style.size ?? 10, bold: !!style.bold, italic: !!style.italic, strike: !!style.strike, ...(style.color ? { color: { argb: style.color } } : {}) };
      if (style.wrap) c.alignment = { wrapText: true, vertical: "top" };
    });
    if (style.fill)
      for (let i = 0; i < Math.max(cells.length, 1); i++)
        this.ws.getCell(r, startCol + i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: style.fill } };
    return r;
  }
  blank(n = 1) {
    this.r += n;
  }
  title(text: string, span: number, style: RowStyle = {}) {
    const r = this.row([text], { bold: true, size: 13, ...style });
    this.ws.mergeCells(r, 1, r, span);
    return r;
  }
  widths(w: number[]) {
    w.forEach((x, i) => (this.ws.getColumn(i + 1).width = x));
  }
}

function sheet(wb: ExcelJS.Workbook, name: string, tab?: string): Sheet {
  const ws = wb.addWorksheet(name, tab ? { properties: { tabColor: { argb: tab } } } : {});
  return new Sheet(ws);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Envio TH-Sense — tidy LoRaWAN doc, JSON keys, bit table, examples column
// ─────────────────────────────────────────────────────────────────────────
export function envio(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Envio Sensing Ltd.";
  const cover = sheet(wb, "Cover", "FF2E7D32");
  cover.widths([4, 40, 30]);
  cover.blank();
  cover.row(["", "◉ ENVIO  ·  sense the indoors"], { bold: true, size: 20, color: "FF2E7D32" });
  cover.row(["", "TH-Sense LoRaWAN Temperature & Humidity Sensor"], { size: 14 });
  cover.row(["", "Payload Specification"], { size: 14, bold: true });
  cover.blank();
  cover.row(["", "Manufacturer", "Envio"]);
  cover.row(["", "Model", "TH-Sense"]);
  cover.row(["", "Document revision", "1.1"]);
  cover.row(["", "Applies to firmware", "≥ 1.4"]);
  cover.row(["", "Classification", "Customer confidential"], { italic: true });

  const rev = sheet(wb, "Revision History");
  rev.widths([10, 14, 60]);
  rev.row(["Rev", "Date", "Change"], { bold: true, fill: "FFC8E6C9" });
  rev.row(["1.0", "2025-03-02", "Initial release"]);
  rev.row(["1.1", "2026-02-14", "Added fPort 3 history upload; status byte bit 6 sensor error"]);

  const up = sheet(wb, "Uplink", "FF1565C0");
  up.widths([7, 6, 6, 20, 15, 11, 8, 8, 12, 46, 36, 10]);
  up.title("UPLINK MESSAGES (device → network server)", 11, { fill: "FF1565C0", color: "FFFFFFFF" });
  up.row(["All multi-byte fields are big-endian (MSB first). Payloads are not encrypted at application level."], { italic: true });
  up.blank();
  const H = ["Byte", "Bit", "Size", "Name", "JSON key", "Format", "Ratio", "Unit", "Range", "Values", "Remark", "Example"];
  const head = () => up.row(H, { bold: true, fill: "FFBBDEFB" });

  up.row(["fPort 1 – Periodic measurement [periodic]"], { bold: true, size: 12 });
  head();
  up.row(["0-1", "", 2, "Temperature", "temperature", "int16_t", "1/100", "℃", "-40 ~ +85", "", "Ambient temperature", 22.57]);
  up.row(["2", "", 1, "Relative humidity", "humidity", "uint8_t", "0.5", "%RH", "0~100", "", "", 47.5], { fill: "FFF5F5F5" });
  up.row(["3-4", "", 2, "Battery voltage", "battery", "uint16_t", "1", "mV", "2000~3700", "", "", 3010]);
  up.row(["5", "", 1, "Status", "status", "bitfield", "", "", "", "", "see bits below", ""], { fill: "FFF5F5F5" });
  up.row(["", "7", "", "Battery low", "low_battery", "flag", "", "", "", "", "1 when battery < 2400 mV", "false"]);
  up.row(["", "6", "", "Sensor error", "sensor_error", "flag", "", "", "", "", "SHT4x not responding", "false"]);
  up.row(["", "5..0", "", "Reserved", "reserved", "", "", "", "", "", "always 0", ""], { color: "FF9E9E9E" });
  up.row(["Example (office): 08 D1 5F 0B C2 00"], { italic: true, color: "FF616161" });
  up.row([
    "Example (freezer, low battery): F8 DF A4 09 2E 80",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    'Decoded: {"temperature":-18.25,"humidity":82,"battery":2350,"status":{"low_battery":true,"sensor_error":false}}',
  ], { italic: true, color: "FF616161" });
  up.blank();

  up.row(["fPort 2 – Configuration acknowledgement [config_ack]"], { bold: true, size: 12 });
  head();
  up.row(["0", "", 1, "Command", "command", "uint8_t", "", "", "", "0x01 = set_interval; 0x02 = request_history", "echo of the downlink command", "set_interval"]);
  up.row(["1", "", 1, "Result", "result", "uint8_t", "", "", "", "0 = ok, 1 = rejected, 2 = invalid_param", "", "ok"], { fill: "FFF5F5F5" });
  up.row(["2-3", "", 2, "Interval", "interval", "uint16_t", "", "min", "", "", "currently applied interval", 15]);
  up.row(["Example: 01 00 00 0F"], { italic: true, color: "FF616161" });
  up.blank();

  up.row(["fPort 3 – History upload [history]"], { bold: true, size: 12 });
  head();
  up.row(["0", "", "N×3", "Samples", "samples", "", "", "", "", "", "Record repeated until end of payload, oldest first. Empty payload = buffer empty.", ""]);
  up.row(["+0", "", 1, "Age", "offset_min", "uint8_t", "", "min", "", "", "minutes before upload", ""], { fill: "FFF5F5F5" });
  up.row(["+1", "", 2, "Temperature", "temperature", "int16_t", "1/100", "°C", "-40 ~ +85", "", "", ""]);
  up.row([
    "Example: 1E 08 61 14 08 70 0A 08 87",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    'Decoded: {"samples":[{"offset_min":30,"temperature":21.45},{"offset_min":20,"temperature":21.6},{"offset_min":10,"temperature":21.83}]}',
  ], { italic: true, color: "FF616161" });

  const dn = sheet(wb, "Downlink (fPort 10)", "FFEF6C00");
  dn.widths([7, 6, 6, 20, 15, 11, 8, 8, 12, 14, 36, 10]);
  dn.title("DOWNLINK COMMANDS — all on fPort 10, first byte selects the command", 11, { fill: "FFEF6C00", color: "FFFFFFFF" });
  dn.blank();
  const DH = ["Byte", "Bit", "Size", "Name", "JSON key", "Format", "Ratio", "Unit", "Range", "Default", "Remark", "Example"];
  dn.row(["Command 0x01 – Set reporting interval [set_interval]"], { bold: true });
  dn.row(DH, { bold: true, fill: "FFFFE0B2" });
  dn.row(["0", "", 1, "Command", "cmd", "uint8_t", "", "", "", "", "Fixed 0x01", ""]);
  dn.row(["1-2", "", 2, "Interval", "interval", "uint16_t", "", "min", "1~1440", 15, "", 15]);
  dn.row(["Example: 01 00 0F"], { italic: true });
  dn.blank();
  dn.row(["Command 0x02 – Request history [request_history]"], { bold: true });
  dn.row(DH, { bold: true, fill: "FFFFE0B2" });
  dn.row(["0", "", 1, "Command", "cmd", "uint8_t", "", "", "", "", "Fixed 0x02", ""]);
  dn.row(["1", "", 1, "Hours", "hours", "uint8_t", "", "h", "1~48", 24, "how far back to upload", 6]);
  dn.row(["Example: 02 06"], { italic: true });
  return wb;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Voltix EM3 — Modbus register map + MQTT frame map, little endian, Tag column
// ─────────────────────────────────────────────────────────────────────────
export function voltix(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Voltix Metering";
  const info = sheet(wb, "Info");
  info.widths([28, 60]);
  info.title("VOLTIX ⚡ METERING SYSTEMS", 2, { size: 18, color: "FFFFC107", fill: "FF212121" });
  info.row(["EM3 three-phase energy meter — Modbus / MQTT interface map"], { bold: true });
  info.blank();
  info.row(["Vendor", "Voltix"]);
  info.row(["Model", "EM3"]);
  info.row(["Interface", "RS-485 Modbus RTU → on-board MQTT gateway (Wi-Fi / Ethernet), optional LoRaWAN module"]);
  info.row(["Doc version", "v1.4 (draft for integrators)"]);
  info.blank();
  info.row(["IMPORTANT", "Gateway frames are LITTLE ENDIAN (LSB first) — unlike the Modbus registers, which are big-endian on the wire."], { bold: true, color: "FFC62828", wrap: true });
  info.row(["", "CRC is CRC-16/MODBUS, LSB first, over all preceding bytes of the frame."]);
  info.row(["Changelog", "1.2 added daily summary; 1.3 pf became signed; 1.4 relay downlink"]);

  const reg = sheet(wb, "Register Map");
  reg.widths([16, 26, 12, 8, 10, 8]);
  reg.row(["Modbus holding registers (function 0x03) — for reference only"], { italic: true });
  reg.row(["Register (hex)", "Parameter", "Data type", "Unit", "Multiplier", "R/W"], { bold: true, fill: "FFFFF59D" });
  const regs: Cell[][] = [
    ["0x0000", "Voltage L1", "UINT16", "V", "0.1", "R"],
    ["0x0001", "Current L1", "UINT16", "A", "0.01", "R"],
    ["0x0002", "Active power L1", "INT32", "W", "1", "R"],
    ["0x0030", "Total active energy", "UINT32", "kWh", "0.01", "R"],
    ["0x0040", "Frequency", "UINT16", "Hz", "0.01", "R"],
    ["0x0100", "Relay", "UINT16", "", "", "R/W"],
  ];
  regs.forEach((r, i) => reg.row(r, i % 2 ? { fill: "FFFFFDE7" } : {}));

  const mq = sheet(wb, "MQTT Payload", "FFFFC107");
  mq.widths([12, 9, 26, 14, 11, 11, 7, 10, 60]);
  mq.title("MQTT BINARY FRAMES", 9, { fill: "FF212121", color: "FFFFC107" });
  mq.blank();
  const H = ["Offset", "Bytes", "Parameter", "Tag", "Data type", "Multiplier", "Unit", "Range", "Notes"];
  mq.row(["Realtime frame [realtime]"], { bold: true, size: 12 });
  mq.row(["Topic: voltix/em3/{meterId}/realtime  —  LoRaWAN fPort 1"], { italic: true });
  mq.row(H, { bold: true, fill: "FFFFE082" });
  mq.row([0, 4, "Meter ID", "meterId", "HEX", "", "", "", "last 4 bytes of the serial"]);
  mq.row([4, 27, "Phase block (L1, L2, L3)", "phases", "", "", "", "", "Repeated 3 times, 9 bytes each"], { fill: "FFEEEEEE" });
  mq.row(["+0", 2, "Voltage", "voltage", "UINT16", "x0.1", "V", "0~300", ""]);
  mq.row(["+2", 2, "Current", "current", "UINT16", "x0.01", "A", "", "max 100 A"]);
  mq.row(["+4", 4, "Active power", "power", "INT32", "1", "W", "", "negative = export"]);
  mq.row(["+8", 1, "Power factor", "pf", "INT8", "x0.01", "", "-1~1", "signed since v1.3"]);
  mq.row([31, 4, "Total active energy", "totalEnergy", "UINT32", "x0.01", "kWh", "", "import, cumulative"], { fill: "FFEEEEEE" });
  mq.row([35, 2, "Frequency", "frequency", "UINT16", "x0.01", "Hz", "45~65", ""]);
  mq.row([37, 1, "Alarm", "alarm", "UINT8", "", "", "", "0=none;1=overvoltage;2=undervoltage;3=overcurrent;4=phase_loss;5=tamper"]);
  mq.row([38, 2, "CRC", "crc", "CRC16", "", "", "", "CRC-16/MODBUS"]);
  mq.row([
    "Example: a1b2c3d400090002600400005ffa08e7011a0400005e07095b022d0500006087d61200891300c635",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    'Decoded: {"meterId":"a1b2c3d4","phases":[{"voltage":230.4,"current":5.12,"power":1120,"pf":0.95},{"voltage":229.8,"current":4.87,"power":1050,"pf":0.94},{"voltage":231.1,"current":6.03,"power":1325,"pf":0.96}],"totalEnergy":12345.67,"frequency":50.01,"alarm":"none"}',
  ], { italic: true });
  mq.blank(2);
  mq.row(["Daily summary [daily_summary]"], { bold: true, size: 12 });
  mq.row(["Topic: voltix/em3/{meterId}/daily  —  LoRaWAN fPort 2   (sent at 00:05 local time)"], { italic: true });
  mq.row(H, { bold: true, fill: "FFFFE082" });
  mq.row([0, 4, "Meter ID", "meterId", "HEX", "", "", "", ""]);
  mq.row([4, 4, "Date", "date", "", "", "", "", "local date of the summarised day"], { fill: "FFEEEEEE" });
  mq.row(["+0", 2, "Year", "year", "UINT16", "", "", "", ""]);
  mq.row(["+2", 1, "Month", "month", "UINT8", "", "", "1~12", ""]);
  mq.row(["+3", 1, "Day", "day", "UINT8", "", "", "1~31", ""]);
  mq.row([8, 4, "Daily energy", "dailyEnergy", "UINT32", "x0.01", "kWh", "", ""], { fill: "FFEEEEEE" });
  mq.row([12, 4, "Peak demand", "peakDemand", "UINT32", "1", "W", "", "15-min average"]);
  mq.row([16, 1, "Interval count N", "count", "UINT8", "", "", "0~24", ""]);
  mq.row([17, "3×N", "Hourly intervals", "intervals", "", "", "", "", "Repeated N times (N = count)"], { fill: "FFEEEEEE" });
  mq.row(["+0", 1, "Hour", "hour", "UINT8", "", "h", "0~23", ""]);
  mq.row(["+1", 2, "Energy", "energy", "UINT16", "x0.01", "kWh", "", ""]);
  mq.row(["17+3N", 2, "CRC", "crc", "CRC16", "", "", "", "CRC-16/MODBUS"]);
  mq.row([
    "Example: a1b2c3d4ea070a1eb60300007210000003007d00085e0112db01a89c",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    'Decoded: {"meterId":"a1b2c3d4","date":{"year":2026,"month":10,"day":30},"dailyEnergy":9.5,"peakDemand":4210,"count":3,"intervals":[{"hour":0,"energy":1.25},{"hour":8,"energy":3.5},{"hour":18,"energy":4.75}]}',
  ], { italic: true });

  const cmd = sheet(wb, "Downlink commands");
  cmd.widths([12, 9, 26, 14, 11, 11, 7, 10, 40]);
  cmd.row(["Relay control [relay]"], { bold: true, size: 12 });
  cmd.row(["Topic: voltix/em3/{meterId}/cmd  —  LoRaWAN fPort 10"], { italic: true });
  cmd.row(["Offset", "Bytes", "Parameter", "Tag", "Data type", "Multiplier", "Unit", "Range", "Notes"], { bold: true, fill: "FFFFE082" });
  cmd.row([0, 1, "Command code", "cmd", "UINT8", "", "", "", "fixed 0x20"]);
  cmd.row([1, 1, "Relay state", "state", "UINT8", "", "", "", "0=off;1=on"]);
  cmd.row(["Example: 20 01", "", "", "", "", "", "", "", 'Decoded: {"state":"on"}'], { italic: true });
  return wb;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Acme GT200 — dense protocol doc, one table per message ID, hex-only examples
// ─────────────────────────────────────────────────────────────────────────
export function acme(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ACME Telematics";
  const cover = sheet(wb, "Cover");
  cover.widths([50, 30]);
  cover.title("▲▲ ACME TELEMATICS ▲▲", 2, { size: 22, color: "FFD32F2F" });
  cover.row(["GT200 4G/NB-IoT GPS Tracker — Communication Protocol"], { bold: true, size: 14 });
  cover.blank();
  cover.row(["Product model: GT200"]);
  cover.row(["Manufacturer: Acme"]);
  cover.row(["Protocol version: V2.3"]);
  cover.row(["Transport: MQTT over NB-IoT / LTE-M (TLS)"]);
  cover.row(["This document is the property of ACME Telematics. Do not distribute."], { italic: true, color: "FF757575" });

  const rev = sheet(wb, "Revision");
  rev.widths([8, 12, 14, 60]);
  rev.row(["Ver", "Date", "Author", "Description"], { bold: true, fill: "FFFFCDD2" });
  rev.row(["V2.0", "2024-06-01", "R&D", "New binary frame format"]);
  rev.row(["V2.2", "2025-05-20", "R&D", "HDOP removed from location report"]);
  rev.row(["V2.3", "2026-01-10", "R&D", "Geofence downlink, alarm harsh braking"]);

  const ff = sheet(wb, "Frame format");
  ff.widths([90]);
  ff.row(["Frame = 0xA5 | message type | body | CRC16 (CCITT-FALSE, poly 0x1021, init 0xFFFF) over all preceding bytes."]);
  ff.row(["Byte order: big-endian / network order (MSB first)."]);
  ff.row(["Uplink topic acme/gt200/{IMEI}/up, downlink topic acme/gt200/{IMEI}/down."]);

  const up = sheet(wb, "Uplink", "FFD32F2F");
  up.widths([8, 5, 22, 12, 10, 8, 14, 12, 50]);
  up.title("DEVICE → PLATFORM", 9, { fill: "FFD32F2F", color: "FFFFFFFF" });
  up.row(["Topic: acme/gt200/{IMEI}/up"], { italic: true });
  const H = ["Byte", "Len", "Field", "Variable", "Type", "Unit", "Resolution", "Range", "Description"];
  const head = () => up.row(H, { bold: true, fill: "FFFFEBEE" });
  up.blank();
  up.row(["Message ID 0x01 – Location report [location]"], { bold: true, size: 12 });
  head();
  up.row([0, 1, "Start flag", "magic", "HEX", "", "", "", "Fixed 0xA5"]);
  up.row([1, 1, "Message type", "msgType", "HEX", "", "", "", "Fixed 0x01"]);
  up.row(["2-5", 4, "Latitude", "lat", "I32", "°", "0.0000001", "-90~90", "WGS-84, negative = south"]);
  up.row(["6-9", 4, "Longitude", "lng", "I32", "°", "0.0000001", "-180~180", "negative = west"]);
  up.row(["10-11", 2, "Speed", "speed", "U16", "km/h", "0.1", "0~300", ""]);
  up.row(["12-13", 2, "Heading", "heading", "U16", "°", "1", "0~359", "0 = north"]);
  up.row([14, 1, "HDOP", "hdop", "U8", "", "0.1", "", "removed in V2.2"], { strike: true, color: "FF9E9E9E" });
  up.row([14, 1, "Satellites", "satellites", "U8", "", "", "", "satellites used in fix"]);
  up.row([15, 1, "Status", "flags", "bitfield", "", "", "", "bit7..bit0"], { fill: "FFFFF8E1" });
  up.row(["15.7", "", "Ignition", "ignition", "bit", "", "", "", "1 = ignition on"]);
  up.row(["15.6", "", "Moving", "moving", "bit", "", "", "", "accelerometer"]);
  up.row(["15.5", "", "GPS fix", "gpsFix", "bit", "", "", "", "1 = valid fix"]);
  up.row(["15.4-15.0", "", "Reserved", "", "", "", "", "", "0"]);
  up.row(["16-17", 2, "CRC16", "crc", "U16", "", "", "", "CRC-16/CCITT-FALSE"]);
  up.row(["e.g. A5 01 07 BB 4F 13 2E 3F FD 9B 01 C4 01 0E 09 E0 0E 72"], { italic: true, color: "FF757575" });
  up.blank();
  up.row(["Message ID 0x02 – Heartbeat [heartbeat]"], { bold: true, size: 12 });
  head();
  up.row([0, 1, "Start flag", "magic", "HEX", "", "", "", "Fixed 0xA5"]);
  up.row([1, 1, "Message type", "msgType", "HEX", "", "", "", "Fixed 0x02"]);
  up.row(["2-3", 2, "Battery voltage", "battery", "U16", "mV", "", "3300~4300", ""]);
  up.row([4, 1, "Signal (RSSI)", "signal", "S8", "dBm", "", "-140~-40", ""]);
  up.row(["5-6", 2, "Internal temperature", "temperature", "S16", "°C", "0.1", "", ""]);
  up.row([7, 3, "Firmware version", "firmware", "", "", "", "", "major.minor.patch"], { fill: "FFFFF8E1" });
  up.row(["+0", 1, "Major", "major", "U8", "", "", "", ""]);
  up.row(["+1", 1, "Minor", "minor", "U8", "", "", "", ""]);
  up.row(["+2", 1, "Patch", "patch", "U8", "", "", "", ""]);
  up.row(["10-11", 2, "CRC16", "crc", "U16", "", "", "", "CRC-16/CCITT-FALSE"]);
  up.row(["e.g. A5 02 0F 48 A9 00 EA 02 01 04 F7 CA"], { italic: true, color: "FF757575" });
  up.blank();
  up.row(["Message ID 0x03 – Alarm [alarm]"], { bold: true, size: 12 });
  head();
  up.row([0, 1, "Start flag", "magic", "HEX", "", "", "", "Fixed 0xA5"]);
  up.row([1, 1, "Message type", "msgType", "HEX", "", "", "", "Fixed 0x03"]);
  up.row([2, 1, "Alarm type", "alarmType", "U8", "", "", "", "0x01 - SOS\n0x02 - Tamper\n0x03 - Low battery\n0x04 - Geofence exit\n0x05 - Harsh braking"]);
  up.row(["3-6", 4, "Latitude", "lat", "I32", "°", "0.0000001", "-90~90", ""]);
  up.row(["7-10", 4, "Longitude", "lng", "I32", "°", "0.0000001", "-180~180", ""]);
  up.row(["11-12", 2, "CRC16", "crc", "U16", "", "", "", "CRC-16/CCITT-FALSE"]);
  up.row(["e.g. A5 03 01 1E B2 63 3C FF EC FB D2 B9 C5"], { italic: true, color: "FF757575" });

  const dn = sheet(wb, "Downlink", "FF455A64");
  dn.widths([8, 5, 22, 12, 10, 8, 14, 12, 50]);
  dn.title("PLATFORM → DEVICE (downlink)", 9, { fill: "FF455A64", color: "FFFFFFFF" });
  dn.row(["Topic: acme/gt200/{IMEI}/down"], { italic: true });
  dn.blank();
  const D = ["Byte", "Len", "Field", "Variable", "Type", "Unit", "Resolution", "Range", "Description"];
  dn.row(["Command 0x10 – Set report interval [set_interval]"], { bold: true });
  dn.row(D, { bold: true, fill: "FFECEFF1" });
  dn.row([0, 1, "Start flag", "magic", "HEX", "", "", "", "Fixed 0xA5"]);
  dn.row([1, 1, "Command", "cmd", "HEX", "", "", "", "Fixed 0x10"]);
  dn.row(["2-3", 2, "Interval", "interval", "U16", "s", "", "10~86400", "default 300"]);
  dn.row(["4-5", 2, "CRC16", "crc", "U16", "", "", "", "CRC-16/CCITT-FALSE"]);
  dn.blank();
  dn.row(["Command 0x11 – Reboot [reboot]"], { bold: true });
  dn.row(D, { bold: true, fill: "FFECEFF1" });
  dn.row([0, 1, "Start flag", "magic", "HEX", "", "", "", "Fixed 0xA5"]);
  dn.row([1, 1, "Command", "cmd", "HEX", "", "", "", "Fixed 0x11"]);
  dn.row(["2-3", 2, "CRC16", "crc", "U16", "", "", "", "CRC-16/CCITT-FALSE"]);
  dn.blank();
  dn.row(["Command 0x12 – Set geofence [set_geofence]"], { bold: true });
  dn.row(D, { bold: true, fill: "FFECEFF1" });
  dn.row([0, 1, "Start flag", "magic", "HEX", "", "", "", "Fixed 0xA5"]);
  dn.row([1, 1, "Command", "cmd", "HEX", "", "", "", "Fixed 0x12"]);
  dn.row(["2-5", 4, "Centre latitude", "lat", "I32", "°", "0.0000001", "-90~90", ""]);
  dn.row(["6-9", 4, "Centre longitude", "lng", "I32", "°", "0.0000001", "-180~180", ""]);
  dn.row(["10-11", 2, "Radius", "radius", "U16", "m", "", "", "minimum 50 m"]);
  dn.row(["12-13", 2, "CRC16", "crc", "U16", "", "", "", "CRC-16/CCITT-FALSE"]);
  return wb;
}

export const SAMPLES = {
  "Acme_GT200_Protocol_v2.3.xlsx": acme,
  "Voltix_EM3_Modbus-MQTT_Map.xlsx": voltix,
  "Envio_TH-Sense_Payload_Spec.xlsx": envio,
} as const;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [file, make] of Object.entries(SAMPLES)) {
    const p = path.join(OUT_DIR, file);
    await make().xlsx.writeFile(p);
    console.log(`wrote ${path.relative(process.cwd(), p)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
