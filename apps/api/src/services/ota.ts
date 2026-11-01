import type { Device, DeviceQuery, OtaCampaign } from "@hash8/sdk-ts";
import { campaignReducer, checkCompatibility, DEFAULT_WAVES, OpsError, planWaves, preflight, type CampaignEvent, type WaveSpec } from "@hash8/ops-engine";
import type { Core } from "../context";
import type { AlertService } from "./alerts";
import type { IntegrationService } from "./integrations";
import type { FirmwareRow } from "../db/repos";
import { ApiError, badRequest, notFound } from "../errors";
import { newId } from "../util/ids";

export interface NewCampaign {
  name: string;
  firmwareId: string;
  fromVersions?: string[];
  cohort?: DeviceQuery;
  healthGate?: OtaCampaign["healthGate"];
  waves?: WaveSpec[];
  /** Explicit device list (bulk start_ota); otherwise the cohort query selects devices. */
  deviceIds?: string[];
}

const DEFAULT_GATE = { maxFailureRate: 0.1, minHealthScore: 60 };
const MAX_DEFERRALS = 6;

/**
 * OTA campaigns: plan deterministic waves over the eligible cohort, then (in dev) a
 * ticker simulates device install results, feeds them to `campaignReducer` and enforces
 * the health gate — auto-pausing or rolling back with an alert + audit entry.
 */
export class OtaService {
  private deferrals = new Map<string, number>();
  /** Probability a simulated install fails (dev). Tests may set it. */
  simFailureRate = 0.02;
  rand: () => number = Math.random;

  constructor(
    private core: Core,
    private deps: { alerts: AlertService; integrations: IntegrationService },
  ) {}

  async create(tenantId: string, scope: string[], input: NewCampaign, actor: string): Promise<OtaCampaign> {
    // Firmware is published by the OEM; operators of that model may roll it out.
    const fw = await this.core.repos.firmware.get(input.firmwareId);
    const visible = fw && (scope.includes(fw.tenantId) || (await this.core.repos.devices.ids(scope, { modelId: fw.modelId, limit: 1 })).length > 0);
    if (!fw || !visible) throw notFound("firmware", input.firmwareId);
    const cohort: DeviceQuery = { ...(input.cohort ?? {}), modelId: input.cohort?.modelId ?? fw.modelId };
    delete cohort.limit;
    delete cohort.cursor;
    const ids = input.deviceIds ?? (await this.core.repos.devices.ids(scope, cohort));
    const devices = await this.core.repos.devices.getMany(ids);
    const fromVersions = input.fromVersions ?? [];
    const eligible = devices.filter((d) => checkCompatibility(fw, d, fromVersions).ok);
    let plan;
    try {
      plan = planWaves(eligible.map((d) => d.id), input.waves ?? DEFAULT_WAVES, `${input.name}:${fw.id}`);
    } catch (err) {
      if (err instanceof OpsError) throw new ApiError(400, err.code, err.message);
      throw err;
    }
    const now = this.core.now().toISOString();
    const c: OtaCampaign = {
      id: newId("ota"),
      tenantId,
      name: input.name,
      firmwareId: fw.id,
      fromVersions,
      cohort,
      status: "draft",
      waves: plan.waves,
      healthGate: input.healthGate ?? DEFAULT_GATE,
      createdAt: now,
      updatedAt: now,
    };
    await this.core.repos.campaigns.insert(c);
    const byId = new Map(eligible.map((d) => [d.id, d]));
    await this.core.repos.campaignDevices.insertMany(
      Object.entries(plan.assignments).map(([deviceId, wave]) => ({ campaignId: c.id, deviceId, wave, status: "pending" as const, ...(byId.get(deviceId)?.firmwareVersion ? { fromVersion: byId.get(deviceId)!.firmwareVersion! } : {}) })),
    );
    await this.core.audit(tenantId, actor, "ota.campaign.create", `campaign:${c.id}`, { firmwareId: fw.id, version: fw.version, eligible: eligible.length, skipped: devices.length - eligible.length });
    return c;
  }

  async get(id: string, scope: string[]) {
    const c = await this.core.repos.campaigns.getScoped(id, scope);
    if (!c) throw notFound("campaign", id);
    return c;
  }

