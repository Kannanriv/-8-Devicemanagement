import { LIFECYCLE_LABELS, LIFECYCLE_TRANSITIONS } from "@hash8/sdk-ts";
import type { AuditEntry, Device, LifecycleState, TimelineEvent } from "@hash8/sdk-ts";
import { OpsError } from "./errors";

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  if (!Object.prototype.hasOwnProperty.call(LIFECYCLE_TRANSITIONS, from)) return false;
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

export interface LifecycleTransitionResult {
  device: Device;
  timeline: Omit<TimelineEvent, "id">;
  audit: Omit<AuditEntry, "id">;
}

export function transitionDevice(
  device: Device,
  to: LifecycleState,
  actor: string,
  now: Date,
  note?: string,
): LifecycleTransitionResult {
  const from = device.lifecycle;
  if (!canTransition(from, to)) {
    const allowed = LIFECYCLE_TRANSITIONS[from] ?? [];
    throw new OpsError(
      "INVALID_TRANSITION",
      `Device ${device.id} cannot move from ${from} to ${to} (allowed: ${allowed.join(", ") || "none"})`,
      { from, to, allowed },
    );
  }
  const at = now.toISOString();
  const noteDetail = note !== undefined ? { note } : {};
  const next: Device = { ...device, lifecycle: to, updatedAt: at };
  if (to === "installing") next.installedAt = at;
  // First commissioning stamps activatedAt; returning from maintenance/suspended/swap keeps it.
  if (to === "activated" && (from === "pending_activation" || !device.activatedAt)) next.activatedAt = at;
  return {
    device: next,
    timeline: {
      deviceId: device.id,
      at,
      kind: "lifecycle",
      title: `Lifecycle ${LIFECYCLE_LABELS[from] ?? from} → ${LIFECYCLE_LABELS[to] ?? to}`,
      detail: { from, to, actor, ...noteDetail },
    },
    audit: {
      tenantId: device.tenantId,
      at,
      actor,
      action: "device.lifecycle.update",
      target: `device:${device.id}`,
      detail: { from, to, ...noteDetail },
    },
  };
}
