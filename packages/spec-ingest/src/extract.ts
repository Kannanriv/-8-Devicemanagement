import type {
  ChecksumField,
  ConstField,
  DeviceCodecSpecInput,
  Field,
  MessageDef,
  ScalarField,
  ScalarType,
  SourceRef,
  TestVector,
} from "@hash8/dcs-schema";
import { detectHeader, type ColumnMap } from "./headers";
import {
  cleanText,
  detectEndian,
  detectMessageMarker,
  isBlankish,
  parseBitRange,
  parseEnum,
  parseIntLoose,
  parseNumber,
  parsePosition,
  parseRange,
  parseScale,
  parseType,
  parseUnit,
  toIdentifier,
  type MessageMarker,
  type ParsedType,
  type Position,
} from "./parse";
import { addr, loadGrids, type SheetGrid } from "./workbook";

export interface SheetSummary {
  name: string;
  rows: number;
  tables: number;
  role: "cover" | "revisions" | "messages" | "registers" | "notes" | "other";
  messages: string[];
}

/** An example payload found in the sheet that could not be turned into a full test vector. */
export interface ExamplePayload {
  message: string;
  direction: "uplink" | "downlink";
  hex: string;
  port?: number;
  topic?: string;
  source: SourceRef;
}

export interface ExtractedSpec {
  draft: DeviceCodecSpecInput;
  /** key = "<message>.<fieldPath>" */
  trace: Record<string, SourceRef>;
  issues: string[];
  /** 0..1, mean field confidence discounted by open issues. */
  confidence: number;
  sheets: SheetSummary[];
  /** Example payloads without full expected values (codec-verifier can use them). */
  examples: ExamplePayload[];
}

export interface ExtractOptions {
  fileName?: string;
  vendor?: string;
  model?: string;
}

type Endian = "big" | "little";
type MsgFieldInput = MessageDef["fields"][number];

interface TableLoc {
  header: number;
  cols: ColumnMap;
  start: number;
  end: number; // exclusive
  regionStart: number;
  regionEnd: number; // exclusive
}

interface RowField {
  r: number;
  label: string;
  id: string;
  pos?: Position;
  lenBytes?: number;
  bitWidth?: number;
  bitPos?: { lo: number; hi: number };
  ptype?: ParsedType;
  unit?: string;
  scale?: number;
  voffset?: number;
  min?: number;
  max?: number;
  enum?: Record<string, string>;
  desc?: string;
  example?: string;
  def?: string;
  endian?: Endian;
  constValue?: number;
  checksum?: ChecksumField["algo"] | "unknown";
  /** Position is relative to the parent container ("+2"). */
  rel?: boolean;
  /** Position given as an expression after a variable-length part ("5+3N"). */
  variablePos?: boolean;
  conf: number;
  text: string;
}

interface Unit {
  start: number; // bit position (MSB-first cursor)
  width?: number;
  rf: RowField;
}

const ID_LIKE = /\b(message|msg|frame|packet|report|event|cmd|command|payload)\s*(id|type|code)\b|^(header|start|sync|magic|preamble|start ?(byte|flag|bit)s?|protocol ?(id|version)|frame ?id|type)$/i;
const CHECKSUM_LIKE = /\b(checksum|crc(?:-?\d+)?|xor|bcc|lrc|check ?sum)\b/i;

export async function extractFromWorkbook(data: Uint8Array | ArrayBuffer, opts: ExtractOptions = {}): Promise<ExtractedSpec> {
  const grids = await loadGrids(data);
  return extractFromGrids(grids, opts);
}

