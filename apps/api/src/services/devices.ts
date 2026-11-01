import type { Device, DeviceConfig, DeviceModel, LifecycleState } from "@hash8/sdk-ts";
import { buildDeviceConfig, computeHealth, OpsError, transitionDevice } from "@hash8/ops-engine";
import type { Core } from "../context";
import type { IntegrationService } from "./integrations";
import { ApiError, notFound } from "../errors";
import { newId } from "../util/ids";
import { expectedIntervalSec, extractVitals } from "./vitals";

export type LifecycleListener = (device: Device, from: LifecycleState, actor: string) => Promise<void> | void;

export class DeviceService {
  private modelCache = new Map<string, DeviceModel>();
  private lifecycleListeners: LifecycleListener[] = [];

  constructor(
    private core: Core,
    private integrations: IntegrationService,
  ) {}

  onLifecycle(fn: LifecycleListener) {
    this.lifecycleListeners.push(fn);
  }

  async model(id: string): Promise<DeviceModel | undefined> {
    let m = this.modelCache.get(id);
    if (!m) {
      m = await this.core.repos.models.get(id);
      if (m) this.modelCache.set(id, m);
    }
    return m;
  }
  invalidateModels() {
    this.modelCache.clear();
  }

  /** Visible = owned by a tenant in scope, or manufactured by it (OEM view). */
  async getVisible(id: string, scope: string[]): Promise<Device> {
    const d = await this.core.repos.devices.get(id);
    if (!d || (!scope.includes(d.tenantId) && !scope.includes(d.oemTenantId))) throw notFound("device", id);
    return d;
  }

  async save(d: Device, broadcast = true) {
    await this.core.repos.devices.update(d);
    if (broadcast) this.core.live.broadcast({ type: "device", tenantId: d.tenantId, payload: d });
  }

  async transition(d: Device, to: LifecycleState, actor: string, note?: string): Promise<Device> {
    let res;
    try {
      res = transitionDevice(d, to, actor, this.core.now(), note);
    } catch (err) {
      if (err instanceof OpsError) throw new ApiError(409, err.code, err.message, err.detail);
      throw err;
    }
    const next: Device = { ...res.device };
    const at = this.core.now().toISOString();
    if (to === "installing" && !next.installedAt) next.installedAt = at;
    if (to === "activated") {
      next.activatedAt ??= at;
      next.installedAt ??= at;
      if (next.sim && next.sim.status === "inactive") next.sim = { ...next.sim, status: "active", activatedAt: at };
    }
    if (to === "suspended" && next.sim?.status === "active") next.sim = { ...next.sim, status: "suspended" };
    if (to === "retired" && next.sim) next.sim = { ...next.sim, status: "terminated" };
    await this.save(next);
    await this.core.repos.timeline.insertMany([{ ...res.timeline, id: newId("tl"), tenantId: next.tenantId }]);
    await this.core.repos.audit.insert({ ...res.audit, id: newId("aud") });
    await this.integrations.dispatch(next.tenantId, "device.lifecycle", { deviceId: next.id, serial: next.serial, from: d.lifecycle, to, actor });
    for (const l of this.lifecycleListeners) await l(next, d.lifecycle, actor);
    return next;
  }

  async transfer(deviceIds: string[], toTenantId: string, scope: string[], actor: string): Promise<number> {
    const tenant = await this.core.repos.tenants.get(toTenantId);
    if (!tenant) throw notFound("tenant", toTenantId);
    const devices = await this.core.repos.devices.getMany(deviceIds);
    const missing = deviceIds.filter((id) => !devices.some((d) => d.id === id && (scope.includes(d.tenantId) || scope.includes(d.oemTenantId))));
    if (missing.length) throw notFound("device", missing.slice(0, 5).join(","));
    const now = this.core.now().toISOString();
    const codecIds = new Set<string>();
    for (const d of devices) {
      const from = d.tenantId;
      const next: Device = { ...d, tenantId: toTenantId, updatedAt: now };
      if (tenant.kind === "customer") next.organization = tenant.name;
      await this.save(next);
      const codec = d.codecId ?? (await this.model(d.modelId))?.codecId;
      if (codec) codecIds.add(codec);
      await this.core.timeline(toTenantId, d.id, "ownership", `Ownership transferred to ${tenant.name}`, { from, to: toTenantId, actor });
      await this.core.audit(from, actor, "device.transfer", `device:${d.id}`, { from, to: toTenantId });
    }
    // Credentials move with the device to the new owner.
    await this.core.db.query(
      "UPDATE credentials SET tenant_id = $2, doc = jsonb_set(doc, '{tenantId}', to_jsonb($2::text)) WHERE device_id = ANY($1::text[])",
      [devices.map((d) => d.id), toTenantId],
    );
    // Codec access travels with the device: the new owner can decode & download plugins.
    for (const c of codecIds) await this.core.repos.codecs.grant(c, toTenantId);
    return devices.length;
  }

