import type { Device, OtaCampaign, RolloutWave } from "@hash8/sdk-ts";
import { OpsError } from "./errors";
import { compareSemver, parseSemver, satisfiesRange } from "./semver";

export interface WaveSpec {
  name: string;
  /** Cumulative percent of the cohort updated once this wave completes. */
  percent: number;
}

export const DEFAULT_WAVES: WaveSpec[] = [
  { name: "canary", percent: 1 },
  { name: "10%", percent: 10 },
  { name: "50%", percent: 50 },
  { name: "100%", percent: 100 },
];

/** FNV-1a 32-bit. Deterministic, dependency-free, good enough for spreading devices. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface WavePlan {
  waves: RolloutWave[];
  /** deviceId → wave index. Devices beyond the last wave's percent are absent. */
  assignments: Record<string, number>;
}

export function planWaves(deviceIds: string[], waves: WaveSpec[] = DEFAULT_WAVES, seed: string): WavePlan {
  if (!waves.length) throw new OpsError("INVALID_WAVES", "At least one wave is required");
  let prevPct = 0;
  for (const w of waves) {
    if (!(w.percent > 0 && w.percent <= 100) || w.percent < prevPct) {
      throw new OpsError("INVALID_WAVES", `Wave "${w.name}" percent ${w.percent} must be in (0,100] and cumulative (non-decreasing)`);
    }
    prevPct = w.percent;
  }

  const ordered = [...new Set(deviceIds)]
    .map((id) => ({ id, h: fnv1a(`${seed}:${id}`) }))
    .sort((a, b) => a.h - b.h || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = ordered.length;

  const assignments: Record<string, number> = Object.create(null) as Record<string, number>;
  const out: RolloutWave[] = [];
  let prevCum = 0;
  waves.forEach((w, i) => {
    let cum = Math.ceil((n * w.percent) / 100 - 1e-9);
    if (i === 0 && n > 0) cum = Math.max(1, cum);
    cum = Math.min(n, Math.max(prevCum, cum));
    for (let k = prevCum; k < cum; k++) assignments[ordered[k]!.id] = i;
    out.push({ name: w.name, percent: w.percent, status: "pending", targeted: cum - prevCum, succeeded: 0, failed: 0 });
    prevCum = cum;
  });
  return { waves: out, assignments: { ...assignments } };
}

export type WaveDecision = "continue" | "wait" | "pause" | "rollback";

/**
 * Gate a wave. Failure rate is over devices that have reported (succeeded+failed).
 * rollback: rate ≥ 2×max; pause: rate > max or avg health < min; wait: incomplete.
 */
export function evaluateWave(wave: RolloutWave, gate: OtaCampaign["healthGate"], avgHealth: number): WaveDecision {
  const done = wave.succeeded + wave.failed;
  if (done === 0) return wave.targeted > 0 ? "wait" : "continue";
  const rate = wave.failed / done;
  if (wave.failed > 0 && rate >= 2 * gate.maxFailureRate) return "rollback";
  if (rate > gate.maxFailureRate) return "pause";
  if (avgHealth < gate.minHealthScore) return "pause";
  if (done < wave.targeted) return "wait";
  return "continue";
}

export type CampaignEvent =
  | { type: "start" }
  | { type: "pause"; reason?: string }
  | { type: "resume" }
  | { type: "rollback"; reason?: string }
  | { type: "wave_progress"; waveIndex: number; succeeded: number; failed: number; avgHealth?: number }
  | { type: "complete" };

const ALLOWED: Record<CampaignEvent["type"], OtaCampaign["status"][]> = {
  start: ["draft"],
  pause: ["running"],
  resume: ["paused"],
  rollback: ["running", "paused"],
  wave_progress: ["running", "paused"],
  complete: ["running"],
};

/**
 * Pure campaign state machine. `wave_progress` carries absolute counts; when running,
 * the wave is gated with `evaluateWave` (avgHealth defaults to 100) and the campaign
 * advances, completes, pauses or rolls back accordingly. While paused, progress only
 * updates counts.
 */
export function campaignReducer(c: OtaCampaign, event: CampaignEvent, now: Date): OtaCampaign {
  if (!ALLOWED[event.type]?.includes(c.status)) {
    throw new OpsError(
      "INVALID_CAMPAIGN_TRANSITION",
      `Campaign ${c.id} in status ${c.status} cannot accept event ${event.type}`,
      { status: c.status, event: event.type },
    );
  }
  const waves = c.waves.map((w) => ({ ...w }));
  const next: OtaCampaign = { ...c, waves, updatedAt: now.toISOString() };
  const firstPending = () => waves.findIndex((w) => w.status === "pending");
  const markRunning = (status: RolloutWave["status"]) => {
    for (const w of waves) if (w.status === "running") w.status = status;
  };

  switch (event.type) {
    case "start": {
      const i = firstPending();
      if (i === -1) next.status = "completed";
      else {
        waves[i]!.status = "running";
        next.status = "running";
      }
      return next;
    }
    case "pause":
      next.status = "paused";
      return next;
    case "resume":
      next.status = "running";
      if (!waves.some((w) => w.status === "running")) {
        const i = firstPending();
        if (i === -1) next.status = "completed";
        else waves[i]!.status = "running";
      }
      return next;
    case "rollback":
      markRunning("failed");
      next.status = "rolled_back";
      return next;
    case "complete":
      markRunning("passed");
      next.status = "completed";
      return next;
    case "wave_progress": {
      const w = waves[event.waveIndex];
      if (!w || !Number.isInteger(event.waveIndex)) {
        throw new OpsError("INVALID_WAVE", `Campaign ${c.id} has no wave ${event.waveIndex}`);
      }
      w.succeeded = Math.max(0, event.succeeded);
      w.failed = Math.max(0, event.failed);
      if (c.status !== "running" || w.status !== "running") return next;
      const decision = evaluateWave(w, c.healthGate, event.avgHealth ?? 100);
      if (decision === "rollback") {
        w.status = "failed";
        next.status = "rolled_back";
      } else if (decision === "pause") {
        next.status = "paused";
      } else if (decision === "continue") {
        w.status = "passed";
        const i = firstPending();
        if (i === -1) next.status = "completed";
        else waves[i]!.status = "running";
      }
      return next;
    }
  }
}

export interface CheckResult {
  ok: boolean;
  reasons: string[];
}

export function checkCompatibility(
  firmware: { version: string; codecVersion?: string },
  device: { firmwareVersion?: string; codecVersion?: string },
  fromVersions: string[],
): CheckResult {
  const reasons: string[] = [];
  const cur = device.firmwareVersion;
  if (!parseSemver(firmware.version)) reasons.push(`Target firmware version "${firmware.version}" is not valid semver`);

  if (!cur || !parseSemver(cur)) {
    if (fromVersions.length) reasons.push("Device firmware version unknown");
  } else {
    if (fromVersions.length && !fromVersions.some((r) => satisfiesRange(cur, r))) {
      reasons.push(`Device firmware ${cur} is not in allowed source versions (${fromVersions.join(", ")})`);
    }
    if (parseSemver(firmware.version)) {
      const d = compareSemver(cur, firmware.version);
      if (d === 0) reasons.push(`Device already on target firmware ${firmware.version}`);
      else if (d > 0) reasons.push(`Downgrade from ${cur} to ${firmware.version} not allowed`);
    }
  }

  if (firmware.codecVersion) {
    if (!device.codecVersion) reasons.push(`Firmware requires codec ${firmware.codecVersion}; device codec unknown`);
    else if (parseSemver(device.codecVersion)?.major !== parseSemver(firmware.codecVersion)?.major) {
      // Same codec major = wire-compatible per DCS semantics; minor bumps are handled by the platform.
      reasons.push(`Firmware requires codec ${firmware.codecVersion}; device on incompatible codec ${device.codecVersion}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export const PREFLIGHT_MIN_BATTERY = 30;

/** Per-device readiness for an OTA push. Devices without a battery reading are treated as mains-powered. */
export function preflight(device: Device): CheckResult {
  const reasons: string[] = [];
  const battery = device.health?.battery;
  if (battery !== undefined && battery < PREFLIGHT_MIN_BATTERY) {
    reasons.push(`Battery ${Math.round(battery)}% below ${PREFLIGHT_MIN_BATTERY}%`);
  }
  if (device.health?.connectivity !== "online") {
    reasons.push(`Device is ${device.health?.connectivity ?? "unknown"}, must be online`);
  }
  if (device.lifecycle !== "activated") {
    reasons.push(`Lifecycle ${device.lifecycle} not eligible (needs activated)`);
  }
  return { ok: reasons.length === 0, reasons };
}
