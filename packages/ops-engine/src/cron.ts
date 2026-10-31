import { OpsError } from "./errors";

/** 5-field cron (minute hour day-of-month month day-of-week), evaluated in UTC. */
interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] },
  { name: "day-of-week", min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] },
];

interface ParsedCron {
  sets: Set<number>[];
  domStar: boolean;
  dowStar: boolean;
}

const cache = new Map<string, ParsedCron>();

function bad(expr: string, msg: string): OpsError {
  return new OpsError("INVALID_CRON", `Invalid cron "${expr}": ${msg}`);
}

function parseValue(expr: string, f: FieldSpec, s: string): number {
  const up = s.toUpperCase();
  const idx = f.names?.indexOf(up) ?? -1;
  if (idx >= 0) return f.name === "month" ? idx + 1 : idx;
  if (!/^\d+$/.test(s)) throw bad(expr, `bad ${f.name} value '${s}'`);
  const n = Number(s);
  if (n < f.min || n > f.max) throw bad(expr, `${f.name} ${n} out of range ${f.min}-${f.max}`);
  return n;
}

function parseField(expr: string, f: FieldSpec, src: string): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined || !rangePart) throw bad(expr, `bad ${f.name} '${part}'`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) throw bad(expr, `bad step '${stepPart}' in ${f.name}`);
      step = Number(stepPart);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = f.min;
      hi = f.max;
    } else if (rangePart.includes("-")) {
      const [a, b, more] = rangePart.split("-");
      if (more !== undefined || !a || !b) throw bad(expr, `bad range '${rangePart}' in ${f.name}`);
      lo = parseValue(expr, f, a);
      hi = parseValue(expr, f, b);
      if (lo > hi) throw bad(expr, `descending range '${rangePart}' in ${f.name}`);
    } else {
      lo = parseValue(expr, f, rangePart);
      hi = stepPart !== undefined ? f.max : lo; // "5/15" = from 5 every 15
    }
    for (let v = lo; v <= hi; v += step) out.add(f.name === "day-of-week" && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): ParsedCron {
  const hit = cache.get(expr);
  if (hit) return hit;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw bad(expr, `expected 5 fields, got ${parts.length}`);
  const parsed: ParsedCron = {
    sets: parts.map((p, i) => parseField(expr, FIELDS[i]!, p)),
    domStar: parts[2] === "*",
    dowStar: parts[4] === "*",
  };
  if (cache.size > 1000) cache.clear();
  cache.set(expr, parsed);
  return parsed;
}

/** True if `date` (UTC, minute resolution) matches the cron. Classic Vixie semantics: dom OR dow when both are restricted. */
export function cronMatches(expr: string, date: Date): boolean {
  const { sets, domStar, dowStar } = parseCron(expr);
  const [min, hour, dom, mon, dow] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (!min.has(date.getUTCMinutes()) || !hour.has(date.getUTCHours()) || !mon.has(date.getUTCMonth() + 1)) return false;
  const domOk = dom.has(date.getUTCDate());
  const dowOk = dow.has(date.getUTCDay());
  if (domStar || dowStar) return domOk && dowOk;
  return domOk || dowOk;
}