export function extractFromGrids(grids: SheetGrid[], opts: ExtractOptions = {}): ExtractedSpec {
  const issues: string[] = [];
  const trace: Record<string, SourceRef> = {};
  const examples: ExamplePayload[] = [];
  const sheets: SheetSummary[] = [];
  const uplink: MessageDef[] = [];
  const downlink: MessageDef[] = [];
  const vectors: TestVector[] = [];
  const confs: number[] = [];
  const usedNames = new Set<string>();
  const file = opts.fileName;

  const allText = grids.flatMap((g) => g.rows.map((r) => r.join(" "))).join("\n");
  const defaultEndian = workbookEndian(grids);

  for (const g of grids) {
    const found = findTables(g);
    const registerMaps = found.filter((t) => t.cols.register !== undefined && t.cols.pos === undefined);
    for (const t of registerMaps)
      issues.push(`${g.name}!${addr(t.header, t.cols.register!)}: Modbus register map (${t.end - t.start} rows, no payload byte offsets) — not a payload layout, skipped; map registers to payload offsets if this device sends raw register dumps`);
    const tables = found.filter((t) => !registerMaps.includes(t));
    const sheetMarker = detectMessageMarker(g.name);
    const summary: SheetSummary = { name: g.name, rows: g.rows.length, tables: tables.length, role: registerMaps.length && !tables.length ? "registers" : sheetRole(g, tables.length), messages: [] };
    sheets.push(summary);
    tables.forEach((t, ti) => {
      const ctxLines = contextLines(g, t);
      const marker = mergeMarkers(ctxLines.map((l) => detectMessageMarker(l.text)), sheetMarker);
      const keyLine = [...ctxLines.map((l) => l.text), g.name].map((l) => l.match(/\[([A-Za-z_][A-Za-z0-9_]*)\]|`([A-Za-z_][A-Za-z0-9_]*)`|\b(?:message (?:key|name)|msg key)\s*[:=]\s*([A-Za-z_][A-Za-z0-9_]*)/i)).find(Boolean);
      const explicitName = keyLine ? (keyLine[1] ?? keyLine[2] ?? keyLine[3]) : undefined;
      const strip = (x?: string) => x?.replace(/\[[^\]]*\]|`[^`]*`/g, "").replace(/\b(?:message (?:key|name)|msg key)\s*[:=]\s*\w+/i, "").replace(/\s+/g, " ").trim() || undefined;
      const titleLine = strip(marker.title ?? plainTitle(ctxLines) ?? (sheetMarker ? sheetMarker.title : undefined));
      const direction = marker.direction ?? "uplink";
      let name = explicitName ?? (titleLine ? toIdentifier(titleLine) : marker.port !== undefined ? `port${marker.port}` : `${direction}${ti + 1}`);
      if (/^reserved/.test(name) || name === "field") name = `${direction}${ti + 1}`;
      name = unique(name, usedNames);
      summary.messages.push(name);
      const tableEndian = ctxLines.map((l) => detectEndian(l.text)).find(Boolean);

      const built = buildMessage(g, t, {
        name,
        file,
        marker,
        defaultEndian,
        tableEndian: tableEndian && tableEndian !== defaultEndian ? tableEndian : undefined,
        issues,
      });
      const when: MessageDef["when"] = {};
      if (marker.port !== undefined) when.port = marker.port;
      if (marker.topic) when.topic = marker.topic;
      const msg: MessageDef = {
        name,
        ...(titleLine ? { description: titleLine } : {}),
        ...(Object.keys(when).length ? { when } : {}),
        fields: built.fields as MessageDef["fields"],
        source: { ...(file ? { file } : {}), sheet: g.name, cell: addr(t.header, 0), row: t.header + 1, text: titleLine ?? g.name },
      };
      (direction === "downlink" ? downlink : uplink).push(msg);
      Object.assign(trace, built.trace);
      confs.push(...built.confs);

      // example payloads in this table's region
      for (const ex of findExamples(g, t)) {
        const values = built.exampleData;
        const source: SourceRef = { ...(file ? { file } : {}), sheet: g.name, cell: ex.cell, row: ex.row + 1, text: ex.text };
        if (ex.data || values) {
          vectors.push({
            name: `${name} example (${g.name}!${ex.cell})`,
            direction,
            ...(marker.port !== undefined ? { port: marker.port } : {}),
            ...(marker.topic ? { topic: marker.topic.replace(/[+#]/g, "dev1") } : {}),
            hex: ex.hex,
            message: name,
            data: (ex.data ?? values)!,
          });
        } else {
          examples.push({ message: name, direction, hex: ex.hex, ...(marker.port !== undefined ? { port: marker.port } : {}), ...(marker.topic ? { topic: marker.topic } : {}), source });
          issues.push(`${name}: example payload ${ex.hex} at ${g.name}!${ex.cell} has no expected values — kept as an unverified example`);
        }
      }
    });
  }

  if (uplink.length === 0 && downlink.length === 0) issues.push("No field table found in workbook (need a header row with a field-name column and a byte/length/type column)");

  const info = deviceInfo(grids, opts, allText);
  const draft: DeviceCodecSpecInput = {
    dcs: "1.0",
    id: `${slug(info.vendor)}.${slug(info.model)}`,
    version: info.version,
    device: {
      vendor: info.vendor,
      model: info.model,
      ...(info.protocols.length ? { protocols: info.protocols } : {}),
      ...(info.category ? { category: info.category } : {}),
    },
    defaults: { endian: defaultEndian },
    uplink: uplink.length ? uplink : [{ name: "unknown", fields: [] }],
    ...(downlink.length ? { downlink } : {}),
    vectors,
    meta: {
      createdBy: "spec-ingest",
      ...(file ? { sourceDocument: file } : {}),
      ...(info.changelog.length ? { changelog: info.changelog } : {}),
    },
  };

  const mean = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
  const confidence = round3(mean * (1 - Math.min(0.3, 0.02 * issues.length)));
  return { draft, trace, issues, confidence, sheets, examples };
}

// ── table discovery ────────────────────────────────────────────────────────

function findTables(g: SheetGrid): TableLoc[] {
  const tables: TableLoc[] = [];
  let r = 0;
  while (r < g.rows.length) {
    const row = g.rows[r]!;
    const cols = nonEmpty(row) >= 2 ? detectHeader(row) : undefined;
    if (!cols) {
      r++;
      continue;
    }
    let end = r + 1;
    while (end < g.rows.length) {
      const row2 = g.rows[end]!;
      const n = nonEmpty(row2);
      if (n === 0) break;
      if (n >= 2 && detectHeader(row2)) break;
      if (n === 1 && detectMessageMarker(row2.find(Boolean)!)) break;
      end++;
    }
    tables.push({ header: r, cols, start: r + 1, end, regionStart: 0, regionEnd: g.rows.length });
    r = end;
  }
  tables.forEach((t, i) => {
    t.regionStart = i === 0 ? 0 : tables[i - 1]!.end;
    t.regionEnd = i + 1 < tables.length ? contextStart(g, tables[i + 1]!, t.end) : g.rows.length;
  });
  return tables;
}

/** First row of the title/notes block that belongs to the table starting at `t.header`. */
function contextStart(g: SheetGrid, t: TableLoc, floor: number): number {
  let r = t.header - 1;
  while (r >= floor) {
    const row = g.rows[r]!;
    if (nonEmpty(row) === 0) {
      r--;
      continue;
    }
    if (isExampleRow(row)) break;
    if (detectMessageMarker(row.join(" "))) return r;
    r--;
  }
  return t.header;
}

function contextLines(g: SheetGrid, t: TableLoc): { r: number; text: string }[] {
  const out: { r: number; text: string }[] = [];
  for (let r = t.header - 1; r >= t.regionStart; r--) {
    const row = g.rows[r]!;
    if (!nonEmpty(row) || isExampleRow(row)) continue;
    out.push({ r, text: row.filter(Boolean).join(" ") });
  }
  return out; // nearest first
}

function mergeMarkers(found: (MessageMarker | undefined)[], sheet?: MessageMarker): MessageMarker {
  const m: MessageMarker = {};
  for (const f of [...found, sheet]) {
    if (!f) continue;
    if (m.port === undefined && f.port !== undefined) m.port = f.port;
    if (m.messageId === undefined && f.messageId !== undefined) m.messageId = f.messageId;
    if (!m.direction && f.direction) m.direction = f.direction;
    if (!m.topic && f.topic) m.topic = f.topic;
    if (!m.title && f.title && f !== sheet) m.title = f.title;
  }
  return m;
}

function plainTitle(lines: { text: string }[]): string | undefined {
  for (const l of lines) {
    const t = cleanText(l.text);
    if (/^(note|nb|remark|important|\*|all |byte order|endian)/i.test(t) || detectEndian(t)) continue;
    if (t.length > 70) continue;
    return t.replace(/^\d+(\.\d+)*\s*[.)]?\s*/, "");
  }
  return undefined;
}

// ── field building ─────────────────────────────────────────────────────────

interface BuildCtx {
  name: string;
  file?: string;
  marker: MessageMarker;
  defaultEndian: Endian;
  tableEndian?: Endian;
  issues: string[];
}

function cell(row: string[], c: number | undefined): string {
  return c === undefined ? "" : (row[c] ?? "");
}

function parseRow(g: SheetGrid, r: number, cols: ColumnMap, ctx: BuildCtx): RowField | undefined {
  const row = g.rows[r]!;
  const key = cleanText(cell(row, cols.key));
  const label = cleanText(cell(row, cols.name)) || key;
  if (!label || isBlankish(label)) return undefined;
  const text = row.filter(Boolean).join(" | ").replace(/\n/g, " ").slice(0, 240);
  const rf: RowField = { r, label, id: "", conf: 0.95, text };
  const notes: string[] = [];
  const where = `${g.name}!${addr(r, cols.name ?? 0)}`;

  // name
  const keyId = key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : undefined;
  rf.id = keyId ?? toIdentifier(label.replace(/\(.*?\)/g, " ").trim() || label);
  if (!keyId && /[^A-Za-z0-9 _-]/.test(label.replace(/\(.*?\)/g, ""))) rf.conf -= 0.05;

  // position
  let posTxt = cleanText(cell(row, cols.pos));
  if (/^\+\s*\d/.test(posTxt)) {
    rf.rel = true;
    posTxt = posTxt.replace(/^\+\s*/, "");
  }
  if (posTxt && !isBlankish(posTxt)) {
    rf.pos = parsePosition(posTxt);
    if (!rf.pos) {
      if (/\d\s*[+*×]\s*\d*\s*n\b|\bn\b|variable|var\.?$|after|end/i.test(posTxt)) rf.variablePos = true;
      else notes.push(`${where}: could not parse byte position "${posTxt}"`);
    } else if (rf.pos.bitLo !== undefined) rf.bitPos = { lo: rf.pos.bitLo, hi: rf.pos.bitHi! };
  }
  // length
  const lenTxt = cleanText(cell(row, cols.length));
  if (lenTxt && !isBlankish(lenTxt)) {
    const bitsM = lenTxt.match(/^(\d+)\s*bits?$/i);
    const n = lenTxt.match(/^(\d+)/);
    if (/[×*x]\s*n\b|\bn\s*[×*x]|\bn\b|variable|remaining|rest/i.test(lenTxt)) rf.lenBytes = undefined;
    else if (bitsM) rf.bitWidth = Number(bitsM[1]);
    else if (n) rf.lenBytes = Number(n[1]);
    else if (/variable|n|var|remaining|rest/i.test(lenTxt)) rf.lenBytes = undefined;
  }
  if (rf.pos?.endByte !== undefined && rf.lenBytes === undefined) rf.lenBytes = rf.pos.endByte - rf.pos.byte + 1;
  else if (rf.pos?.endByte !== undefined && rf.lenBytes !== undefined && rf.lenBytes !== rf.pos.endByte - rf.pos.byte + 1) {
    notes.push(`${where}: byte range ${posTxt} disagrees with length ${rf.lenBytes}`);
    rf.conf -= 0.15;
  }
  // bits columns
  for (const role of ["bitpos", "bits", "bitlen"] as const) {
    const t = cleanText(cell(row, cols[role]));
    if (!t || isBlankish(t)) continue;
    const br = parseBitRange(t);
    if (!br) continue;
    const isRange = br.lo !== br.hi || /bit|b\d/i.test(t);
    if (role === "bitlen" || (role === "bits" && !isRange)) rf.bitWidth = br.hi;
    else rf.bitPos = br;
  }
  // type
  const typeTxt = cleanText(cell(row, cols.type));
  if (typeTxt) {
    rf.ptype = parseType(typeTxt);
    if (!rf.ptype && !isBlankish(typeTxt)) {
      notes.push(`${where}: unrecognised data type "${typeTxt}"`);
      rf.conf -= 0.2;
    }
  }
  // semantics
  const scaleTxt = cell(row, cols.scale);
  if (scaleTxt && !isBlankish(scaleTxt)) {
    rf.scale = parseScale(scaleTxt);
    if (rf.scale === undefined) {
      notes.push(`${where}: could not parse scale "${scaleTxt}"`);
      rf.conf -= 0.15;
    }
    const unitInScale = scaleTxt.replace(/^[^a-z°℃%]*/i, "").trim();
    if (unitInScale && cols.unit === undefined) rf.unit = parseUnit(unitInScale);
  }
  const unitTxt = cell(row, cols.unit);
  if (unitTxt && !isBlankish(unitTxt)) rf.unit = parseUnit(unitTxt);
  if (!rf.unit) {
    const paren = label.match(/\(([^)]{1,8})\)\s*$/);
    const u = paren ? parseUnit(paren[1]!) : undefined;
    if (u && u !== paren?.[1] ) rf.unit = u;
    else if (paren && ["%", "V", "mV", "A", "W", "Hz", "s", "m", "dBm"].includes(paren[1]!)) rf.unit = paren[1];
  }
  const vo = cell(row, cols.voffset);
  if (vo && !isBlankish(vo)) {
    const n = parseNumber(vo.replace(/^[^-+\d.]*/, ""));
    if (n !== undefined && n !== 0) rf.voffset = n;
  }
  const rng = parseRange(cell(row, cols.range));
  if (rng) Object.assign(rf, rng);
  const mn = parseNumber(cell(row, cols.min));
  const mx = parseNumber(cell(row, cols.max));
  if (mn !== undefined) rf.min = mn;
  if (mx !== undefined) rf.max = mx;
  const desc = cell(row, cols.desc);
  if (desc) rf.desc = desc.replace(/\n/g, "; ");
  const vals = cell(row, cols.values);
  rf.enum = parseEnum(vals) ?? parseEnum(desc);
  if (vals && !rf.enum && !isBlankish(vals) && cols.desc === undefined) rf.desc = vals;
  if (rf.scale === undefined && desc) {
    const m = desc.match(/(?:resolution|scale|factor|multipl\w*|unit(?: is)?)\s*[:=]?\s*((?:x|×)?\s*\d[\d./]*)|(?:divide[sd]? by|\/|÷)\s*(\d+)|(?:x|×)\s*(0\.\d+)/i);
    if (m) {
      rf.scale = m[2] ? 1 / Number(m[2]) : parseScale(m[1] ?? m[3] ?? "");
      if (rf.scale !== undefined) {
        rf.conf -= 0.15;
        notes.push(`${where}: scale ${rf.scale} inferred from description "${desc.slice(0, 60)}"`);
      }
    }
  }
  if (rf.min === undefined && desc) {
    const m = desc.match(/^(?:range\s*[:=]?\s*)?([-+]?\d+(?:\.\d+)?\s*(?:~|to|\.\.|–|-)\s*[-+]?\d+(?:\.\d+)?)\s*[a-z%°]*\s*$/i);
    if (m) Object.assign(rf, parseRange(m[1]!) ?? {});
  }
  const ex = cell(row, cols.example);
  if (ex && !isBlankish(ex)) rf.example = ex;
  const df = cell(row, cols.default);
  if (df && !isBlankish(df)) rf.def = df;
  const en = cell(row, cols.endian);
  if (en) rf.endian = detectEndian(en) ?? (/^le$|^l$/i.test(en) ? "little" : /^be$|^b$/i.test(en) ? "big" : undefined);

  // fixed markers
  const fixedTxt = [desc, vals, df].join(" ");
  const fixed = fixedTxt.match(/\b(?:fixed|always|constant|const|must be)\b\s*(?:value|to|as|=|:)?\s*(?:value)?\s*[:=]?\s*(0x[0-9a-f]+|[0-9a-f]+h|\d+)/i);
  if (fixed) rf.constValue = parseIntLoose(fixed[1]!);
  else if (ID_LIKE.test(label) && ctx.marker.messageId !== undefined && (rf.pos?.byte ?? 0) === 0) {
    rf.constValue = ctx.marker.messageId;
    rf.conf -= 0.05;
  }
  if (CHECKSUM_LIKE.test(label) || (rf.ptype === undefined && CHECKSUM_LIKE.test(typeTxt))) {
    const t = `${label} ${typeTxt} ${desc}`.toLowerCase();
    rf.checksum = /modbus/.test(t)
      ? "crc16-modbus"
      : /crc-?32/.test(t)
        ? "crc32"
        : /crc-?16|ccitt|x\.?25|kermit/.test(t)
          ? "crc16-ccitt"
          : /crc-?8/.test(t)
            ? "crc8"
            : /xor|bcc|lrc/.test(t)
              ? "xor8"
              : /\bsum\b|checksum|add/.test(t)
                ? "sum8"
                : /crc/.test(t)
                  ? "unknown"
                  : "unknown";
  }
  if (g.strike[r]) {
    ctx.issues.push(`${where}: row "${label}" is struck through — treated as deprecated and skipped`);
    return undefined;
  }
  for (const n of notes) ctx.issues.push(`${ctx.name}: ${n}`);
  return rf;
}

interface Built {
  fields: Field[];
  trace: Record<string, SourceRef>;
  confs: number[];
  exampleData?: Record<string, unknown>;
}

interface Node {
  rf: RowField;
  kind: "scalar" | "group" | "bitgroup" | "repeat";
  count?: number | { ref: string } | "remaining";
  children: Node[];
}

const REPEAT_WORDS = /\brepeat(?:ed|s)?\b|\bfor each\b|\b\d+\s*(?:times|×|x)\b|\b(?:times|×)\s*\d+\b|until (?:the )?end|remaining bytes|rest of (?:the )?payload/i;

/** Group rows into a tree: a row followed by "+n" rows (or bit-only rows) becomes a container. */
function buildTree(rows: RowField[], ctx: BuildCtx): Node[] {
  const out: Node[] = [];
  let i = 0;
  while (i < rows.length) {
    const rf = rows[i]!;
    const children: RowField[] = [];
    let j = i + 1;
    const isBitOnly = (x: RowField) => !!x.bitPos && !x.pos && !x.rel;
    // bit rows under a byte row: "bit 7" (no byte) or "15.7" (same byte as the parent)
    const isBitChild = (x: RowField) => !!x.bitPos && !x.rel && (!x.pos || (!!rf.pos && !rf.bitPos && x.pos.byte === rf.pos.byte));
    if (!rf.rel && !isBitOnly(rf) && !rf.bitPos) {
      if (rows[j]?.rel) while (j < rows.length && rows[j]!.rel) children.push(rows[j++]!);
      else if (rows[j] && isBitChild(rows[j]!)) while (j < rows.length && isBitChild(rows[j]!)) children.push(rows[j++]!);
    }
    if (!children.length) {
      out.push({ rf, kind: "scalar", children: [] });
      i++;
      continue;
    }
    const text = `${rf.label} ${rf.desc ?? ""}`;
    const bitKids = children.every((c) => !!c.bitPos && !c.rel);
    if (!bitKids && REPEAT_WORDS.test(text)) {
      let count: Node["count"];
      const ref = text.match(/\bn\s*=\s*([A-Za-z_][\w.]*)|count (?:is )?(?:given )?(?:by|in|from)\s+(?:field\s+)?["“]?([A-Za-z_][\w.]*)|times given by\s+["“]?([A-Za-z_][\w.]*)/i);
      const num = text.match(/\b(\d+)\s*(?:times|×|x)\b|\b(?:times|×)\s*(\d+)\b|\brepeated\s+(\d+)\b/i);
      if (/until (?:the )?end|remaining|rest of (?:the )?payload/i.test(text)) count = "remaining";
      else if (ref) count = { ref: (ref[1] ?? ref[2] ?? ref[3])! };
      else if (num) count = Number(num[1] ?? num[2] ?? num[3]);
      else {
        const prev = out.slice().reverse().find((n) => n.kind === "scalar" && /^(n|count|num|number|cnt)\w*$/i.test(n.rf.id));
        if (prev) count = { ref: prev.rf.id };
        else {
          count = "remaining";
          ctx.issues.push(`${ctx.name}.${rf.id}: repeated block without a stated count — assumed it repeats until the end of the payload`);
          rf.conf -= 0.2;
        }
      }
      out.push({ rf, kind: "repeat", count, children: buildTree(children, ctx) });
    } else out.push({ rf, kind: bitKids ? "bitgroup" : "group", children: buildTree(children, ctx) });
    i = j;
  }
  return out;
}

interface Placed {
  node: Node;
  start: number;
  width?: number;
  assumed?: boolean;
}

interface LayoutResult {
  fields: Field[];
  extent?: number; // bits; undefined when variable
  example: Record<string, unknown>;
  exampleComplete: boolean;
  exampleAny: boolean;
}

function buildMessage(g: SheetGrid, t: TableLoc, ctx: BuildCtx): Built {
  const rows: RowField[] = [];
  for (let r = t.start; r < t.end; r++) {
    const rf = parseRow(g, r, t.cols, ctx);
    if (rf) rows.push(rf);
  }
  const trace: Record<string, SourceRef> = {};
  const confs: number[] = [];
  const src = (rf: RowField, conf: number): SourceRef => ({
    ...(ctx.file ? { file: ctx.file } : {}),
    sheet: g.name,
    cell: addr(rf.r, t.cols.name ?? 0),
    row: rf.r + 1,
    text: rf.text,
    confidence: round3(conf),
  });
  const tree = buildTree(rows, ctx);
  const res = layout(tree, "", undefined, true);
  return { fields: res.fields, trace, confs, ...(res.exampleAny && res.exampleComplete ? { exampleData: res.example } : {}) };

  /** Width of a node in bits, laying out container children to measure them. */
  function measure(n: Node, path: string): { width?: number; inner?: LayoutResult } {
    const rf = n.rf;
    if (n.kind === "scalar") return { width: rf.bitPos ? rf.bitPos.hi - rf.bitPos.lo + 1 : byteWidth(rf) };
    if (n.kind === "bitgroup") {
      const maxHi = Math.max(...n.children.map((c) => c.rf.bitPos!.hi));
      const width = rf.lenBytes !== undefined ? rf.lenBytes * 8 : rf.ptype?.bits ?? Math.ceil((maxHi + 1) / 8) * 8;
      return { width, inner: layout(n.children, path, width, false, true) };
    }
    const inner = layout(n.children, path, n.kind === "group" && rf.lenBytes !== undefined ? rf.lenBytes * 8 : undefined, false);
    if (n.kind === "group") return { width: rf.lenBytes !== undefined ? rf.lenBytes * 8 : inner.extent, inner };
    return { width: typeof n.count === "number" && inner.extent !== undefined ? n.count * inner.extent : undefined, inner };
  }

  function layout(nodes: Node[], prefix: string, containerBits: number | undefined, top: boolean, bitChildren = false): LayoutResult {
    const used = new Set<string>();
    const fields: Field[] = [];
    const example: Record<string, unknown> = {};
    let exampleComplete = true;
    let exampleAny = false;
    const anyPos = nodes.some((n) => n.rf.pos || n.rf.bitPos);
    const measured = new Map<Node, { width?: number; inner?: LayoutResult }>();
    for (const n of nodes) measured.set(n, measure(n, prefix ? `${prefix}.${n.rf.id}` : n.rf.id));

    // place on an MSB-first bit axis (relative to this container)
    const placed: Placed[] = [];
    let seq = 0;
    let variableFrom = -1;
    nodes.forEach((n, idx) => {
      const rf = n.rf;
      const m = measured.get(n)!;
      let p: Placed;
      if (variableFrom >= 0) p = { node: n, start: NaN, ...(m.width !== undefined ? { width: m.width } : {}) };
      else if (rf.bitPos && containerBits !== undefined && (bitChildren || !rf.pos)) {
        p = { node: n, start: containerBits - 1 - rf.bitPos.hi, width: m.width! };
      } else if (rf.pos && rf.bitPos) {
        const containerBytes = Math.max(1, Math.ceil((rf.bitPos.hi + 1) / 8));
        p = { node: n, start: rf.pos.byte * 8 + (containerBytes * 8 - 1 - rf.bitPos.hi), width: m.width! };
        if (containerBytes > 1 && (rf.endian ?? ctx.tableEndian ?? ctx.defaultEndian) === "little") {
          ctx.issues.push(`${ctx.name}.${rf.id}: bit field spans ${containerBytes} bytes in a little-endian payload — bit numbering assumed big-endian, please confirm`);
          rf.conf -= 0.2;
        }
      } else if (rf.pos) p = { node: n, start: rf.pos.byte * 8, ...(m.width !== undefined ? { width: m.width } : {}) };
      else {
        p = { node: n, start: seq, ...(m.width !== undefined ? { width: m.width } : {}), assumed: anyPos && !rf.variablePos };
        if (p.assumed) {
          rf.conf -= 0.15;
          ctx.issues.push(`${ctx.name}.${rf.id}: no byte position given — assumed to follow the previous field`);
        }
      }
      placed.push(p);
      if (Number.isFinite(p.start)) {
        if (p.width !== undefined) seq = Math.max(seq, p.start + p.width);
        else if (n.kind !== "scalar" || ["bytes", "string", "bcd"].includes(rf.ptype?.type ?? "")) variableFrom = idx;
      }
    });
    const fixed = placed.filter((p) => Number.isFinite(p.start)).sort((a, b) => a.start - b.start || placed.indexOf(a) - placed.indexOf(b));
    const tail = placed.filter((p) => !Number.isFinite(p.start));
    // the variable node must be the last of the fixed part
    if (variableFrom >= 0) {
      const v = placed[variableFrom]!;
      const after = fixed.filter((p) => p !== v && p.start > v.start);
      for (const a of after) {
        fixed.splice(fixed.indexOf(a), 1);
        tail.unshift(a);
      }
    }
    // widths still missing: distance to next node
    fixed.forEach((p, i) => {
      if (p.width !== undefined || p.node.kind === "repeat") return;
      const next = fixed[i + 1];
      const rf = p.node.rf;
      if (next) {
        p.width = next.start - p.start;
        rf.conf -= 0.15;
        ctx.issues.push(`${ctx.name}.${rf.id}: width not stated — inferred ${p.width / 8} byte(s) from the next field's position`);
      } else if (["bytes", "string", "bcd"].includes(rf.ptype?.type ?? "") && top && !tail.length) {
        /* remaining */
      } else if (containerBits !== undefined && p.node.kind === "scalar") {
        p.width = containerBits - p.start;
      } else {
        p.width = 8;
        rf.conf -= 0.25;
        ctx.issues.push(`${ctx.name}.${rf.id}: width not stated — assumed 1 byte`);
      }
    });

    let cursor = 0;
    const gap = (to: number, before: string, nextRf?: RowField) => {
      const bits = to - cursor;
      const byte = Math.floor(cursor / 8);
      const bit = cursor % 8;
      const gname = unique(bit === 0 ? `reserved${byte}` : `reserved${byte}_${7 - bit}`, used);
      const gf: ScalarField =
        bits <= 64 || bits % 8 !== 0 || bit !== 0
          ? { kind: "scalar", name: gname, type: "uint", bits: Math.min(bits, 64), hidden: true, description: "Undocumented gap (inserted by spec-ingest)" }
          : { kind: "scalar", name: gname, type: "bytes", length: bits / 8, hidden: true, description: "Undocumented gap (inserted by spec-ingest)" };
      fields.push(gf);
      if (nextRf) {
        const ref = src(nextRf, 0.5);
        ref.text = `gap ${before} (${bits} bits)`;
        trace[`${ctx.name}.${prefix ? `${prefix}.` : ""}${gname}`] = ref;
      }
      ctx.issues.push(`${ctx.name}${prefix ? `.${prefix}` : ""}: gap at byte ${byte}${bit ? ` bit ${7 - bit}` : ""} (${bits} bits) ${before} is not described — inserted hidden reserved field "${gname}"`);
      cursor = to;
    };
    const emit = (p: Placed, isLast: boolean) => {
      const n = p.node;
      const rf = n.rf;
      const path = prefix ? `${prefix}.${rf.id}` : rf.id;
      let f: Field;
      if (n.kind === "scalar") f = toField({ start: p.start, ...(p.width !== undefined ? { width: p.width } : {}), rf }, isLast && top, ctx);
      else {
        const inner = measured.get(n)!.inner!;
        const base = { name: rf.id, ...(rf.desc || rf.label !== rf.id ? { description: rf.desc ?? rf.label } : {}) };
        if (n.kind === "repeat") f = { kind: "repeat", ...base, count: n.count!, fields: inner.fields };
        else f = { kind: "group", ...base, fields: inner.fields };
        if (n.kind !== "repeat") {
          if (inner.exampleAny) {
            example[rf.id] = inner.example;
            exampleAny = true;
          }
          if (!inner.exampleComplete) exampleComplete = false;
        } else exampleComplete = false;
      }
      f.name = unique(f.name, used);
      const conf = clamp(rf.conf);
      (f as { source?: SourceRef }).source = src(rf, conf);
      fields.push(f);
      trace[`${ctx.name}.${prefix ? `${prefix}.` : ""}${f.name}`] = src(rf, conf);
      confs.push(conf);
      if (f.kind === "scalar" && !f.hidden) {
        const v = exampleValue(rf.example, f);
        if (v === undefined) exampleComplete = false;
        else {
          example[f.name] = v;
          exampleAny = true;
        }
      }
      void path;
    };

    const total = fixed.length + tail.length;
    fixed.forEach((p, i) => {
      if (p.start < cursor) {
        ctx.issues.push(`${ctx.name}.${p.node.rf.id}: overlaps the previous field at bit ${p.start} (cursor ${cursor}) — skipped`);
        return;
      }
      if (p.start > cursor) gap(p.start, `before "${p.node.rf.label}"`, p.node.rf);
      emit(p, i === total - 1);
      cursor = p.width === undefined ? Infinity : p.start + p.width;
    });
    if (containerBits !== undefined && Number.isFinite(cursor) && cursor < containerBits && !tail.length) gap(containerBits, "at the end of the block");
    tail.forEach((p, i) => emit(p, fixed.length + i === total - 1));
    return { fields, extent: tail.length || !Number.isFinite(cursor) ? undefined : Math.max(cursor, containerBits ?? 0), example, exampleComplete, exampleAny };
  }
}

