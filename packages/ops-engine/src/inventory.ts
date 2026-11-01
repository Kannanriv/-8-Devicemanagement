import type {
  AssetAssociation, BulkOp, CredentialStatus, Device, DeviceCredential, InventoryKpis, LifecycleState,
} from "@hash8/sdk-ts";
import { LIFECYCLE_TRANSITIONS } from "@hash8/sdk-ts";
import { OpsError } from "./errors";
import { canTransition } from "./lifecycle";
import { checkCompatibility, preflight } from "./ota";

const OTA_IN_PROGRESS = new Set<Device["otaStatus"]>(["pending", "downloading", "installing"]);

/**
 * Inventory KPI cards (see InventoryKpis comments). Decisions where the contract is loose:
 * - connected/stale/offline count activated devices only.
 * - notCommissioned = never_seen among non-retired devices.
 * - attentionRequired (overlapping): health warning|critical among devices that are
 *   not retired and have been seen, OR any device with an open critical alert.
 */
export function computeInventoryKpis(devices: Device[], openCriticalAlertDeviceIds?: Set<string>): InventoryKpis {
  const k: InventoryKpis = {
    total: 0, connected: 0, stale: 0, offline: 0, notCommissioned: 0, attentionRequired: 0,
    pendingInstallation: 0, activationInProgress: 0, otaInProgress: 0, suspended: 0, retired: 0,
  };
  for (const d of devices) {
    k.total++;
    const conn = d.health?.connectivity;
    const lc = d.lifecycle;
    if (lc === "activated") {
      if (conn === "online") k.connected++;
      else if (conn === "stale") k.stale++;
      else if (conn === "offline") k.offline++;
    }
    if (conn === "never_seen" && lc !== "retired") k.notCommissioned++;
    const unhealthy = lc !== "retired" && conn !== "never_seen" && (d.health?.level === "warning" || d.health?.level === "critical");
    if (unhealthy || openCriticalAlertDeviceIds?.has(d.id)) k.attentionRequired++;
    if (lc === "assigned" || lc === "installing") k.pendingInstallation++;
    else if (lc === "pending_activation") k.activationInProgress++;
    else if (lc === "suspended") k.suspended++;
    else if (lc === "retired") k.retired++;
    if (OTA_IN_PROGRESS.has(d.otaStatus)) k.otaInProgress++;
  }
  return k;
}

export interface Eligibility {
  eligible: boolean;
  reason?: string;
}

const yes: Eligibility = { eligible: true };
const no = (reason: string): Eligibility => ({ eligible: false, reason });
const needLifecycle = (d: Device, allowed: LifecycleState[], what: string): Eligibility =>
  allowed.includes(d.lifecycle) ? yes : no(`Cannot ${what} a device in lifecycle ${d.lifecycle} (needs ${allowed.join(" or ")})`);

const COMMANDABLE: LifecycleState[] = ["activated", "maintenance", "installing", "pending_activation"];
const TRANSFER_BLOCKED: LifecycleState[] = ["installing", "pending_activation", "swap", "retired"];

/**
 * Per-device eligibility for a bulk operation (powers BulkPreview). `params` is the
 * job-level parameter bag: lifecycle {to}, assign {assetId?}, command {message},
 * transfer {tenantId}, start_ota {firmware?: {version, codecVersion?}, fromVersions?}.
 */
