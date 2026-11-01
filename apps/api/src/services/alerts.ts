import type { Alert, Severity } from "@hash8/sdk-ts";
import type { Core } from "../context";
import type { IntegrationService } from "./integrations";
import { newId } from "../util/ids";
import { notFound, conflict } from "../errors";

export type AlertCategory = Alert["category"];

/** Best-effort category when the producer did not set one. */
export function inferCategory(source: string, title: string): AlertCategory {
  const t = `${source} ${title}`.toLowerCase();
  if (/tamper|credential|certificate|security|unauthori|intrusion/.test(t)) return "security";
  if (/ota|firmware|rollout/.test(t)) return "ota";
  if (/offline|no data|communication|heartbeat|stale|sim/.test(t)) return "communication_loss";
  if (/temperature|humidity|voltage|current|telemetry|threshold|above|below|battery/.test(t)) return "abnormal_telemetry";
  if (/fail|fault|error|sensor|crash|reboot/.test(t)) return "device_failure";
  return "other";
}

export interface NewAlert {
  tenantId: string;
  category?: AlertCategory;
  assetId?: string;
  severity: Severity;
  title: string;
  detail?: string;
  deviceId?: string;
  source: string;
}

export class AlertService {
  constructor(
    private core: Core,
    private integrations: IntegrationService,
  ) {}

  async create(a: NewAlert, opts: { dedupeMinutes?: number } = {}): Promise<Alert> {
    // De-duplicate noisy rules: same source+device+title still open within the window.
    if (opts.dedupeMinutes) {
      const since = new Date(this.core.now().getTime() - opts.dedupeMinutes * 60_000).toISOString();
      const dup = await this.core.repos.alerts.list({
        tenantIds: [a.tenantId],
        where: ["status <> 'resolved'", "doc->>'source' = ?", "coalesce(device_id,'') = ?", "doc->>'title' = ?", "created_at >= ?"],
        params: [a.source, a.deviceId ?? "", a.title, since],
        limit: 1,
      });
      if (dup[0]) return dup[0];
    }
    const alert: Alert = {
      id: newId("alr"),
      tenantId: a.tenantId,
      severity: a.severity,
      category: a.category ?? inferCategory(a.source, a.title),
      title: a.title,
      status: "open",
      source: a.source,
      createdAt: this.core.now().toISOString(),
    };
    if (a.detail) alert.detail = a.detail;
    if (a.deviceId) alert.deviceId = a.deviceId;
    if (a.assetId) alert.assetId = a.assetId;
    else if (a.deviceId) {
      const d = await this.core.repos.devices.get(a.deviceId);
      if (d?.assetId) alert.assetId = d.assetId;
    }
    await this.core.repos.alerts.insert(alert);
    if (a.deviceId) await this.core.timeline(a.tenantId, a.deviceId, "alert", `${a.severity.toUpperCase()}: ${a.title}`, { alertId: alert.id, source: a.source });
    this.core.live.broadcast({ type: "alert", tenantId: a.tenantId, payload: alert });
    await this.integrations.dispatch(a.tenantId, `alert.${a.severity}`, alert);
    await this.integrations.dispatch(a.tenantId, "alert.created", alert);
    return alert;
  }

  async setStatus(id: string, scope: string[], status: "acknowledged" | "resolved", actor: string, resolution?: string): Promise<Alert> {
    const alert = await this.core.repos.alerts.getScoped(id, scope);
    if (!alert) throw notFound("alert", id);
    if (alert.status === "resolved") throw conflict(`Alert ${id} is already resolved`, "INVALID_TRANSITION");
    if (status === "acknowledged" && alert.status === "acknowledged") throw conflict(`Alert ${id} is already acknowledged`, "INVALID_TRANSITION");
    alert.status = status;
    alert.updatedAt = this.core.now().toISOString();
    if (status === "acknowledged") alert.acknowledgedBy = actor;
    else {
      alert.resolvedBy = actor;
      alert.acknowledgedBy ??= actor;
      if (resolution) alert.resolution = resolution;
    }
    await this.core.repos.alerts.update(alert);
    await this.core.audit(alert.tenantId, actor, status === "acknowledged" ? "alert.ack" : "alert.resolve", `alert:${id}`, resolution ? { resolution } : undefined);
    this.core.live.broadcast({ type: "alert", tenantId: alert.tenantId, payload: alert });
    return alert;
  }
}