  /** Recompute health from shadow + recent message stats. */
  async healthFor(d: Device, now = this.core.now(), rate?: { total: number; errors: number }): Promise<Device["health"]> {
    const model = await this.model(d.modelId);
    const vitals = extractVitals(d.shadow ?? {});
    const r = rate ?? (await this.core.repos.messages.countForDeviceSince(d.id, new Date(now.getTime() - 3600_000)));
    const input: Parameters<typeof computeHealth>[0] = {
      now,
      expectedIntervalSec: expectedIntervalSec(model?.category),
      msgCount1h: r.total,
    };
    if (d.health.lastSeenAt) input.lastSeenAt = d.health.lastSeenAt;
    if (vitals.battery !== undefined) input.battery = vitals.battery;
    if (vitals.signal !== undefined) input.signal = vitals.signal;
    if (r.total > 0) input.errorRate = r.errors / r.total;
    if (d.health.lastHeartbeatAt) input.lastHeartbeatAt = d.health.lastHeartbeatAt;
    const newest = d.health.lastSeenAt;
    if (newest) input.newestTelemetryAt = newest;
    if (d.health.gps) input.gps = d.health.gps;
    if (d.health.engineHours !== undefined) input.engineHours = d.health.engineHours;
    return computeHealth(input);
  }

  /**
   * Periodic sweep: recompute health/connectivity for every device that has been seen.
   * Returns devices that just went offline (for offline automations).
   */
  async sweepHealth(): Promise<Device[]> {
    const now = this.core.now();
    const rates = await this.core.repos.messages.ratesSince(new Date(now.getTime() - 3600_000));
    const wentOffline: Device[] = [];
    const page = await this.core.repos.devices.list(undefined, { limit: 500 });
    let items = page.items;
    let cursor = page.cursor;
    for (;;) {
      for (const d of items) {
        if (!d.health.lastSeenAt) continue;
        const health = await this.healthFor(d, now, rates.get(d.id) ?? { total: 0, errors: 0 });
        if (health.connectivity !== d.health.connectivity || health.score !== d.health.score) {
          const next = { ...d, health };
          await this.save(next, health.connectivity !== d.health.connectivity);
          if (d.health.connectivity !== "offline" && health.connectivity === "offline") wentOffline.push(next);
        }
      }
      if (!cursor) break;
      const p = await this.core.repos.devices.list(undefined, { limit: 500, cursor });
      items = p.items;
      cursor = p.cursor;
    }
    return wentOffline;
  }

  async getConfig(d: Device): Promise<DeviceConfig> {
    const row = await this.core.repos.configs.get(d.id);
    return buildDeviceConfig(d.id, row?.desired ?? {}, row?.reported ?? {}, row ? new Date(row.updatedAt) : this.core.now(), row?.templateId);
  }

  async setDesired(d: Device, desired: Record<string, unknown>, actor: string, templateId?: string): Promise<DeviceConfig> {
    const row = await this.core.repos.configs.get(d.id);
    const now = this.core.now();
    const tpl = templateId ?? row?.templateId;
    await this.core.repos.configs.upsert({
      deviceId: d.id,
      tenantId: d.tenantId,
      desired,
      reported: row?.reported ?? {},
      ...(tpl ? { templateId: tpl } : {}),
      updatedAt: now.toISOString(),
    });
    const cfg = buildDeviceConfig(d.id, desired, row?.reported ?? {}, now, tpl);
    await this.core.timeline(d.tenantId, d.id, "config", "Desired configuration updated", { desired, drift: cfg.drift });
    await this.core.audit(d.tenantId, actor, "device.config.update", `device:${d.id}`, { desired, templateId: tpl });
    return cfg;
  }

  /** Merge config-bearing uplink fields into config.reported. */
  async applyReported(d: Device, messageName: string, data: Record<string, unknown>) {
    const row = await this.core.repos.configs.get(d.id);
    const desiredKeys = Object.keys(row?.desired ?? {});
    const isConfigMsg = /config|setting|param/i.test(messageName);
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) if (isConfigMsg || desiredKeys.includes(k)) patch[k] = v;
    if (!Object.keys(patch).length) return;
    const reported = { ...(row?.reported ?? {}), ...patch };
    await this.core.repos.configs.upsert({
      deviceId: d.id,
      tenantId: d.tenantId,
      desired: row?.desired ?? {},
      reported,
      ...(row?.templateId ? { templateId: row.templateId } : {}),
      updatedAt: this.core.now().toISOString(),
    });
  }
}
