import type { Device, DeviceQuery } from "@hash8/sdk-ts";
import type { AgentDef } from "../types";
import { numericLeaves } from "../util";

export interface Anomaly {
  deviceId: string;
  field: string;
  at: string;
  value: number;
  expected: number;
  ewmaZ: number;
  globalZ: number;
  severity: "warning" | "critical";
}

export interface DetectOptions {
  alpha?: number;
  threshold?: number;
  warmup?: number;
}

/**
 * EWMA mean/variance detector confirmed by a global z-score over the preceding history.
 * Points flagged as anomalous do not update the baseline.
 */
export function detectSeries(values: number[], opts: DetectOptions = {}): { index: number; expected: number; ewmaZ: number; globalZ: number }[] {
  const alpha = opts.alpha ?? 0.3;
  const thr = opts.threshold ?? 4;
  const warmup = opts.warmup ?? 8;
  const out: { index: number; expected: number; ewmaZ: number; globalZ: number }[] = [];
  if (values.length <= warmup) return out;
  let mean = values[0]!;
  let variance = 0;
  let n = 1;
  let sum = values[0]!;
  let sumSq = values[0]! ** 2;
  for (let i = 1; i < values.length; i++) {
    const x = values[i]!;
    const floor = 1e-3 * Math.max(1, Math.abs(mean));
    const ez = (x - mean) / Math.max(Math.sqrt(variance), floor);
    const gMean = sum / n;
    const gStd = Math.sqrt(Math.max(0, sumSq / n - gMean ** 2));
    const gz = (x - gMean) / Math.max(gStd, floor);
    if (i >= warmup && Math.abs(ez) > thr && Math.abs(gz) > 3) {
      out.push({ index: i, expected: Number(mean.toFixed(4)), ewmaZ: Number(ez.toFixed(2)), globalZ: Number(gz.toFixed(2)) });
      continue;
    }
    const diff = x - mean;
    mean += alpha * diff;
    variance = (1 - alpha) * (variance + alpha * diff * diff);
    n++;
    sum += x;
    sumSq += x * x;
  }
  return out;
}

export const anomalySentinel: AgentDef = {
  name: "anomaly-sentinel",
  title: "Anomaly Sentinel",
  description:
    "Scans recent decoded numeric telemetry per device with an EWMA baseline confirmed by z-score, and raises alerts for fresh anomalies (spikes, drops, step changes).",
  async run(input, ctx) {
    const limit = typeof input.limit === "number" ? input.limit : 100;
    const recent = typeof input.recent === "number" ? input.recent : 5;
    const threshold = typeof input.threshold === "number" ? input.threshold : 4;
    const createAlerts = input.createAlerts !== false;
    let devices: Device[];
    if (Array.isArray(input.deviceIds)) {
      devices = (await Promise.all((input.deviceIds as string[]).map((id) => ctx.tools.getDevice(id)))).filter((d): d is Device => !!d);
    } else devices = (await ctx.tools.queryDevices({ limit: 200, ...((input.query as DeviceQuery) ?? {}) })).items;
    ctx.step(`scanning ${devices.length} device(s), last ${limit} messages each`);

    const anomalies: Anomaly[] = [];
    let series = 0;
    for (const d of devices) {
      const msgs = (await ctx.tools.getMessages(d.id, limit)).filter((m) => m.status === "decoded" && m.data).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
      const fields = new Map<string, { at: string; v: number }[]>();
      for (const m of msgs) for (const [k, v] of Object.entries(numericLeaves(m.data))) fields.set(k, [...(fields.get(k) ?? []), { at: m.receivedAt, v }]);
      for (const [field, pts] of fields) {
        series++;
        const hits = detectSeries(pts.map((p) => p.v), { threshold });
        const fresh = hits.filter((h) => h.index >= pts.length - recent);
        if (!fresh.length) continue;
        const worst = fresh.reduce((a, b) => (Math.abs(b.ewmaZ) > Math.abs(a.ewmaZ) ? b : a));
        anomalies.push({
          deviceId: d.id,
          field,
          at: pts[worst.index]!.at,
          value: pts[worst.index]!.v,
          expected: worst.expected,
          ewmaZ: worst.ewmaZ,
          globalZ: worst.globalZ,
          severity: Math.abs(worst.ewmaZ) > 2 * threshold ? "critical" : "warning",
        });
      }
    }
    ctx.step(`analysed ${series} series; ${anomalies.length} fresh anomal${anomalies.length === 1 ? "y" : "ies"}`);

    const alerts: string[] = [];
    if (createAlerts) {
      for (const a of anomalies) {
        const al = await ctx.tools.createAlert({
          severity: a.severity,
          category: "abnormal_telemetry",
          title: `Anomalous ${a.field} on ${a.deviceId}`,
          detail: `${a.field} = ${a.value} at ${a.at}; baseline ≈ ${a.expected} (EWMA z ${a.ewmaZ}, z-score ${a.globalZ})`,
          deviceId: a.deviceId,
          source: "agent:anomaly-sentinel",
        });
        alerts.push(al.id);
      }
      if (alerts.length) ctx.step(`created ${alerts.length} alert(s)`);
    }

    let summary = anomalies.length
      ? anomalies.map((a) => `${a.deviceId}.${a.field}=${a.value} (baseline ${a.expected})`).join("; ")
      : "No fresh anomalies.";
    if (ctx.llm && anomalies.length) {
      try {
        const r = await ctx.llm.complete({
          tier: "fast",
          maxTokens: 600,
          system: "Explain detected IoT telemetry anomalies to an operations engineer in 2-3 sentences, with likely causes to check. Do not invent numbers.",
          messages: [{ role: "user", content: JSON.stringify(anomalies.slice(0, 20)) }],
        });
        if (r.text.trim()) summary = r.text.trim();
      } catch {
        /* deterministic summary stays */
      }
    }
    return { output: { anomalies, alerts, devicesScanned: devices.length, seriesAnalysed: series, summary } };
  },
};
