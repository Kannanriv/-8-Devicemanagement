/** Heuristics that pull device vitals out of arbitrary decoded payloads. */

const BATTERY_KEY = /^(batt|battery)([_-]?(level|pct|percent|soc|v|volt|voltage|mv))?$|^battery[A-Z]\w*$|^soc$/i;
const SIGNAL_KEY = /^(rssi|signal|signal_?dbm|signalStrength|csq|rsrp|snr_?rssi)$/i;

function walk(o: Record<string, unknown>, fn: (k: string, v: unknown) => void, depth = 0) {
  if (depth > 3) return;
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object" && !Array.isArray(v)) walk(v as Record<string, unknown>, fn, depth + 1);
    else fn(k, v);
  }
}

export function extractVitals(data: Record<string, unknown>): { battery?: number; signal?: number } {
  const out: { battery?: number; signal?: number } = {};
  walk(data, (k, v) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return;
    if (out.battery === undefined && BATTERY_KEY.test(k)) {
      const key = k.toLowerCase();
      if (key.endsWith("mv") || (v > 100 && v <= 5000)) out.battery = voltsToPct(v / 1000);
      else if (/(v|volt|voltage)$/.test(key) || v <= 5) out.battery = voltsToPct(v);
      else out.battery = Math.max(0, Math.min(100, v));
    } else if (out.signal === undefined && SIGNAL_KEY.test(k)) {
      out.signal = k.toLowerCase() === "csq" ? -113 + 2 * v : v;
    }
  });
  return out;
}

/** Linear map: Li-ion 3.0–4.2 V; 2-cell alkaline/lithium primary 2.2–3.1 V when below 3.15 V nominal range. */
function voltsToPct(v: number): number {
  const [lo, hi] = v < 3.15 && v > 2.0 ? [2.2, 3.1] : [3.0, 4.2];
  return Math.round(Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100)));
}

export function flattenData(data: Record<string, unknown>, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(data)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flattenData(v as Record<string, unknown>, key, out);
    else out[key] = v;
  }
  return out;
}

const INTERVALS: Record<string, number> = { tracker: 300, "energy-meter": 900, environment: 600, "environment-sensor": 600 };
export function expectedIntervalSec(category: string | undefined): number {
  return (category && INTERVALS[category]) || 900;
}
