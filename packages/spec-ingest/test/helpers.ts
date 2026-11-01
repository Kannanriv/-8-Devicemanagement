import ExcelJS from "exceljs";

export interface SheetDef {
  name: string;
  rows: (string | number | null | undefined)[][];
  merges?: string[];
}

export async function makeWorkbook(sheets: SheetDef[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    s.rows.forEach((r, i) => {
      r.forEach((v, j) => {
        if (v !== null && v !== undefined && v !== "") ws.getCell(i + 1, j + 1).value = v;
      });
    });
    for (const m of s.merges ?? []) ws.mergeCells(m);
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