  private async apply(c: OtaCampaign, event: CampaignEvent, actor: string, reason?: string): Promise<OtaCampaign> {
    let next: OtaCampaign;
    try {
      next = campaignReducer(c, event, this.core.now());
    } catch (err) {
      if (err instanceof OpsError) throw new ApiError(409, err.code, err.message, err.detail);
      throw err;
    }
    await this.core.repos.campaigns.update(next);
    if (event.type !== "wave_progress" || next.status !== c.status) {
      const action = event.type === "wave_progress" ? `ota.campaign.${next.status === "rolled_back" ? "rollback" : next.status === "paused" ? "pause" : next.status}` : `ota.campaign.${event.type}`;
      await this.core.audit(c.tenantId, actor, action, `campaign:${c.id}`, { from: c.status, to: next.status, ...(reason ? { reason } : {}) });
      await this.deps.integrations.dispatch(c.tenantId, `ota.${next.status}`, { campaignId: c.id, name: c.name, status: next.status, reason });
    }
    if (next.status === "rolled_back" && c.status !== "rolled_back") await this.revertDevices(next);
    this.core.live.broadcast({ type: "ota", tenantId: c.tenantId, payload: next });
    return next;
  }

  async start(c: OtaCampaign, actor: string) {
    const next = await this.apply(c, { type: "start" }, actor);
    const rows = await this.core.repos.campaignDevices.list(c.id);
    await this.setOtaStatus(rows.filter((r) => r.status === "pending").map((r) => r.deviceId), "pending");
    return next;
  }

  private async setOtaStatus(ids: string[], status: NonNullable<Device["otaStatus"]>) {
    if (!ids.length) return;
    for (const d of await this.core.repos.devices.getMany(ids)) await this.core.repos.devices.update({ ...d, otaStatus: status });
  }
  pause(c: OtaCampaign, actor: string, reason?: string) {
    return this.apply(c, reason ? { type: "pause", reason } : { type: "pause" }, actor, reason);
  }
  resume(c: OtaCampaign, actor: string) {
    return this.apply(c, { type: "resume" }, actor);
  }
  rollback(c: OtaCampaign, actor: string, reason?: string) {
    return this.apply(c, reason ? { type: "rollback", reason } : { type: "rollback" }, actor, reason);
  }

  /** Devices that already took the new firmware go back to their previous version. */
  private async revertDevices(c: OtaCampaign) {
    const rows = (await this.core.repos.campaignDevices.list(c.id)).filter((r) => r.status === "succeeded");
    const devices = await this.core.repos.devices.getMany(rows.map((r) => r.deviceId));
    const now = this.core.now().toISOString();
    for (const d of devices) {
      const row = rows.find((r) => r.deviceId === d.id)!;
      const next: Device = { ...d, updatedAt: now, otaStatus: "rolled_back" };
      if (row.fromVersion) next.firmwareVersion = row.fromVersion;
      delete next.codecVersion;
      await this.core.repos.devices.update(next);
      await this.core.timeline(d.tenantId, d.id, "ota", `Rolled back to firmware ${row.fromVersion ?? "previous"}`, { campaignId: c.id });
    }
    await this.core.repos.campaignDevices.setStatus(c.id, rows.map((r) => r.deviceId), "rolled_back");
    const waiting = (await this.core.repos.campaignDevices.list(c.id)).filter((r) => r.status === "pending").map((r) => r.deviceId);
    for (const d of await this.core.repos.devices.getMany(waiting)) {
      const { otaStatus: _o, ...rest } = d;
      await this.core.repos.devices.update(rest as Device);
    }
    this.core.codecs.invalidate("fw");
  }

  /** Dev simulation step for every running campaign. */
  async tick(): Promise<void> {
    const running = await this.core.repos.campaigns.list({ where: ["status = ?"], params: ["running"] });
    for (const c of running) await this.tickCampaign(c);
  }

