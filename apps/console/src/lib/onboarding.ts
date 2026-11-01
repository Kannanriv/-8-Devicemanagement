import type { Device, DeviceModel, Page } from "@hash8/sdk-ts";
import { client } from "./api";

export interface DraftDevice {
  serial: string;
  modelId: string;
  imei?: string;
  iccid?: string;
  name?: string;
  organization?: string;
  branch?: string;
  tags?: string[];
  batchId?: string;
  firmwareVersion?: string;
}

export interface RowCheck {
  line: number;
  draft: DraftDevice;
  errors: string[];
  warnings: string[];
}

export const CSV_HEADER = "serial,imei,iccid,modelId";

export function csvTemplate(models: DeviceModel[]) {
  const m = models[0]?.id ?? "your-model-id";
  return `${CSV_HEADER}\nSN-000001,356938035643809,8944501234567890123,${m}\nSN-000002,,,${m}\n`;
}

/** Luhn checksum (IMEI is 15 digits with a Luhn check digit). */
export function luhnOk(digits: string) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function imeiError(imei: string | undefined): string | null {
  if (!imei) return null;
  if (!/^\d{15}$/.test(imei)) return "IMEI must be 15 digits";
  if (!luhnOk(imei)) return "IMEI check digit is wrong (Luhn)";
  return null;
}

export function iccidError(iccid: string | undefined): string | null {
  if (!iccid) return null;
  if (!/^\d{19,20}$/.test(iccid)) return "ICCID must be 19–20 digits";
  return null;
}

export function serialError(serial: string | undefined): string | null {
  if (!serial) return "Serial is required";
  if (!/^[A-Za-z0-9._:-]{3,64}$/.test(serial)) return "Serial: 3–64 letters, digits, . _ : -";
  return null;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === ";" || c === "\t") {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** Parse CSV text into drafts. Header row optional (defaults to serial,imei,iccid,modelId). */
export function parseCsv(text: string): { line: number; draft: DraftDevice }[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let cols = ["serial", "imei", "iccid", "modelid"];
  let start = 0;
  const firstIdx = lines.findIndex((l) => l.length > 0);
  if (firstIdx >= 0 && /serial/i.test(lines[firstIdx]!)) {
    cols = splitCsvLine(lines[firstIdx]!).map((c) => c.toLowerCase().replace(/[\s_]/g, ""));
    start = firstIdx + 1;
  }
  const at = (cells: string[], name: string) => {
    const i = cols.indexOf(name);
    return i >= 0 ? cells[i] || undefined : undefined;
  };
  const rows: { line: number; draft: DraftDevice }[] = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l) continue;
    const cells = splitCsvLine(l);
    rows.push({
      line: i + 1,
      draft: {
        serial: at(cells, "serial") ?? "",
        imei: at(cells, "imei"),
        iccid: at(cells, "iccid"),
        modelId: at(cells, "modelid") ?? at(cells, "model") ?? "",
        name: at(cells, "name"),
        organization: at(cells, "organization"),
        branch: at(cells, "branch"),
      },
    });
  }
  return rows;
}

/** Look up which serials already exist (exact match), with bounded concurrency. */
export async function findExistingSerials(serials: string[], tenant?: string): Promise<Set<string>> {
  const unique = [...new Set(serials.filter(Boolean))];
  const found = new Set<string>();
  let i = 0;
  const worker = async () => {
    while (i < unique.length) {
      const s = unique[i++]!;
      try {
        const page = await client(tenant).get<Page<Device>>(`/devices?q=${encodeURIComponent(s)}&limit=5`);
        if (page.items.some((d) => d.serial === s || d.udi === s)) found.add(s);
      } catch {
        /* treat as unknown; the server will reject duplicates anyway */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, unique.length) }, worker));
  return found;
}

export function validateRows(rows: { line: number; draft: DraftDevice }[], models: DeviceModel[], existing: Set<string>): RowCheck[] {
  const modelIds = new Set(models.map((m) => m.id));
  const count = new Map<string, number>();
  for (const r of rows) if (r.draft.serial) count.set(r.draft.serial, (count.get(r.draft.serial) ?? 0) + 1);
  return rows.map((r) => {
    const errors: string[] = [];
    const se = serialError(r.draft.serial);
    if (se) errors.push(se);
    else if ((count.get(r.draft.serial) ?? 0) > 1) errors.push("Duplicate serial in this file");
    else if (existing.has(r.draft.serial)) errors.push("Serial already registered");
    if (!r.draft.modelId) errors.push("Model is required");
    else if (!modelIds.has(r.draft.modelId)) errors.push(`Unknown model ${r.draft.modelId}`);
    const ie = imeiError(r.draft.imei);
    if (ie) errors.push(ie);
    const ce = iccidError(r.draft.iccid);
    if (ce) errors.push(ce);
    return { line: r.line, draft: r.draft, errors, warnings: [] };
  });
}

export function toCsv(drafts: DraftDevice[]) {
  const esc = (v?: string) => (v && /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : (v ?? ""));
  return [CSV_HEADER, ...drafts.map((d) => [d.serial, d.imei, d.iccid, d.modelId].map(esc).join(","))].join("\n");
}

/** Serial range for factory batches: prefix + zero-padded counter. */
export function serialRange(prefix: string, start: number, quantity: number, pad: number) {
  return Array.from({ length: quantity }, (_, i) => `${prefix}${String(start + i).padStart(pad, "0")}`);
}
