import type { Asset, AssetAssociation, Device, LifecycleState } from "@hash8/sdk-ts";
import { LIFECYCLE_TRANSITIONS } from "@hash8/sdk-ts";
import { OpsError, swapAssociation } from "@hash8/ops-engine";
import type { Core } from "../context";

const SWAP_IN_PATH: LifecycleState[] = ["assigned", "installing", "pending_activation", "activated"];
import type { DeviceService } from "./devices";
import { badRequest, conflict, notFound } from "../errors";
import { newId } from "../util/ids";

/**
 * Device ↔ asset association with full history. Attaching moves a registered device
 * to `assigned`; a swap closes the old association (reason "swap"), puts the old
 * device into `swap` and attaches the replacement — both devices get timeline entries.
 */
export class AssetService {
  constructor(
    private core: Core,
    private devices: DeviceService,
  ) {}

  async get(id: string, scope: string[]): Promise<Asset> {
    const a = await this.core.repos.assets.getScoped(id, scope);
    if (!a) throw notFound("asset", id);
    return a;
  }

  async create(tenantId: string, input: Omit<Asset, "id" | "tenantId" | "deviceIds" | "createdAt">, actor: string): Promise<Asset> {
    const a: Asset = { ...input, id: newId("ast"), tenantId, deviceIds: [], createdAt: this.core.now().toISOString() };
    await this.core.repos.assets.insert(a);
    await this.core.audit(tenantId, actor, "asset.create", `asset:${a.id}`, { name: a.name, type: a.type });
    return a;
  }

  private async moveIfAllowed(d: Device, to: LifecycleState, actor: string, note: string): Promise<Device> {
    if (d.lifecycle === to || !LIFECYCLE_TRANSITIONS[d.lifecycle].includes(to)) return d;
    return this.devices.transition(d, to, actor, note);
  }

  async attach(asset: Asset, deviceId: string, role: AssetAssociation["role"], actor: string, reason: AssetAssociation["reason"] = "install", scope?: string[]) {
    const d = scope ? await this.devices.getVisible(deviceId, scope) : await this.core.repos.devices.get(deviceId);
    if (!d) throw notFound("device", deviceId);
    if (d.lifecycle === "retired") throw conflict(`Device ${d.udi} is retired`, "INVALID_STATE");
    const open = await this.core.repos.associations.openForDevice(d.id);
    if (open) {
      if (open.assetId === asset.id) throw conflict(`Device ${d.udi} is already associated with this asset`);
      throw conflict(`Device ${d.udi} is associated with asset ${open.assetId}; detach or swap first`, "ALREADY_ASSOCIATED");
    }
    const at = this.core.now().toISOString();
    const assoc: AssetAssociation = { id: newId("asc"), assetId: asset.id, deviceId: d.id, role, from: at, reason, actor };
    await this.core.repos.associations.insertMany([{ ...assoc, tenantId: asset.tenantId }]);
    const nextAsset: Asset = { ...asset, deviceIds: [...new Set([...asset.deviceIds, d.id])] };
    await this.core.repos.assets.update(nextAsset);
    let next: Device = { ...d, assetId: asset.id, assetName: asset.name, updatedAt: at };
    if (asset.organization) next.organization = asset.organization;
    if (asset.branch) next.branch = asset.branch;
    if (asset.site) next.site = asset.site;
    await this.devices.save(next);
    await this.core.timeline(d.tenantId, d.id, "association", `Associated with ${asset.name} (${role})`, { assetId: asset.id, role, reason, actor });
    await this.core.audit(asset.tenantId, actor, "asset.device.attach", `asset:${asset.id}`, { deviceId: d.id, role, reason });
    next = await this.moveIfAllowed(next, "assigned", actor, `associated with ${asset.name}`);
    return { asset: nextAsset, association: assoc, device: next };
  }

  async detach(asset: Asset, deviceId: string, actor: string, reason: AssetAssociation["reason"] = "remove") {
    const open = await this.core.repos.associations.openForDevice(deviceId);
    if (!open || open.assetId !== asset.id) throw notFound("association", `${asset.id}/${deviceId}`);
    const at = this.core.now().toISOString();
    await this.core.repos.associations.close(open.id, at, reason);
    const nextAsset: Asset = { ...asset, deviceIds: asset.deviceIds.filter((x) => x !== deviceId) };
    await this.core.repos.assets.update(nextAsset);
    const d = await this.core.repos.devices.get(deviceId);
    if (d) {
      const { assetId: _a, assetName: _n, ...rest } = d;
      await this.devices.save({ ...(rest as Device), updatedAt: at });
      await this.core.timeline(d.tenantId, d.id, "association", `Removed from ${asset.name}`, { assetId: asset.id, reason, actor });
    }
    await this.core.audit(asset.tenantId, actor, "asset.device.detach", `asset:${asset.id}`, { deviceId, reason });
    return nextAsset;
  }