  async tickCampaign(c: OtaCampaign): Promise<OtaCampaign> {
    const waveIndex = c.waves.findIndex((w) => w.status === "running");
    if (waveIndex < 0) return c;
    const wave = c.waves[waveIndex]!;
    const fw = await this.core.repos.firmware.get(c.firmwareId);
    if (!fw) return this.apply(c, { type: "pause", reason: "firmware missing" }, "system", "firmware missing");
    const rows = await this.core.repos.campaignDevices.list(c.id, waveIndex);
    const pending = rows.filter((r) => r.status === "pending");
    const batch = pending.slice(0, Math.max(1, Math.ceil(wave.targeted / 3)));
    const devices = new Map((await this.core.repos.devices.getMany(batch.map((b) => b.deviceId))).map((d) => [d.id, d]));
    const succeeded: string[] = [];
    const failed: string[] = [];
    for (const r of batch) {
      const d = devices.get(r.deviceId);
      if (!d) {
        failed.push(r.deviceId);
        continue;
      }
      const pf = preflight(d);
      if (!pf.ok) {
        const key = `${c.id}:${d.id}`;
        const n = (this.deferrals.get(key) ?? 0) + 1;
        this.deferrals.set(key, n);
        if (n < MAX_DEFERRALS) continue;
        failed.push(d.id);
        await this.core.timeline(d.tenantId, d.id, "ota", `OTA ${fw.version} failed preflight`, { campaignId: c.id, reasons: pf.reasons });
        continue;
      }
      if (this.rand() < this.simFailureRate) {
        failed.push(d.id);
        await this.core.timeline(d.tenantId, d.id, "ota", `OTA ${fw.version} install failed`, { campaignId: c.id, error: "Image verification failed after download" });
        continue;
      }
      succeeded.push(d.id);
      await this.installed(d, fw, c.id);
    }
    await this.core.repos.campaignDevices.setStatus(c.id, succeeded, "succeeded");
    await this.core.repos.campaignDevices.setStatus(c.id, failed, "failed");
    await this.setOtaStatus(failed, "failed");
    // the next devices in line are downloading
    await this.setOtaStatus(pending.slice(batch.length, batch.length + batch.length).map((r) => r.deviceId), "downloading");
    const all = await this.core.repos.campaignDevices.list(c.id, waveIndex);
    const ok = all.filter((r) => r.status === "succeeded");
    const okDevices = await this.core.repos.devices.getMany(ok.map((r) => r.deviceId));
    const avgHealth = okDevices.length ? okDevices.reduce((s, d) => s + d.health.score, 0) / okDevices.length : 100;
    const before = c.status;
    const next = await this.apply(
      c,
      { type: "wave_progress", waveIndex, succeeded: ok.length, failed: all.filter((r) => r.status === "failed").length, avgHealth },
      "system",
    );
    if (next.status !== before && (next.status === "paused" || next.status === "rolled_back")) {
      const w = next.waves[waveIndex]!;
      const rate = w.succeeded + w.failed ? w.failed / (w.succeeded + w.failed) : 0;
      const verb = next.status === "paused" ? "auto-paused" : "auto-rolled back";
      await this.deps.alerts.create({
        tenantId: c.tenantId,
        severity: "critical",
        title: `OTA "${c.name}" ${verb} at wave ${w.name}`,
        detail: `Failure rate ${(rate * 100).toFixed(1)}% (gate ${(c.healthGate.maxFailureRate * 100).toFixed(0)}%), avg health ${avgHealth.toFixed(0)} (gate ${c.healthGate.minHealthScore}).`,
        source: "ota:health-gate",
      });
    }
    return next;
  }

  private async installed(d: Device, fw: FirmwareRow, campaignId: string) {
    const from = d.firmwareVersion;
    const next: Device = { ...d, firmwareVersion: fw.version, otaStatus: "succeeded", updatedAt: this.core.now().toISOString() };
    if (fw.codecVersion) next.codecVersion = fw.codecVersion;
    await this.core.repos.devices.update(next);
    await this.core.timeline(d.tenantId, d.id, "ota", `Firmware ${from ?? "?"} → ${fw.version}`, { campaignId, firmwareId: fw.id });
  }

  validateInput(body: NewCampaign) {
    if (!body.firmwareId) throw badRequest("firmwareId required");
  }
}