function byteWidth(rf: RowField): number | undefined {
  if (rf.bitWidth !== undefined) return rf.bitWidth;
  if (rf.lenBytes !== undefined) return rf.lenBytes * 8;
  if (rf.ptype?.bits) return rf.ptype.bits;
  if (rf.ptype?.length) return rf.ptype.length * 8;
  if (rf.ptype?.type === "bool") return 8;
  return undefined;
}

function toField(u: Unit, isLast: boolean, ctx: BuildCtx): Field {
  const rf = u.rf;
  const width = u.width;
  const base = { name: rf.id, ...(rf.desc || rf.label !== rf.id ? { description: rf.desc ?? rf.label } : {}) };
  const endian = rf.endian ?? ctx.tableEndian;
  const endianProp = endian && endian !== ctx.defaultEndian && width !== undefined && width > 8 && width % 8 === 0 ? { endian } : endian && rf.endian && width && width > 8 ? {} : {};

  if (rf.checksum && rf.checksum !== "unknown" && isLast) {
    const cf: ChecksumField = { kind: "checksum", ...base, algo: rf.checksum, ...endianProp };
    const expectBits = { crc8: 8, xor8: 8, sum8: 8, "crc16-ccitt": 16, "crc16-modbus": 16, crc32: 32 }[rf.checksum];
    if (width !== undefined && width !== expectBits) {
      ctx.issues.push(`${ctx.name}.${rf.id}: checksum ${rf.checksum} is ${expectBits} bits but the sheet gives ${width}`);
      rf.conf -= 0.2;
    }
    if (/crc/.test(rf.checksum) && !/crc-?\d|modbus|ccitt/i.test(rf.text)) {
      ctx.issues.push(`${ctx.name}.${rf.id}: CRC variant not stated — assumed ${rf.checksum}; ask the OEM for polynomial/init`);
      rf.conf -= 0.2;
    }
    return cf;
  }
  if (rf.checksum) {
    ctx.issues.push(`${ctx.name}.${rf.id}: looks like a checksum but the algorithm is unknown or it is not the last field — modelled as a plain integer`);
    rf.conf -= 0.25;
  }
  if (rf.constValue !== undefined && width !== undefined && width <= 64) {
    const c: ConstField = { kind: "const", ...base, type: "uint", bits: width, value: rf.constValue, ...endianProp };
    return c;
  }

  let type: ScalarType;
  let pt = rf.ptype;
  if (!pt) {
    if (width === 1) type = "bool";
    else if (width !== undefined && width > 64) type = "bytes";
    else if (rf.min !== undefined && rf.min < 0) type = "int";
    else type = "uint";
    if (width !== undefined && width % 8 === 0 && !(u.rf.bitPos)) {
      rf.conf -= 0.2;
      ctx.issues.push(`${ctx.name}.${rf.id}: data type not stated — assumed ${type}`);
    } else rf.conf -= 0.05;
  } else {
    type = pt.type;
    if ((type === "bytes" && width !== undefined && width <= 32 && (rf.enum || rf.scale !== undefined)) ) type = "uint";
    if ((type === "uint" || type === "int") && width !== undefined && width > 64) {
      ctx.issues.push(`${ctx.name}.${rf.id}: ${width}-bit integer is too wide — modelled as bytes`);
      type = "bytes";
    }
    if (type === "float" && width !== 32 && width !== 64) {
      ctx.issues.push(`${ctx.name}.${rf.id}: float of ${width} bits is not IEEE-754 — modelled as uint`);
      rf.conf -= 0.3;
      type = "uint";
    }
    if (pt.bits && width !== undefined && pt.bits !== width && (type === "uint" || type === "int" || type === "float") && !u.rf.bitPos) {
      ctx.issues.push(`${ctx.name}.${rf.id}: type says ${pt.bits} bits but the sheet's size is ${width} bits — using ${width}`);
      rf.conf -= 0.15;
    }
  }

  const sem: Partial<ScalarField> = {};
  if (type !== "bool" && type !== "bytes" && type !== "string" && type !== "bcd") {
    if (rf.enum) sem.enum = rf.enum;
    if (rf.scale !== undefined && rf.scale !== 1) sem.scale = rf.scale;
    if (rf.voffset !== undefined) sem.offset = rf.voffset;
    if (rf.unit) sem.unit = rf.unit;
    if (rf.min !== undefined) sem.min = rf.min;
    if (rf.max !== undefined) sem.max = rf.max;
  }
  if (rf.def !== undefined) {
    const n = parseNumber(rf.def);
    sem.default = n ?? rf.def;
  }
  const f: ScalarField = { kind: "scalar", ...base, type, ...sem };
  if (/^(reserved|rfu|spare|padding|pad|unused|not used)\b/i.test(rf.label) || /^(reserved|rfu|spare|padding|unused)\d*$/i.test(rf.id)) f.hidden = true;
  if (type === "bytes" || type === "string" || type === "bcd") {
    if (width === undefined) {
      if (isLast) f.length = "remaining";
      else {
        f.length = 1;
        ctx.issues.push(`${ctx.name}.${rf.id}: variable-length field is not last — assumed 1 byte`);
      }
    } else f.length = Math.ceil(width / 8);
  } else {
    f.bits = width ?? (type === "bool" ? 1 : 8);
    Object.assign(f, endianProp);
  }
  if (rf.unit && !/^[A-Za-z%.[\]0-9/]+$/.test(rf.unit)) rf.conf -= 0.05;
  return f;
}

