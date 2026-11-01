import type { DeviceHealth, HealthLevel } from "@hash8/sdk-ts";

export interface HealthInput {
  lastSeenAt?: string;
  /** Last heartbeat/keep-alive; counts as contact for connectivity. */
  lastHeartbeatAt?: string;
  /** Timestamp of the newest telemetry value → dataFreshnessSec. */
  newestTelemetryAt?: string;
  now: Date;
  expectedIntervalSec: number;
  /** Battery percent 0..100. */
  battery?: number;
  /** Signal strength in dBm (RSSI). */
  signal?: number;
  msgCount1h?: number;
  /** Decode/transport error ratio 0..1. */
  errorRate?: number;
  gps?: DeviceHealth["gps"];
  engineHours?: number;
}

/** Weights sum to 100. Missing optional metrics score full marks (neutral). */
export const HEALTH_WEIGHTS = { connectivity: 35, battery: 20, signal: 15, errorRate: 15, freshness: 15 } as const;

/** Stale once silent for more than 1 interval; offline beyond this many intervals. */
export const OFFLINE_INTERVAL_FACTOR = 3;

/** normal ≥ 70, warning 40–69, critical < 40 — and always critical when offline. */
export const HEALTH_LEVEL_THRESHOLDS = { normal: 70, warning: 40 } as const;

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;

function formatAge(sec: number): string {
  if (sec < 120) return `${Math.round(sec)}s`;
  if (sec < 7200) return `${Math.round(sec / 60)}m`;
  if (sec < 172800) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function parseTs(s: string | undefined): number {
  return s === undefined ? NaN : Date.parse(s);
}

export function healthLevel(score: number, connectivity: DeviceHealth["connectivity"]): HealthLevel {
  if (connectivity === "offline" || score < HEALTH_LEVEL_THRESHOLDS.warning) return "critical";
  return score < HEALTH_LEVEL_THRESHOLDS.normal ? "warning" : "normal";
}

export function computeHealth(i: HealthInput): DeviceHealth {
  const issues: string[] = [];
  const base: DeviceHealth = { score: 0, level: "critical", connectivity: "never_seen", issues };
  if (i.lastSeenAt !== undefined) base.lastSeenAt = i.lastSeenAt;
  if (i.lastHeartbeatAt !== undefined) base.lastHeartbeatAt = i.lastHeartbeatAt;
  if (i.battery !== undefined) base.battery = i.battery;
  if (i.signal !== undefined) base.signal = i.signal;
  if (i.gps !== undefined) base.gps = i.gps;
  if (i.engineHours !== undefined) base.engineHours = i.engineHours;
  if (i.msgCount1h !== undefined) base.msgRatePerHour = i.msgCount1h;

  const nowMs = i.now.getTime();
  const telemetryMs = parseTs(i.newestTelemetryAt);
  const telemetryAgeSec = Number.isNaN(telemetryMs) ? undefined : Math.max(0, Math.round((nowMs - telemetryMs) / 1000));
  if (telemetryAgeSec !== undefined) base.dataFreshnessSec = telemetryAgeSec;

  // contact = most recent of any message or heartbeat
  const contacts = [parseTs(i.lastSeenAt), parseTs(i.lastHeartbeatAt)].filter((x) => !Number.isNaN(x));
  if (!contacts.length) {
    issues.push("Never seen");
    return base;
  }

  const interval = Math.max(1, i.expectedIntervalSec);
  const ageSec = Math.max(0, (nowMs - Math.max(...contacts)) / 1000);
  const offline = ageSec > OFFLINE_INTERVAL_FACTOR * interval;
  const dataAgeSec = Math.max(ageSec, telemetryAgeSec ?? 0);
  base.connectivity = offline ? "offline" : dataAgeSec > interval ? "stale" : "online";

  const w = HEALTH_WEIGHTS;
  // freshness: full within one interval, linear decay to 0 at the offline threshold
  const freshness = clamp01(1 - (dataAgeSec - interval) / ((OFFLINE_INTERVAL_FACTOR - 1) * interval));
  let score = (offline ? 0 : w.connectivity) + freshness * w.freshness;
  if (offline) issues.push(`Offline for ${formatAge(ageSec)} (expected every ${formatAge(interval)})`);
  else if (base.connectivity === "stale") {
    issues.push(ageSec > interval
      ? `Stale: last message ${formatAge(ageSec)} ago (expected every ${formatAge(interval)})`
      : `Stale telemetry: newest value ${formatAge(dataAgeSec)} old (expected every ${formatAge(interval)})`);
  }

  if (i.battery !== undefined) {
    // full marks at >=50%, linear to 0 at 0%
    score += clamp01(i.battery / 50) * w.battery;
    if (i.battery < 10) issues.push(`Critical battery (${Math.round(i.battery)}%)`);
    else if (i.battery < 20) issues.push(`Low battery (${Math.round(i.battery)}%)`);
  } else score += w.battery;

  if (i.signal !== undefined) {
    // full marks at >= -85 dBm, linear to 0 at -120 dBm
    score += clamp01((i.signal + 120) / 35) * w.signal;
    if (i.signal < -110) issues.push(`Weak signal (${Math.round(i.signal)} dBm)`);
  } else score += w.signal;

  if (i.errorRate !== undefined) {
    // 0% -> full marks, >=20% -> 0
    score += clamp01(1 - i.errorRate / 0.2) * w.errorRate;
    if (i.errorRate > 0.05) issues.push(`High error rate (${pct(Math.min(1, i.errorRate))})`);
  } else score += w.errorRate;

  if (base.connectivity === "online" && i.msgCount1h === 0 && interval < 3600) issues.push("No messages in the last hour");

  base.score = Math.round(Math.min(100, Math.max(0, score)));
  base.level = healthLevel(base.score, base.connectivity);
  return base;
}