export function bulkEligibility(op: BulkOp, device: Device, params: Record<string, unknown> = {}): Eligibility {
  switch (op) {
    case "assign":
      return needLifecycle(device, ["registered", "assigned"], "assign");
    case "lifecycle": {
      const to = params.to;
      if (typeof to !== "string" || !Object.hasOwn(LIFECYCLE_TRANSITIONS, to)) return no("Missing or unknown target lifecycle (params.to)");
      return canTransition(device.lifecycle, to as LifecycleState)
        ? yes
        : no(`Cannot move from ${device.lifecycle} to ${to}`);
    }
    case "apply_config":
      return device.lifecycle === "retired" ? no("Device is retired") : yes;
    case "start_ota": {
      if (OTA_IN_PROGRESS.has(device.otaStatus)) return no(`OTA already in progress (${device.otaStatus})`);
      const pf = preflight(device);
      if (!pf.ok) return no(pf.reasons.join("; "));
      const fw = params.firmware as { version?: unknown; codecVersion?: unknown } | undefined;
      if (fw && typeof fw.version === "string") {
        const from = Array.isArray(params.fromVersions) ? params.fromVersions.filter((x): x is string => typeof x === "string") : [];
        const firmware: { version: string; codecVersion?: string } = { version: fw.version };
        if (typeof fw.codecVersion === "string") firmware.codecVersion = fw.codecVersion;
        const cc = checkCompatibility(firmware, device, from);
        if (!cc.ok) return no(cc.reasons.join("; "));
      }
      return yes;
    }
    case "suspend":
      return needLifecycle(device, ["activated"], "suspend");
    case "reactivate":
      return needLifecycle(device, ["suspended"], "reactivate");
    case "diagnostics":
      if (device.lifecycle === "retired") return no("Device is retired");
      if (device.health?.connectivity === "never_seen") return no("Device has never communicated");
      return yes;
    case "command":
      if (typeof params.message !== "string" || !params.message) return no("Missing downlink message (params.message)");
      return needLifecycle(device, COMMANDABLE, "command");
    case "tag":
    case "export":
      return yes;
    case "transfer": {
      const tenantId = params.tenantId;
      if (typeof tenantId !== "string" || !tenantId) return no("Missing target tenant (params.tenantId)");
      if (tenantId === device.tenantId) return no(`Device already belongs to ${tenantId}`);
      if (TRANSFER_BLOCKED.includes(device.lifecycle)) return no(`Cannot transfer a device in lifecycle ${device.lifecycle}`);
      if (OTA_IN_PROGRESS.has(device.otaStatus)) return no("Cannot transfer during an OTA update");
      return yes;
    }
    default:
      return no(`Unknown operation ${String(op)}`);
  }
}

export interface SwapResult {
  closed: AssetAssociation;
  opened: AssetAssociation;
  lifecycle: { old: { deviceId: string; to: "swap" }; new: { deviceId: string; to: "activated" } };
}

/**
 * Replace the device on an asset. Pass the `current` open association to close it with
 * its history intact; without it a closed record is synthesised. Ids are deterministic.
 * The caller applies the lifecycle targets via transitionDevice.
 */
export function swapAssociation(
  assetId: string,
  oldDeviceId: string,
  newDeviceId: string,
  actor: string,
  now: Date,
  current?: AssetAssociation,
): SwapResult {
  if (oldDeviceId === newDeviceId) throw new OpsError("INVALID_SWAP", `Cannot swap device ${oldDeviceId} with itself`);
  if (current) {
    if (current.assetId !== assetId || current.deviceId !== oldDeviceId) {
      throw new OpsError("INVALID_SWAP", `Association ${current.id} is ${current.deviceId}@${current.assetId}, not ${oldDeviceId}@${assetId}`);
    }
    if (current.to) throw new OpsError("INVALID_SWAP", `Association ${current.id} is already closed`);
  }
  const at = now.toISOString();
  const closed: AssetAssociation = current
    ? { ...current, to: at }
    : { id: `assoc:${assetId}:${oldDeviceId}`, assetId, deviceId: oldDeviceId, role: "primary", from: at, to: at, reason: "swap", actor };
  const opened: AssetAssociation = {
    id: `assoc:${assetId}:${newDeviceId}:${now.getTime()}`,
    assetId,
    deviceId: newDeviceId,
    role: current?.role ?? "primary",
    from: at,
    reason: "swap",
    actor,
  };
  return {
    closed,
    opened,
    lifecycle: { old: { deviceId: oldDeviceId, to: "swap" }, new: { deviceId: newDeviceId, to: "activated" } },
  };
}

/** Derive credential status from dates: revoked > expired > expiring (≤ expiringDays) > active. */
export function credentialStatus(cred: DeviceCredential, now: Date, expiringDays = 30): CredentialStatus {
  if (cred.status === "revoked" || cred.revokedAt) return "revoked";
  const exp = cred.expiresAt ? Date.parse(cred.expiresAt) : NaN;
  if (Number.isNaN(exp)) return "active";
  const left = exp - now.getTime();
  if (left <= 0) return "expired";
  return left <= expiringDays * 86_400_000 ? "expiring" : "active";
}
