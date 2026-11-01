/**
 * Cell-level parsers for the messy vocabulary OEMs use in Excel message specs.
 * Every function is pure and tolerant: unknown input => undefined, never throw.
 */
import type { ScalarType } from "@hash8/dcs-schema";

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`;

export function cleanText(v: string | undefined | null): string {
  return (v ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

export function isBlankish(t: string): boolean {
  const s = cleanText(t).toLowerCase();
  return s === "" || s === "-" || s === "—" || s === "–" || s === "n/a" || s === "na" || s === "/" || s === "none" || s === "tbd";
}

/** Scale / resolution / multiplier: "0.1", "x0.01", "×0.1", "1/100", "/10", "÷1000", "0.1 °C". */
export function parseScale(text: string): number | undefined {
  if (isBlankish(text)) return undefined;
  let t = cleanText(text).toLowerCase().replace(/,/g, ".");
  t = t.replace(/^(?:resolution|scale|factor|multiplier|ratio|lsb)\s*[:=]?\s*/, "");
  let m = t.match(new RegExp(`(${NUM})\\s*/\\s*(${NUM})`));
  if (m) return finitePos(Number(m[1]) / Number(m[2]));
  m = t.match(new RegExp(`(?:^|\\s)(?:/|÷)\\s*(${NUM})`));
  if (m) return finitePos(1 / Number(m[1]));
  m = t.match(new RegExp(`(?:x|×|\\*)\\s*(${NUM})`));
  if (m) return finitePos(Number(m[1]));
  m = t.match(new RegExp(`^(${NUM})`));
  if (m) return finitePos(Number(m[1]));
  return undefined;
}

function finitePos(n: number): number | undefined {
  if (!Number.isFinite(n) || n === 0) return undefined;
  return Number(n.toPrecision(12));
}

export interface ParsedType {
  type: ScalarType;
  bits?: number;
  /** Width in bytes for bytes/string/bcd when stated in the type (e.g. "char[8]"). */
  length?: number;
}

/** Data type cell: U8/UINT16/int16_t/S16/WORD/FLOAT32/ASCII/BCD/HEX/signed/unsigned/"Unsigned 16-bit". */
export function parseType(text: string): ParsedType | undefined {
  if (isBlankish(text)) return undefined;
  const raw = cleanText(text).toLowerCase();
  const c = raw.replace(/[\s_-]/g, "");
  let bits: number | undefined;
  const bm = raw.match(/(\d+)\s*-?\s*bits?\b/);
  if (bm) bits = Number(bm[1]);
  const by = raw.match(/(\d+)\s*bytes?\b/);
  if (!bits && by) bits = Number(by[1]) * 8;
  const arr = raw.match(/\[(\d+)\]/);

  let m: RegExpMatchArray | null;
  if ((m = c.match(/^(?:u|uint|unsigned|ui)(8|16|24|32|40|48|64)(?:t|be|le)?$/))) return { type: "uint", bits: Number(m[1]) };
  if ((m = c.match(/^(?:i|s|int|sint|signed)(8|16|24|32|40|48|64)(?:t|be|le)?$/))) return { type: "int", bits: Number(m[1]) };
  if ((m = c.match(/^(?:float|real|f)(32|64)$/))) return { type: "float", bits: Number(m[1]) };
  if (/^(?:float|real|single|ieee754)$/.test(c)) return { type: "float", bits: 32 };
  if (/^double/.test(c)) return { type: "float", bits: 64 };
  if (/^(?:byte|uchar|unsignedchar)$/.test(c)) return { type: "uint", bits: 8 };
  if (/^(?:char|signedchar|schar)$/.test(c)) return { type: "int", bits: 8 };
  if (/^(?:word|ushort|unsignedshort)$/.test(c)) return { type: "uint", bits: 16 };
  if (/^(?:short|signedshort)$/.test(c)) return { type: "int", bits: 16 };
  if (/^(?:dword|ulong|unsignedlong)$/.test(c)) return { type: "uint", bits: 32 };
  if (/^(?:long|signedlong)$/.test(c)) return { type: "int", bits: 32 };
  if (/bcd/.test(c)) return withLen({ type: "bcd" }, arr);
  if (/ascii|string|text|char\[|utf-?8|^str/.test(raw)) return withLen({ type: "string" }, arr);
  if (/^(?:hex|bytes?|raw|binary|bytearray|byte\[\d*\]|blob|octets?)/.test(c)) return withLen({ type: "bytes" }, arr);
  if ((m = c.match(/^(?:crc|checksum|cs)(8|16|32)?$/))) return { type: "uint", ...(m[1] ? { bits: Number(m[1]) } : {}) };
  if (/^(?:bitfield|bitmap|bitmask|flags|statusbits|bits)$/.test(c)) return { type: "uint", ...(bits ? { bits } : {}) };
  if (/^(?:bool|boolean|flag|bit)$/.test(c)) return { type: "bool", ...(bits ? { bits } : {}) };
  if (/float/.test(c)) return { type: "float", bits: bits === 64 ? 64 : 32 };
  if (/unsigned|uint/.test(c)) return { type: "uint", ...(bits ? { bits } : {}) };
  if (/signed|int/.test(c)) return { type: "int", ...(bits ? { bits } : {}) };
  if (/^u$/.test(c)) return { type: "uint" };
  return undefined;
}

function withLen(t: ParsedType, arr: RegExpMatchArray | null): ParsedType {
  return arr ? { ...t, length: Number(arr[1]) } : t;
}

const UNIT_MAP: Record<string, string> = {
  "°c": "Cel", "℃": "Cel", degc: "Cel", "deg c": "Cel", celsius: "Cel", "deg.c": "Cel", "c": "Cel",
  "°f": "[degF]", "℉": "[degF]",
  "%": "%", "%rh": "%", rh: "%", "% rh": "%", percent: "%",
  v: "V", mv: "mV", a: "A", ma: "mA", w: "W", kw: "kW", va: "VA", kva: "kVA", var: "var", kvar: "kvar",
  wh: "W.h", kwh: "kW.h", "kw.h": "kW.h", "kw·h": "kW.h", varh: "var.h", kvarh: "kvar.h", mwh: "MW.h",
  hz: "Hz", s: "s", sec: "s", second: "s", seconds: "s", ms: "ms", min: "min", minute: "min", minutes: "min", h: "h", hour: "h", hours: "h",
  m: "m", km: "km", "km/h": "km/h", kmh: "km/h", kph: "km/h", "m/s": "m/s", mph: "[mi_i]/h",
  "°": "deg", deg: "deg", degree: "deg", degrees: "deg",
  dbm: "dBm", db: "dB", hpa: "hPa", pa: "Pa", kpa: "kPa", bar: "bar", mbar: "mbar",
  ppm: "[ppm]", ppb: "[ppb]", lux: "lx", lx: "lx", g: "g", kg: "kg", l: "L", "m3": "m3", "m³": "m3",
  pf: "1", "": "",
};

export function parseUnit(text: string): string | undefined {
  if (isBlankish(text)) return undefined;
  const t = cleanText(text).replace(/^\[|\]$/g, "").replace(/^\(|\)$/g, "");
  const k = t.toLowerCase();
  if (k in UNIT_MAP) return UNIT_MAP[k] || undefined;
  if (t.length <= 12) return t;
  return undefined;
}

const ENUM_ENTRY = /^\s*(0x[0-9a-f]+|0b[01]+|-?\d+)\s*(?:=|:|-|–|—|→|->|=>)\s*(.+?)\s*$/i;

/** "0=Off;1=On", "0: Off, 1: On", "0x01 - SOS\n0x02 - Low battery". At least two entries. */
export function parseEnum(text: string): Record<string, string> | undefined {
  if (isBlankish(text)) return undefined;
  const parts = text.split(/[;\n|]|,(?=\s*(?:0x[0-9a-f]+|-?\d+)\s*(?:=|:|-|–|—|→|->|=>))/i).map((p) => p.trim()).filter(Boolean);
  const out: Record<string, string> = {};
  let hits = 0;
  for (const p of parts) {
    const m = p.match(ENUM_ENTRY);
    if (!m) continue;
    const key = parseIntLoose(m[1]!);
    if (key === undefined) continue;
    out[String(key)] = m[2]!.replace(/^["']|["']$/g, "");
    hits++;
  }
  if (hits < 2 || hits < parts.length * 0.6) return undefined;
  return out;
}

export function parseIntLoose(s: string): number | undefined {
  const t = s.trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(t)) return parseInt(t.slice(2), 16);
  if (/^0b[01]+$/.test(t)) return parseInt(t.slice(2), 2);
  if (/^[-+]?\d+$/.test(t)) return parseInt(t, 10);
  if (/^[0-9a-f]+h$/.test(t)) return parseInt(t.slice(0, -1), 16);
  return undefined;
}

export function parseNumber(s: string): number | undefined {
  const t = cleanText(s).replace(/,/g, ".");
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(t)) return Number(t);
  return parseIntLoose(t);
}

/** "0~100", "-40 to 85", "-40..85", "-40 ~ +85", "0 - 65535". */
export function parseRange(text: string): { min: number; max: number } | undefined {
  if (isBlankish(text)) return undefined;
  const t = cleanText(text).replace(/,(?=\d{3}\b)/g, "");
  const m = t.match(new RegExp(`(${NUM})\\s*(?:~|to|\\.\\.|–|—|-)\\s*(${NUM})`, "i"));
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return undefined;
  return { min: a, max: b };
}

export interface Position {
  byte: number;
  endByte?: number;
  bitLo?: number;
  bitHi?: number;
}

const INT = String.raw`(0x[0-9a-f]+|\d+)`;

/** Byte offset cell: "0", "3-4", "3~6", "Byte 5", "Byte 5 bit 0-3", "5.4-5.7", "B7 bit 2", "0x0A". */
export function parsePosition(text: string): Position | undefined {
  if (isBlankish(text)) return undefined;
  const t = cleanText(text).toLowerCase();
  let m = t.match(new RegExp(`^(?:byte|b|octet)?\\s*\\[?${INT}\\]?\\s*[,/]?\\s*(?:bits?|b)\\s*\\[?(\\d+)(?:\\s*(?:-|~|\\.\\.|:|to)\\s*(\\d+))?\\]?`));
  if (m) {
    const byte = parseIntLoose(m[1]!)!;
    const a = Number(m[2]);
    const b = m[3] !== undefined ? Number(m[3]) : a;
    return { byte, bitLo: Math.min(a, b), bitHi: Math.max(a, b) };
  }
  m = t.match(/^(\d+)\.(\d)\s*(?:-|~|to)\s*(\d+)\.(\d)$/);
  if (m) {
    const a = Number(m[2]);
    const b = Number(m[4]);
    return { byte: Number(m[1]), bitLo: Math.min(a, b), bitHi: Math.max(a, b) };
  }
  m = t.match(/^(\d+)\.(\d)$/);
  if (m) return { byte: Number(m[1]), bitLo: Number(m[2]), bitHi: Number(m[2]) };
  m = t.match(new RegExp(`^(?:bytes?|b|octets?|pos(?:ition)?)?\\s*${INT}\\s*(?:-|~|–|\\.\\.|to|:)\\s*${INT}$`));
  if (m) {
    const a = parseIntLoose(m[1]!)!;
    const b = parseIntLoose(m[2]!)!;
    return a === b ? { byte: a } : { byte: Math.min(a, b), endByte: Math.max(a, b) };
  }
  m = t.match(new RegExp(`^(?:bytes?|b|octet|pos(?:ition)?|offset)?\\s*\\[?${INT}\\]?$`));
  if (m) return { byte: parseIntLoose(m[1]!)! };
  return undefined;
}

/** Bit cell: "0-3", "bit 7", "4..7", "b6", "7:4". Bit 0 = LSB. */
export function parseBitRange(text: string): { lo: number; hi: number } | undefined {
  if (isBlankish(text)) return undefined;
  const t = cleanText(text).toLowerCase();
  const m = t.match(/^(?:bits?|b)?\s*\[?(\d+)(?:\s*(?:-|~|\.\.|:|to|–)\s*(?:bits?|b)?\s*(\d+))?\]?$/);
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = m[2] !== undefined ? Number(m[2]) : a;
  return { lo: Math.min(a, b), hi: Math.max(a, b) };
}

/** Turn an OEM field label into a DCS identifier (camelCase), keeping identifiers that already look intentional. */
export function toIdentifier(label: string): string {
  const s = cleanText(label).normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/^[a-z_][A-Za-z0-9_]*$/.test(s)) return s;
  const words = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return "field";
  const id = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
  return /^[0-9]/.test(id) ? `_${id}` : id;
}

export interface MessageMarker {
  port?: number;
  messageId?: number;
  direction?: "uplink" | "downlink";
  topic?: string;
  title?: string;
}

/** Message/sheet headers: "Port 2", "fPort: 1", "Message ID 0x01", "Uplink"/"Downlink", "Topic: a/b/+". */
export function detectMessageMarker(text: string): MessageMarker | undefined {
  const t = cleanText(text);
  if (!t || t.length > 160) return undefined;
  const out: MessageMarker = {};
  let rest = t;
  const port = t.match(/\bf?port\s*(?:no\.?|number)?\s*[:#=]?\s*(\d{1,3})\b/i);
  if (port) {
    out.port = Number(port[1]);
    rest = rest.replace(port[0], " ");
  }
  const topic = t.match(/\btopic\s*[:=]?\s*([\w\-/+#{}$.]*\/[\w\-/+#{}$.]*)/i);
  if (topic) {
    out.topic = topic[1]!.replace(/\{[^}]+\}/g, "+");
    rest = rest.replace(topic[0], " ");
  }
  const id = t.match(/\b(?:message|msg|frame|packet|report|cmd|command|event)\s*(?:id|type|code|no\.?)?\s*[:#=]?\s*(0x[0-9a-f]{1,4}|[0-9a-f]{2}h|\d{1,3})\b/i);
  if (id) {
    out.messageId = parseIntLoose(id[1]!);
    rest = rest.replace(id[0], " ");
  }
  if (/\bdownlink\b|\bdl\b|^\s*(?:cmd|command)\b|\bserver\s*(?:->|→|to)\s*device\b/i.test(t)) out.direction = "downlink";
  else if (/\buplink\b|\bul\b|\bdevice\s*(?:->|→|to)\s*server\b/i.test(t)) out.direction = "uplink";
  if (out.port === undefined && out.messageId === undefined && !out.direction && !out.topic) return undefined;
  rest = rest
    .replace(/\b(?:uplink|downlink|mqtt|lorawan|message|payload|frame|format|structure|ul|dl)\b/gi, " ")
    .replace(/[()[\]:–—\-|#=,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (rest && /[a-z]/i.test(rest)) out.title = rest;
  return out;
}

export function detectEndian(text: string): "big" | "little" | undefined {
  const t = cleanText(text).toLowerCase();
  if (/little[\s-]?endian|lsb[\s-]*first|least significant byte first|intel (?:byte )?order|low byte first/.test(t)) return "little";
  if (/big[\s-]?endian|msb[\s-]*first|most significant byte first|network (?:byte )?order|motorola|high byte first/.test(t)) return "big";
  return undefined;
}