function exampleValue(txt: string | undefined, f: ScalarField): unknown {
  if (txt === undefined) return undefined;
  const t = cleanText(txt);
  if (f.enum) {
    const label = Object.values(f.enum).find((l) => l.toLowerCase() === t.toLowerCase());
    if (label) return label;
    const n = parseNumber(t);
    if (n !== undefined) return f.enum[String(n)] ?? n;
    return undefined;
  }
  if (f.type === "bool") {
    if (/^(true|1|yes|on|y)$/i.test(t)) return true;
    if (/^(false|0|no|off|n)$/i.test(t)) return false;
    return undefined;
  }
  if (f.type === "bytes") return t.replace(/^0x/i, "").replace(/[\s:-]/g, "").toLowerCase();
  if (f.type === "string" || f.type === "bcd") return t;
  const m = t.replace(/,/g, ".").match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i);
  return m ? Number(m[0]) : undefined;
}

// ── examples ──────────────────────────────────────────────────────────────

const EXAMPLE_WORD = /\b(?:example|sample|test vector|raw payload)\b|(?:^|\s)e\.g\./i;

function isExampleRow(row: string[]): boolean {
  return row.some((c) => EXAMPLE_WORD.test(c)) && row.some((c) => findHex(c) !== undefined);
}

function findHex(text: string): string | undefined {
  const after = text.includes(":") ? text.slice(text.indexOf(":") + 1) : text;
  const re = /(?:0x)?[0-9a-f]{2}(?:[\s:,-]?(?:0x)?[0-9a-f]{2}){1,}/gi;
  let best: string | undefined;
  for (const m of after.matchAll(re)) {
    const hex = m[0].replace(/0x/gi, "").replace(/[^0-9a-f]/gi, "").toLowerCase();
    if (hex.length % 2 === 0 && (!best || hex.length > best.length)) best = hex;
  }
  return best;
}

