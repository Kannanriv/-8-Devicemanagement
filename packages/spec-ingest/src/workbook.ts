import ExcelJS from "exceljs";
import { cleanText } from "./parse";

/** A worksheet flattened to trimmed text, 0-based rows/cols. Merged slave cells are blank. */
export interface SheetGrid {
  name: string;
  rows: string[][];
  /** Row is struck through (deprecated in many OEM sheets). */
  strike: boolean[];
  /** Row has a solid fill colour (ARGB) on its first non-empty cell. */
  fill: (string | undefined)[];
  merges: string[];
}

export async function loadGrids(data: Uint8Array | ArrayBuffer): Promise<SheetGrid[]> {
  const wb = new ExcelJS.Workbook();
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  // exceljs' typings want a Node Buffer; at runtime any ArrayBuffer view works.
  await wb.xlsx.load(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) as unknown as ArrayBuffer);
  const grids: SheetGrid[] = [];
  wb.eachSheet((ws) => {
    const rows: string[][] = [];
    const strike: boolean[] = [];
    const fill: (string | undefined)[] = [];
    const rowCount = ws.rowCount;
    const colCount = ws.columnCount;
    for (let r = 1; r <= rowCount; r++) {
      const row = ws.getRow(r);
      const cells: string[] = [];
      let struck = false;
      let anyText = false;
      let rowFill: string | undefined;
      for (let c = 1; c <= colCount; c++) {
        const cell = row.getCell(c);
        if (cell.isMerged && cell.master.address !== cell.address) {
          cells.push("");
          continue;
        }
        const text = cellText(cell);
        cells.push(text);
        if (text) {
          if (!anyText) {
            const f = cell.fill;
            if (f && f.type === "pattern" && f.pattern === "solid") rowFill = f.fgColor?.argb;
          }
          anyText = true;
          if (cell.font?.strike) struck = true;
        }
      }
      while (cells.length && cells[cells.length - 1] === "") cells.pop();
      rows.push(cells);
      strike.push(struck);
      fill.push(rowFill);
    }
    grids.push({ name: ws.name, rows, strike, fill, merges: [...(ws.model.merges ?? [])] });
  });
  return grids;
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(Number(v.toPrecision(15)));
  if (typeof v === "string") return cleanMulti(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("richText" in v) return cleanMulti(v.richText.map((t) => t.text).join(""));
    if ("result" in v && v.result !== undefined) {
      const res = v.result;
      if (typeof res === "number") return String(Number(res.toPrecision(15)));
      if (typeof res === "object" && res && "error" in res) return "";
      return cleanMulti(String(res));
    }
    if ("text" in v && typeof v.text === "string") return cleanMulti(v.text);
    if ("error" in v) return "";
  }
  return cleanMulti(cell.text ?? "");
}

/** Keep line breaks (enum lists use them) but trim each line. */
function cleanMulti(s: string): string {
  return s
    .split(/\r?\n/)
    .map((l) => cleanText(l))
    .filter(Boolean)
    .join("\n");
}

export function colLetter(c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function addr(r: number, c: number): string {
  return `${colLetter(c)}${r + 1}`;
}

/** Compact, cell-addressed rendering of a workbook for LLM prompts. */
export function gridsToText(grids: SheetGrid[], maxCell = 160): string {
  const out: string[] = [];
  for (const g of grids) {
    out.push(`## Sheet: ${g.name}`);
    if (g.merges.length) out.push(`(merged ${g.merges.join(", ")})`);
    g.rows.forEach((row, r) => {
      const parts: string[] = [];
      row.forEach((t, c) => {
        if (!t) return;
        const one = t.replace(/\n/g, " ⏎ ");
        parts.push(`${addr(r, c)}: ${one.length > maxCell ? one.slice(0, maxCell) + "…" : one}`);
      });
      if (parts.length) out.push((g.strike[r] ? "~~ " : "") + parts.join(" | "));
    });
    out.push("");
  }
  return out.join("\n");
}
