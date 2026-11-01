import type { BulkJob, BulkOp, BulkPreview, Device, DeviceQuery, LifecycleState } from "@hash8/sdk-ts";
import { applyTemplate, bulkEligibility } from "@hash8/ops-engine";
import type { Core } from "../context";
import type { BulkJobRecord } from "../db/repos";
import type { AssetService } from "./assets";
import type { CommandService } from "./commands";
import type { DeviceService } from "./devices";
import type { OtaService } from "./ota";
import { badRequest, notFound } from "../errors";
import { newId } from "../util/ids";

export const BULK_PERMISSIONS: Record<BulkOp, string> = {
  assign: "devices:assign",
  lifecycle: "devices:lifecycle",
  apply_config: "devices:config",
  start_ota: "ota:start",
  suspend: "devices:lifecycle",
  reactivate: "devices:lifecycle",
  diagnostics: "devices:diagnose",
  command: "devices:command",
  tag: "devices:write",
  transfer: "devices:transfer",
  export: "devices:read",
};

/** Dev RBAC: `x-actor` "viewer:*" is read-only; everything else may operate. */
export function actorCan(actor: string, permission: string): boolean {
  if (actor.startsWith("viewer:")) return permission === "devices:read";
  return true;
}

const MAX_BULK = 10_000;

type Check = (d: Device) => Promise<string | undefined> | string | undefined;

/**
 * Bulk operations: preview (per-device eligibility + required permission) → job with
 * per-device results. Every device result is independent: one failure never aborts the job.
 */
export class BulkService {
  constructor(
    private core: Core,
    private deps: { devices: DeviceService; commands: CommandService; ota: OtaService; assets: AssetService },
  ) {}

  async resolveDevices(scope: string[], tenantId: string, input: { deviceIds?: string[]; query?: DeviceQuery }): Promise<{ devices: Device[]; missing: string[] }> {
    let ids = input.deviceIds;
    if (!ids?.length) {
      if (!input.query) throw badRequest("deviceIds or query required");
      const q = { ...input.query };
      delete q.cursor;
      delete q.limit;
      ids = await this.core.repos.devices.ids(scope, q);
    }
    if (ids.length > MAX_BULK) throw badRequest(`Bulk operations are limited to ${MAX_BULK} devices`);
    const devices = await this.core.repos.devices.getMany(ids);
    const found = new Set(devices.map((d) => d.id));
    void tenantId;
    return { devices: devices.filter((d) => scope.includes(d.tenantId) || scope.includes(d.oemTenantId)), missing: ids.filter((id) => !found.has(id)) };
  }

  /**
   * Per-device check: ops-engine `bulkEligibility` (lifecycle, preflight, compatibility)
   * plus checks that need storage (template model, codec downlink support).
   */
  private async checker(op: BulkOp, params: Record<string, unknown>, scope: string[]): Promise<{ check: Check; warnings: string[] }> {
    const warnings: string[] = [];
    const p: Record<string, unknown> = { ...params };
    if (op === "transfer") p.tenantId ??= params.toTenantId;
    let fwModel: string | undefined;
    if (op === "start_ota") {
      if (!params.firmwareId) throw badRequest("params.firmwareId required");
      const fw = await this.core.repos.firmware.get(String(params.firmwareId));
      if (!fw) throw notFound("firmware", String(params.firmwareId));
      fwModel = fw.modelId;
      p.firmware = fw.codecVersion ? { version: fw.version, codecVersion: fw.codecVersion } : { version: fw.version };
    }
    if (op === "apply_config" && !params.templateId && !params.desired) throw badRequest("params.templateId or params.desired required");
    if (op === "tag" && !params.add && !params.remove) throw badRequest("params.add or params.remove required");
    const check: Check = async (d) => {
      const e = bulkEligibility(op, d, p);
      if (!e.eligible) return e.reason ?? "not eligible";
      if (fwModel && fwModel !== d.modelId) return `firmware is for model ${fwModel}`;
      if (op === "apply_config" && params.templateId) {
        const t = await this.core.repos.templates.getScoped(String(params.templateId), scope);
        if (!t) return "template not found";
        if (t.modelId !== d.modelId) return `template is for ${t.modelId}`;
      }
      if (op === "command") {
        if ((d.health.connectivity === "offline" || d.health.connectivity === "never_seen") && !warnings.length) warnings.push("Offline devices will receive the command when they reconnect");
        const r = await this.core.codecs.forDevice(d);
        if (!r) return "no codec";
        const known = [...(r.codec.spec.downlink ?? []), ...r.codec.spec.uplink].some((m) => m.name === params.message);
        if (!known) return `codec ${r.codecId} has no message ${String(params.message)}`;
      }
      return undefined;
    };
    return { check, warnings };
  }

  async preview(ctx: { tenantId: string; scope: string[]; actor: string }, op: BulkOp, input: { deviceIds?: string[]; query?: DeviceQuery }, params: Record<string, unknown>): Promise<BulkPreview> {
    const { devices, missing } = await this.resolveDevices(ctx.scope, ctx.tenantId, input);
    const permission = BULK_PERMISSIONS[op];
    const allowed = actorCan(ctx.actor, permission);
    const { check, warnings } = await this.checker(op, params, ctx.scope);
    const eligible: string[] = [];
    const ineligible: { deviceId: string; reason: string }[] = missing.map((id) => ({ deviceId: id, reason: "not found" }));
    for (const d of devices) {
      if (!allowed) {
        ineligible.push({ deviceId: d.id, reason: `missing permission ${permission}` });
        continue;
      }
      if (op !== "export" && !ctx.scope.includes(d.tenantId)) {
        ineligible.push({ deviceId: d.id, reason: "read-only: device is owned by another tenant" });
        continue;
      }
      const reason = await check(d);
      if (reason) ineligible.push({ deviceId: d.id, reason });
      else eligible.push(d.id);
    }
    if (ineligible.length && eligible.length) warnings.push(`${ineligible.length} device(s) will be skipped`);
    return { op, eligible, ineligible, requiresPermission: permission, warnings };
  }