function findExamples(g: SheetGrid, t: TableLoc): { hex: string; row: number; cell: string; text: string; data?: Record<string, unknown> }[] {
  const out: { hex: string; row: number; cell: string; text: string; data?: Record<string, unknown> }[] = [];
  for (let r = t.regionStart; r < t.regionEnd; r++) {
    if (r >= t.start && r < t.end && cell(g.rows[r]!, t.cols.name)) continue; // data row
    const row = g.rows[r]!;
    if (!isExampleRow(row)) continue;
    let hex: string | undefined;
    let col = 0;
    row.forEach((c, i) => {
      if (hex) return;
      if (EXAMPLE_WORD.test(c)) {
        hex = findHex(c) ?? (row[i + 1] ? findHex(row[i + 1]!) : undefined);
        col = findHex(c) ? i : i + 1;
      }
    });
    if (!hex) continue;
    let data: Record<string, unknown> | undefined;
    for (const c of row) {
      const s = c.slice(c.indexOf("{"));
      if (c.includes("{") && s.trim().endsWith("}")) {
        try {
          const j = JSON.parse(s);
          if (j && typeof j === "object" && !Array.isArray(j)) data = j as Record<string, unknown>;
        } catch {
          /* not JSON */
        }
      }
    }
    out.push({ hex, row: r, cell: addr(r, col), text: row.filter(Boolean).join(" | ").slice(0, 240), ...(data ? { data } : {}) });
  }
  return out;
}

