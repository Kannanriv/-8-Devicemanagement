import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const numberFmt = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const compactFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const pctFmt = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 1 });
const dateTimeFmt = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const timeFmt = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" });

export const fmt = {
  number: (n: number | undefined | null) => (n == null || Number.isNaN(n) ? "—" : numberFmt.format(n)),
  compact: (n: number | undefined | null) => (n == null || Number.isNaN(n) ? "—" : compactFmt.format(n)),
  pct: (ratio: number | undefined | null) => (ratio == null || Number.isNaN(ratio) ? "—" : pctFmt.format(ratio)),
  dateTime: (iso: string | undefined) => (iso ? safeDate(iso, dateTimeFmt) : "—"),
  time: (iso: string | undefined) => (iso ? safeDate(iso, timeFmt) : "—"),
  bytes(n: number | undefined) {
    if (n == null) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  },
  ago(iso: string | undefined) {
    if (!iso) return "never";
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return "—";
    const diff = (t - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 45) return "just now";
    if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
    if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
    return dateTimeFmt.format(new Date(t));
  },
  label(s: string) {
    const t = s.replace(/[_-]+/g, " ").trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  },
};

function safeDate(iso: string, f: Intl.DateTimeFormat) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : f.format(d);
}

/** Split hex into byte pairs, tolerant of whitespace and 0x prefix. */
export function hexBytes(hex: string): string[] {
  const clean = hex.replace(/^0x/i, "").replace(/[^0-9a-f]/gi, "");
  const out: string[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(clean.slice(i, i + 2).toUpperCase());
  return out;
}

export function isValidHex(hex: string) {
  const clean = hex.replace(/^0x/i, "").replace(/[\s:-]/g, "");
  return clean.length > 0 && clean.length % 2 === 0 && /^[0-9a-f]+$/i.test(clean);
}

export function formatValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Flatten nested decoded objects into dot paths (arrays indexed). */
export function flatten(obj: Record<string, unknown>, prefix = "", out: Record<string, unknown> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, out);
    else if (Array.isArray(v) && v.some((x) => x && typeof x === "object")) {
      v.forEach((item, i) => {
        if (item && typeof item === "object") flatten(item as Record<string, unknown>, `${key}[${i}]`, out);
        else out[`${key}[${i}]`] = item;
      });
    } else out[key] = v;
  }
  return out;
}

export function shortId(id: string, n = 8) {
  return id.length > n + 2 ? `${id.slice(0, n)}…` : id;
}