  async run(ctx: { tenantId: string; scope: string[]; actor: string }, op: BulkOp, deviceIds: string[], params: Record<string, unknown>): Promise<BulkJob> {
    const now = this.core.now().toISOString();
    const preview = await this.preview(ctx, op, { deviceIds }, params);
    const job: BulkJobRecord = { id: newId("blk"), tenantId: ctx.tenantId, op, params, status: "running", total: deviceIds.length, succeeded: 0, failed: 0, results: [], actor: ctx.actor, createdAt: now, updatedAt: now };
    await this.core.repos.bulkJobs.insert(job);
    for (const i of preview.ineligible) job.results.push({ deviceId: i.deviceId, ok: false, error: i.reason });
    const devices = await this.core.repos.devices.getMany(preview.eligible);
    if (op === "start_ota" && devices.length) {
      try {
        const c = await this.deps.ota.create(ctx.tenantId, ctx.scope, { name: String(params.name ?? `Bulk OTA ${now.slice(0, 10)}`), firmwareId: String(params.firmwareId), deviceIds: devices.map((d) => d.id), fromVersions: (params.fromVersions as string[]) ?? [] }, ctx.actor);
        await this.deps.ota.start(c, ctx.actor);
        for (const d of devices) job.results.push({ deviceId: d.id, ok: true });
        job.params = { ...params, campaignId: c.id };
      } catch (err) {
        for (const d of devices) job.results.push({ deviceId: d.id, ok: false, error: (err as Error).message });
      }
    } else {
      for (const d of devices) {
        try {
          await this.apply(op, d, params, ctx);
          job.results.push({ deviceId: d.id, ok: true });
        } catch (err) {
          job.results.push({ deviceId: d.id, ok: false, error: (err as Error).message });
        }
      }
    }
    job.succeeded = job.results.filter((r) => r.ok).length;
    job.failed = job.results.length - job.succeeded;
    job.status = job.failed === 0 ? "completed" : job.succeeded === 0 ? "failed" : "completed_with_errors";
    job.updatedAt = this.core.now().toISOString();
    await this.core.repos.bulkJobs.update(job);
    await this.core.audit(ctx.tenantId, ctx.actor, `bulk.${op}`, `bulk-job:${job.id}`, { total: job.total, succeeded: job.succeeded, failed: job.failed, params });
    const { tenantId: _t, ...pub } = job;
    return pub;
  }

  private async apply(op: BulkOp, d: Device, params: Record<string, unknown>, ctx: { tenantId: string; scope: string[]; actor: string }) {
    const actor = ctx.actor;
    switch (op) {
      case "assign": {
        let next = d;
        const patch: Partial<Device> = {};
        if (typeof params.organization === "string") patch.organization = params.organization;
        if (typeof params.branch === "string") patch.branch = params.branch;
        if (Object.keys(patch).length) {
          next = { ...d, ...patch, updatedAt: this.core.now().toISOString() };
          await this.deps.devices.save(next);
        }
        if (typeof params.assetId === "string") {
          const asset = await this.core.repos.assets.getScoped(params.assetId, ctx.scope);
          if (!asset) throw notFound("asset", params.assetId);
          await this.deps.assets.attach(asset, d.id, "primary", actor);
        } else await this.deps.devices.transition(next, "assigned", actor, "bulk assign");
        return;
      }
      case "lifecycle":
        await this.deps.devices.transition(d, params.to as LifecycleState, actor, typeof params.note === "string" ? params.note : "bulk");
        return;
      case "suspend":
        await this.deps.devices.transition(d, "suspended", actor, typeof params.note === "string" ? params.note : "bulk suspend");
        return;
      case "reactivate":
        await this.deps.devices.transition(d, "activated", actor, "bulk reactivate");
        return;
      case "apply_config": {
        let desired = (params.desired as Record<string, unknown>) ?? {};
        let templateId: string | undefined;
        if (params.templateId) {
          const t = await this.core.repos.templates.get(String(params.templateId));
          if (!t) throw notFound("template", String(params.templateId));
          desired = applyTemplate(t, params.desired as Record<string, unknown> | undefined);
          templateId = t.id;
          await this.deps.devices.save({ ...d, configProfileId: t.id, configVersion: t.version, updatedAt: this.core.now().toISOString() });
        }
        await this.deps.devices.setDesired((await this.core.repos.devices.get(d.id)) ?? d, desired, actor, templateId);
        return;
      }
      case "diagnostics": {
        const health = await this.deps.devices.healthFor(d);
        await this.deps.devices.save({ ...d, health });
        await this.core.timeline(d.tenantId, d.id, "audit", "Diagnostics run", { score: health.score, level: health.level, issues: health.issues });
        return;
      }
      case "command":
        await this.deps.commands.send(d, String(params.message), (params.data as Record<string, unknown>) ?? {}, actor);
        return;
      case "tag": {
        const tags = new Set(d.tags);
        for (const t of (params.add as string[]) ?? []) tags.add(t);
        for (const t of (params.remove as string[]) ?? []) tags.delete(t);
        await this.deps.devices.save({ ...d, tags: [...tags].sort(), updatedAt: this.core.now().toISOString() });
        return;
      }
      case "transfer":
        await this.deps.devices.transfer([d.id], String(params.toTenantId), ctx.scope, actor);
        return;
      case "export":
      case "start_ota":
        return;
    }
  }
}