// ── workbook-level info ───────────────────────────────────────────────────

function workbookEndian(grids: SheetGrid[]): Endian {
  let little = 0;
  let big = 0;
  for (const g of grids)
    for (const row of g.rows)
      for (const c of row) {
        if (c.length > 300) continue;
        const e = detectEndian(c);
        if (e === "little") little++;
        else if (e === "big") big++;
      }
  return little > big ? "little" : "big";
}

function sheetRole(g: SheetGrid, tables: number): SheetSummary["role"] {
  const n = g.name.toLowerCase();
  if (/revision|history|change ?log|versions?$/.test(n)) return "revisions";
  if (tables > 0) return "messages";
  if (/cover|title|front|intro|about/.test(n)) return "cover";
  if (/note|readme|general|info|glossary|overview/.test(n)) return "notes";
  return g.rows.length <= 25 && grids0(g) ? "cover" : "other";
}

function grids0(g: SheetGrid): boolean {
  return g.rows.slice(0, 5).some((r) => r.some((c) => /protocol|specification|spec|manual|document|payload|interface/i.test(c)));
}

interface Info {
  vendor: string;
  model: string;
  version: string;
  protocols: NonNullable<DeviceCodecSpecInput["device"]["protocols"]>;
  category?: string;
  changelog: string[];
}

