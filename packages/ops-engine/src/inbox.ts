import type { Alert, OpsItem, OtaCampaign, Severity } from "@hash8/sdk-ts";
import { evaluateWave } from "./ota";

export interface OpsSnapshot {
  campaigns: OtaCampaign[];
  unknownPayloadCount: number;
  unknownByCodec?: Record<string, number>;
  offlineDevices: { count: number; byModel?: Record<string, number> };
  expiringCerts?: number;
  pendingSpecReviews?: number;
  openAlerts: Alert[];
  driftedConfigs?: number;
}

/** Volumes at or above which an item escalates to critical. */
export const INBOX_THRESHOLDS = { unknownPayloadsCritical: 1000, offlineCritical: 1000 } as const;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function top(counts: Record<string, number> | undefined, n = 3): string {
  if (!counts) return "";
  return Object.entries(counts)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([k, v]) => `${k} (${v.toLocaleString("en-US")})`)
    .join(", ");
}

function campaignItem(c: OtaCampaign, at: string): OpsItem | null {
  const failed = c.waves.reduce((s, w) => s + w.failed, 0);
  const done = c.waves.reduce((s, w) => s + w.succeeded + w.failed, 0);
  const rate = done ? `${Math.round((failed / done) * 1000) / 10}%` : "0%";
  const base = {
    id: `rollout:${c.id}`,
    kind: "rollout" as const,
    count: failed,
    href: `/ota/${c.id}`,
    suggestedAction: { label: "Ask Rollout Guardian", agent: "rollout-guardian" },
    createdAt: at,
  };
  switch (c.status) {
    case "paused":
      return { ...base, severity: "critical", title: `Rollout "${c.name}" is paused`, summary: `${plural(failed, "device")} failed (${rate}); decide to resume or roll back.` };
    case "running": {
      const breach = c.waves.some((w) => w.status === "running" && ["pause", "rollback"].includes(evaluateWave(w, c.healthGate, 100)));
      if (!breach) return null;
      return { ...base, severity: "critical", title: `Rollout "${c.name}" is breaching its health gate`, summary: `Failure rate ${rate} exceeds the ${c.healthGate.maxFailureRate * 100}% gate while still running.` };
    }
    case "rolled_back":
    case "failed":
      return { ...base, severity: "warning", title: `Rollout "${c.name}" ${c.status === "failed" ? "failed" : "was rolled back"}`, summary: `${plural(failed, "device")} failed; review root cause before retrying.`, suggestedAction: { label: "Investigate with Rollout Guardian", agent: "rollout-guardian" } };
    default:
      return null;
  }
}

/** Ranked "what needs attention now" list: severity first, then impact (count), then id. */
export function buildOpsInbox(s: OpsSnapshot, now: Date): OpsItem[] {
  const at = now.toISOString();
  const items: OpsItem[] = [];

  for (const c of s.campaigns) {
    const it = campaignItem(c, at);
    if (it) items.push(it);
  }

  if (s.unknownPayloadCount > 0) {
    const codecs = top(s.unknownByCodec);
    items.push({
      id: "unknown_payloads",
      kind: "unknown_payloads",
      severity: s.unknownPayloadCount >= INBOX_THRESHOLDS.unknownPayloadsCritical ? "critical" : "warning",
      title: `${plural(s.unknownPayloadCount, "unknown payload")} could not be decoded`,
      summary: codecs ? `Top codecs: ${codecs}.` : "Payloads did not match any published codec message.",
      count: s.unknownPayloadCount,
      href: "/payloads/unknown",
      suggestedAction: { label: "Triage with Payload Triage", agent: "payload-triage" },
      createdAt: at,
    });
  }

  if (s.offlineDevices.count > 0) {
    const models = top(s.offlineDevices.byModel);
    items.push({
      id: "offline_cohort",
      kind: "offline_cohort",
      severity: s.offlineDevices.count >= INBOX_THRESHOLDS.offlineCritical ? "critical" : "warning",
      title: `${plural(s.offlineDevices.count, "device")} offline`,
      summary: models ? `Most affected models: ${models}.` : "Devices silent for more than 3× their reporting interval.",
      count: s.offlineDevices.count,
      href: "/fleet?connectivity=offline",
      suggestedAction: { label: "Ask Anomaly Sentinel", agent: "anomaly-sentinel" },
      createdAt: at,
    });
  }

  if ((s.expiringCerts ?? 0) > 0) {
    items.push({
      id: "cert_expiry",
      kind: "cert_expiry",
      severity: "warning",
      title: `${plural(s.expiringCerts!, "device certificate")} expiring soon`,
      summary: "Rotate certificates before devices lose connectivity.",
      count: s.expiringCerts!,
      href: "/fleet?cert=expiring",
      suggestedAction: { label: "Plan rotation with Fleet Copilot", agent: "fleet-copilot" },
      createdAt: at,
    });
  }

  if ((s.pendingSpecReviews ?? 0) > 0) {
    items.push({
      id: "spec_review",
      kind: "spec_review",
      severity: "info",
      title: `${plural(s.pendingSpecReviews!, "spec import")} awaiting review`,
      summary: "Draft codecs extracted from OEM specs need human approval before publishing.",
      count: s.pendingSpecReviews!,
      href: "/spec-imports",
      suggestedAction: { label: "Ask Codec Verifier", agent: "codec-verifier" },
      createdAt: at,
    });
  }

  const bySeverity = new Map<Severity, Alert[]>();
  for (const a of s.openAlerts) {
    if (a.status !== "open") continue;
    const list = bySeverity.get(a.severity) ?? [];
    list.push(a);
    bySeverity.set(a.severity, list);
  }
  for (const [severity, alerts] of bySeverity) {
    alerts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const titles = [...new Set(alerts.map((a) => a.title))].slice(0, 3).join("; ");
    items.push({
      id: `alerts:${severity}`,
      kind: "alert",
      severity,
      title: `${plural(alerts.length, `${severity} alert`)} open`,
      summary: titles,
      count: alerts.length,
      href: "/alerts",
      suggestedAction: { label: "Ask Anomaly Sentinel", agent: "anomaly-sentinel" },
      createdAt: at,
    });
  }

  if ((s.driftedConfigs ?? 0) > 0) {
    items.push({
      id: "config_drift",
      kind: "config_drift",
      severity: "info",
      title: `${plural(s.driftedConfigs!, "device")} with config drift`,
      summary: "Reported configuration differs from desired; re-push or accept reported values.",
      count: s.driftedConfigs!,
      href: "/fleet?drift=1",
      suggestedAction: { label: "Ask Fleet Copilot", agent: "fleet-copilot" },
      createdAt: at,
    });
  }

  return items.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.count ?? 0) - (a.count ?? 0) || a.id.localeCompare(b.id),
  );
}