  async swap(asset: Asset, oldDeviceId: string, newDeviceId: string, actor: string, scope: string[]) {
    if (oldDeviceId === newDeviceId) throw badRequest("oldDeviceId and newDeviceId must differ");
    const open = await this.core.repos.associations.openForDevice(oldDeviceId);
    if (!open || open.assetId !== asset.id) throw conflict(`Device ${oldDeviceId} is not associated with asset ${asset.id}`, "NOT_ASSOCIATED");
    const replacement = await this.devices.getVisible(newDeviceId, scope);
    if (await this.core.repos.associations.openForDevice(replacement.id)) throw conflict(`Replacement ${replacement.udi} is already associated with an asset`, "ALREADY_ASSOCIATED");
    if (replacement.modelId !== (await this.core.repos.devices.get(oldDeviceId))?.modelId) {
      // Allowed, but flagged: a different model needs a matching codec + config profile.
      await this.core.timeline(replacement.tenantId, replacement.id, "association", "Swap uses a different device model", { assetId: asset.id });
    }
    let plan;
    try {
      plan = swapAssociation(asset.id, oldDeviceId, replacement.id, actor, this.core.now(), open);
    } catch (err) {
      if (err instanceof OpsError) throw conflict(err.message, err.code);
      throw err;
    }
    const at = plan.closed.to ?? this.core.now().toISOString();
    // Close old association, open new one (history retained).
    await this.core.repos.associations.close(open.id, at, "swap");
    const opened: AssetAssociation = { ...plan.opened, id: newId("asc") };
    await this.core.repos.associations.insertMany([{ ...opened, tenantId: asset.tenantId }]);
    const nextAsset: Asset = { ...asset, deviceIds: [...asset.deviceIds.filter((x) => x !== oldDeviceId), replacement.id] };
    await this.core.repos.assets.update(nextAsset);

    // Old device: detach + lifecycle → swap.
    let old = await this.core.repos.devices.get(oldDeviceId);
    if (old) {
      const { assetId: _a, assetName: _n, ...rest } = old;
      old = { ...(rest as Device), updatedAt: at };
      await this.devices.save(old);
      await this.core.timeline(old.tenantId, old.id, "association", `Swapped out of ${asset.name} for ${replacement.udi}`, { assetId: asset.id, newDeviceId: replacement.id, actor });
      old = await this.moveIfAllowed(old, plan.lifecycle.old.to, actor, `replaced by ${replacement.udi}`);
    }
    // New device: associate + walk the lifecycle to activated.
    let fresh: Device = { ...replacement, assetId: asset.id, assetName: asset.name, updatedAt: at };
    if (asset.organization) fresh.organization = asset.organization;
    if (asset.branch) fresh.branch = asset.branch;
    if (asset.site) fresh.site = asset.site;
    await this.devices.save(fresh);
    await this.core.timeline(fresh.tenantId, fresh.id, "association", `Swapped into ${asset.name} replacing ${old?.udi ?? oldDeviceId}`, { assetId: asset.id, oldDeviceId, actor });
    for (const step of SWAP_IN_PATH) {
      if (fresh.lifecycle === plan.lifecycle.new.to) break;
      if (LIFECYCLE_TRANSITIONS[fresh.lifecycle].includes(plan.lifecycle.new.to)) {
        fresh = await this.devices.transition(fresh, plan.lifecycle.new.to, actor, `swap on ${asset.name}`);
        break;
      }
      if (LIFECYCLE_TRANSITIONS[fresh.lifecycle].includes(step)) fresh = await this.devices.transition(fresh, step, actor, `swap on ${asset.name}`);
    }
    await this.core.audit(asset.tenantId, actor, "asset.device.swap", `asset:${asset.id}`, { oldDeviceId, newDeviceId: replacement.id });
    return { asset: nextAsset, closed: { ...open, to: at, reason: "swap" as const }, association: opened, oldDevice: old, newDevice: fresh };
  }
}