function deviceInfo(grids: SheetGrid[], opts: ExtractOptions, allText: string): Info {
  let vendor = opts.vendor;
  let model = opts.model;
  let docVersion: string | undefined;
  const labelled = (re: RegExp): string | undefined => {
    for (const g of grids)
      for (const row of g.rows.slice(0, 40))
        for (let i = 0; i < row.length; i++) {
          const c = row[i]!;
          const m = c.match(re);
          if (!m) continue;
          const inline = c.slice(m[0].length).replace(/^\s*[:=-]?\s*/, "").trim();
          const val = inline || (row.slice(i + 1).find(Boolean) ?? "");
          if (val && val.length < 40) return val.split("\n")[0]!.trim();
        }
    return undefined;
  };
  vendor ??= labelled(/^(manufacturer|vendor|company|oem|brand|made by)\b/i);
  model ??= labelled(/^(model|product( model| name)?|device( model)?|part (no\.?|number)|type designation)\b/i);
  const fm = (opts.fileName ?? "").replace(/\.[a-z0-9]+$/i, "").split(/[_\s]+/).filter(Boolean);
  if (!vendor && fm.length >= 2) vendor = fm[0];
  if (!model && fm.length >= 2) model = fm[1];
  const fv = (opts.fileName ?? "").match(/v(\d+)[._](\d+)(?:[._](\d+))?/i);
  if (fv) docVersion = `${fv[1]}.${fv[2]}.${fv[3] ?? 0}`;
  if (!docVersion) {
    const lv = labelled(/^(doc(ument)? ?)?(version|revision|rev\.?|ver\.?)\b/i);
    const m = lv?.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (m) docVersion = `${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}`;
  }
  const protocols = new Set<Info["protocols"][number]>();
  const low = allText.toLowerCase();
  if (/lorawan|fport/.test(low)) protocols.add("lorawan");
  if (/\bmqtt\b/.test(low)) protocols.add("mqtt");
  if (/\btcp\b/.test(low)) protocols.add("tcp");
  if (/\budp\b/.test(low)) protocols.add("udp");
  if (/nb-?iot/.test(low)) protocols.add("nbiot");
  if (/\bcoap\b/.test(low)) protocols.add("coap");
  if (/lwm2m/.test(low)) protocols.add("lwm2m");
  if (/sigfox/.test(low)) protocols.add("sigfox");
  if (/\bhttps?\b/.test(low) && !/https?:\/\//.test(low)) protocols.add("http");
  const category = /gps|gnss|tracker|latitude/.test(low)
    ? "tracker"
    : /kwh|energy|meter|voltage.*phase|phase/.test(low)
      ? "energy-meter"
      : /humidity|temperature/.test(low)
        ? "environment"
        : undefined;
  const changelog: string[] = [];
  for (const g of grids) {
    if (!/revision|history|change ?log/i.test(g.name)) continue;
    for (const row of g.rows.slice(1)) {
      const t = row.filter(Boolean).join(" — ").replace(/\n/g, " ");
      if (t && !detectHeader(row) && changelog.length < 12) changelog.push(t.slice(0, 160));
    }
  }
  return {
    vendor: vendor || "Unknown",
    model: model || "Device",
    version: `${docVersion ?? "0.1.0"}-draft`,
    protocols: [...protocols],
    ...(category ? { category } : {}),
    changelog,
  };
}

// ── utils ────────────────────────────────────────────────────────────────

function nonEmpty(row: string[]): number {
  let n = 0;
  for (const c of row) if (c) n++;
  return n;
}

function unique(name: string, used: Set<string>): string {
  let n = name;
  let i = 2;
  while (used.has(n)) n = `${name}${i++}`;
  used.add(n);
  return n;
}

function slug(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x"
  );
}

function clamp(n: number): number {
  return Math.max(0.05, Math.min(1, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export type { MsgFieldInput };
