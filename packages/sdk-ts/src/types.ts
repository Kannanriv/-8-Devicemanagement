/**
 * Domain contract shared by apps/api (implements) and apps/console (consumes).
 * All timestamps are ISO-8601 strings. All lists are paginated with `Page<T>`.
 */

export interface Page<T> {
  items: T[];
  total: number;
  cursor?: string;
}

// ── Tenancy ────────────────────────────────────────────────────────────────
export type TenantKind = "oem" | "solution" | "customer";
export interface Tenant {
  id: string;
  name: string;
  kind: TenantKind;
  parentId?: string;
  createdAt: string;
}

// ── Inventory ──────────────────────────────────────────────────────────────
export interface DeviceModel {
  id: string;
  tenantId: string; // owning OEM
  vendor: string;
  name: string;
  category: string; // "tracker" | "energy-meter" | "environment" | ...
  protocols: string[];
  codecId?: string; // DCS id
  imageUrl?: string;
  createdAt: string;
}

/**
 * Lifecycle is ONE of three independent state axes (lifecycle ≠ connectivity ≠ health).
 * Inventory → Assigned → Installation in progress → Pending activation → Activated,
 * with controlled Maintenance / Suspended / Swap states, and Retired (history retained).
 */
export type LifecycleState =
  | "registered" // in inventory, available
  | "assigned" // linked to a deployment / asset
  | "installing" // installation app workflow in progress
  | "pending_activation" // provisioning / SIM / connectivity readiness
  | "activated" // commissioned, operationally ready
  | "maintenance"
  | "suspended"
  | "swap" // being replaced by another device on the same asset
  | "retired"; // decommissioned, records retained

export const LIFECYCLE_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  registered: ["assigned", "retired"],
  assigned: ["installing", "registered", "retired"],
  installing: ["pending_activation", "assigned", "retired"],
  pending_activation: ["activated", "installing", "retired"],
  activated: ["maintenance", "suspended", "swap", "retired"],
  maintenance: ["activated", "swap", "retired"],
  suspended: ["activated", "retired"],
  swap: ["registered", "activated", "retired"],
  retired: [],
};

export const LIFECYCLE_LABELS: Record<LifecycleState, string> = {
  registered: "Registered",
  assigned: "Assigned",
  installing: "Installation in progress",
  pending_activation: "Pending activation",
  activated: "Activated",
  maintenance: "Maintenance",
  suspended: "Suspended",
  swap: "Swap",
  retired: "Retired",
};

/** Factory/provisioning status — orthogonal to lifecycle (OEM side). */
export type ProvisioningStatus = "unprovisioned" | "flashed" | "provisioned";

/**
 * online: seen within expected interval; stale: seen, but telemetry older than expected (1×–3× interval);
 * offline: > 3× interval; never_seen: never communicated (not commissioned).
 */
export type Connectivity = "online" | "stale" | "offline" | "never_seen";

export type HealthLevel = "normal" | "warning" | "critical";

export interface DeviceHealth {
  score: number; // 0..100
  level: HealthLevel;
  connectivity: Connectivity;
  lastSeenAt?: string;
  lastHeartbeatAt?: string;
  /** Age in seconds of the newest telemetry value. */
  dataFreshnessSec?: number;
  battery?: number; // %
  signal?: number; // dBm / RSSI
  gps?: { lat: number; lng: number; at: string; fix: boolean };
  engineHours?: number;
  msgRatePerHour?: number;
  issues: string[];
}

export type SimStatus = "inactive" | "active" | "suspended" | "terminated" | "unknown";
export interface SimInfo {
  iccid: string;
  imsi?: string;
  msisdn?: string;
  carrier: string;
  status: SimStatus;
  plan?: string;
  usageMbMonth?: number;
  planLimitMb?: number;
  activatedAt?: string;
  /** Deep link into #8 SIM Management. */
  externalUrl?: string;
}

export type CredentialStatus = "active" | "expiring" | "expired" | "revoked";
export interface DeviceCredential {
  id: string;
  deviceId: string;
  kind: "x509" | "psk" | "token";
  fingerprint: string;
  subject?: string;
  issuedAt: string;
  expiresAt?: string;
  status: CredentialStatus;
  revokedAt?: string;
  revokedReason?: string;
}

export interface Device {
  id: string;
  /** Unique device identifier shown to operators. */
  udi: string;
  tenantId: string; // current owner
  oemTenantId: string; // manufacturer
  oem: string; // manufacturer display name
  modelId: string;
  model: string; // model display name
  serial: string;
  imei?: string;
  name?: string;
  organization?: string; // customer organization
  branch?: string;
  batchId?: string;
  lifecycle: LifecycleState;
  provisioning: ProvisioningStatus;
  firmwareVersion?: string;
  /** Set while an OTA campaign targets this device. */
  otaStatus?: "pending" | "downloading" | "installing" | "succeeded" | "failed" | "rolled_back";
  codecId?: string;
  codecVersion?: string;
  configProfileId?: string;
  configVersion?: number;
  assetId?: string;
  assetName?: string;
  sim?: SimInfo;
  tags: string[];
  site?: { name: string; lat?: number; lng?: number };
  installedAt?: string;
  activatedAt?: string;
  health: DeviceHealth;
  /** Latest decoded values (device shadow, reported). */
  shadow: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Inventory KPI cards. Lifecycle counts and connectivity counts are separate axes; `attentionRequired` may overlap and is labelled so. */
export interface InventoryKpis {
  total: number;
  connected: number; // connectivity=online among activated
  stale: number; // connectivity=stale among activated
  offline: number; // connectivity=offline among activated
  notCommissioned: number; // never_seen
  attentionRequired: number; // health=critical|warning OR open critical alert (overlapping)
  pendingInstallation: number; // lifecycle=assigned|installing
  activationInProgress: number; // lifecycle=pending_activation
  otaInProgress: number; // otaStatus in pending|downloading|installing
  suspended: number;
  retired: number;
}

// ── Assets (device ↔ asset association) ────────────────────────────────────
export interface Asset {
  id: string;
  tenantId: string;
  name: string;
  type: string; // "excavator" | "generator" | "truck" | "cold-room" | "meter-point" ...
  make?: string;
  model?: string;
  serial?: string;
  organization?: string;
  branch?: string;
  site?: { name: string; lat?: number; lng?: number };
  deviceIds: string[];
  createdAt: string;
}
export interface AssetAssociation {
  id: string;
  assetId: string;
  deviceId: string;
  role: "primary" | "secondary";
  from: string;
  to?: string; // open = current
  reason?: "install" | "swap" | "reassign" | "remove";
  actor: string;
}

// ── Bulk operations (eligibility preview → confirm → progress → per-device result) ──
export type BulkOp =
  | "assign"
  | "lifecycle"
  | "apply_config"
  | "start_ota"
  | "suspend"
  | "reactivate"
  | "diagnostics"
  | "command"
  | "tag"
  | "transfer"
  | "export";
export interface BulkPreview {
  op: BulkOp;
  eligible: string[];
  ineligible: { deviceId: string; reason: string }[];
  requiresPermission?: string;
  warnings: string[];
}
export interface BulkJob {
  id: string;
  op: BulkOp;
  params: Record<string, unknown>;
  status: "running" | "completed" | "completed_with_errors" | "failed";
  total: number;
  succeeded: number;
  failed: number;
  results: { deviceId: string; ok: boolean; error?: string }[];
  actor: string;
  createdAt: string;
  updatedAt: string;
}

// ── Reports ────────────────────────────────────────────────────────────────
export interface FleetReport {
  period: { from: string; to: string };
  reliability: { uptimePct: number; mtbfHours?: number; series: { at: string; onlinePct: number }[] };
  deployment: { installs: number; successRate: number; avgActivationHours: number };
  ota: { campaigns: number; successRate: number; rollbacks: number };
  failures: { byCause: Record<string, number>; byModel: Record<string, number> };
  connectivity: { avgSignal?: number; dataUsageMb: number; byCarrier: Record<string, number> };
  utilization: { messages: number; decodeRate: number; activeDevicesPct: number };
}

export interface Batch {
  id: string;
  tenantId: string;
  modelId: string;
  name: string;
  quantity: number;
  firmwareId?: string;
  createdAt: string;
}

// ── Codecs ─────────────────────────────────────────────────────────────────
export type CodecStatus = "draft" | "in_review" | "published" | "deprecated";
export interface CodecVersionSummary {
  codecId: string;
  version: string;
  status: CodecStatus;
  vendor: string;
  model: string;
  messageCount: number;
  fieldCount: number;
  vectorsPassed: number;
  vectorsTotal: number;
  createdAt: string;
  publishedAt?: string;
}

export interface SpecImportJob {
  id: string;
  fileName: string;
  status: "parsing" | "extracting" | "review" | "failed" | "published";
  codecId?: string;
  draftVersion?: string;
  confidence?: number; // mean field confidence
  issues: string[];
  createdAt: string;
}

export type PluginTarget = "ts" | "ts013" | "python" | "go" | "java" | "c";

// ── Messages / history ─────────────────────────────────────────────────────
export interface DeviceMessage {
  id: string;
  deviceId: string;
  receivedAt: string;
  transport: string;
  port?: number;
  topic?: string;
  payloadHex: string;
  status: "decoded" | "unknown" | "error";
  message?: string;
  data?: Record<string, unknown>;
  warnings: string[];
  errors?: string[];
  codecVersion?: string;
}

export type TimelineKind = "message" | "lifecycle" | "command" | "config" | "ota" | "alert" | "audit" | "association" | "ownership" | "technician" | "security";
export interface TimelineEvent {
  id: string;
  deviceId: string;
  at: string;
  kind: TimelineKind;
  title: string;
  detail?: Record<string, unknown>;
}

// ── Configuration ──────────────────────────────────────────────────────────
export interface ConfigTemplate {
  id: string;
  tenantId: string;
  modelId: string;
  name: string;
  version: number;
  values: Record<string, unknown>;
  createdAt: string;
}
export interface DeviceConfig {
  deviceId: string;
  desired: Record<string, unknown>;
  reported: Record<string, unknown>;
  drift: string[]; // keys where desired != reported
  templateId?: string;
  updatedAt: string;
}

// ── Commands & diagnostics ─────────────────────────────────────────────────
export type CommandStatus = "queued" | "sent" | "acked" | "failed" | "timeout" | "cancelled";
export interface Command {
  id: string;
  deviceId: string;
  message: string; // DCS downlink message name
  data: Record<string, unknown>;
  payloadHex?: string;
  port?: number;
  status: CommandStatus;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

// ── Firmware & OTA ─────────────────────────────────────────────────────────
export interface Firmware {
  id: string;
  tenantId: string;
  modelId: string;
  version: string;
  sizeBytes: number;
  sha256: string;
  signature: string; // ed25519, base64
  codecVersion?: string; // codec required by this firmware
  releaseNotes?: string;
  createdAt: string;
}

export type CampaignStatus = "draft" | "running" | "paused" | "completed" | "rolled_back" | "failed";
export interface RolloutWave {
  name: string; // "canary", "10%", ...
  percent: number;
  status: "pending" | "running" | "passed" | "failed";
  targeted: number;
  succeeded: number;
  failed: number;
}
export interface OtaCampaign {
  id: string;
  tenantId: string;
  name: string;
  firmwareId: string;
  fromVersions: string[];
  cohort: DeviceQuery;
  status: CampaignStatus;
  waves: RolloutWave[];
  healthGate: { maxFailureRate: number; minHealthScore: number };
  createdAt: string;
  updatedAt: string;
}

// ── Monitoring / alerts / automations ──────────────────────────────────────
export type Severity = "info" | "warning" | "critical";
export interface Alert {
  id: string;
  tenantId: string;
  deviceId?: string;
  assetId?: string;
  severity: Severity;
  category: "device_failure" | "abnormal_telemetry" | "communication_loss" | "security" | "ota" | "other";
  title: string;
  detail?: string;
  status: "open" | "acknowledged" | "resolved";
  source: string; // "automation:<id>" | "health" | "agent:<name>" | ...
  acknowledgedBy?: string;
  resolvedBy?: string;
  resolution?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface Automation {
  id: string;
  tenantId: string;
  name: string;
  enabled: boolean;
  trigger:
    | { type: "message"; codecId?: string; message?: string }
    | { type: "lifecycle"; to: LifecycleState }
    | { type: "offline"; minutes: number }
    | { type: "schedule"; cron: string };
  /** JS-safe expression over `data`, `device` (e.g. "data.temperature > 30"). */
  condition?: string;
  actions: AutomationAction[];
  stats: { runs: number; lastRunAt?: string; failures: number };
  createdAt: string;
}
export type AutomationAction =
  | { type: "alert"; severity: Severity; title: string }
  | { type: "command"; message: string; data: Record<string, unknown> }
  | { type: "webhook"; integrationId: string }
  | { type: "lifecycle"; to: LifecycleState }
  | { type: "tag"; add?: string[]; remove?: string[] };

// ── Integrations ───────────────────────────────────────────────────────────
export type IntegrationKind =
  | "webhook"
  | "hash8-crm"
  | "hash8-ticketing"
  | "hash8-installation"
  | "hash8-sim"
  | "mqtt-bridge"
  | "kafka";
export interface Integration {
  id: string;
  tenantId: string;
  kind: IntegrationKind;
  name: string;
  enabled: boolean;
  events: string[]; // e.g. "message.decoded", "device.lifecycle", "ota.*"
  config: Record<string, unknown>; // url, secretRef, mapping...
  stats: { delivered: number; failed: number; lastDeliveryAt?: string };
  createdAt: string;
}

// ── Audit ──────────────────────────────────────────────────────────────────
export interface AuditEntry {
  id: string;
  tenantId: string;
  at: string;
  actor: string; // "user:<id>" | "agent:<name>" | "system"
  action: string; // "device.lifecycle.update", "ota.campaign.pause", ...
  target: string; // "device:<id>" ...
  detail?: Record<string, unknown>;
}

// ── Ops Inbox ──────────────────────────────────────────────────────────────
export interface OpsItem {
  id: string;
  kind: "rollout" | "unknown_payloads" | "offline_cohort" | "stale_telemetry" | "cert_expiry" | "spec_review" | "alert" | "config_drift" | "pending_activation" | "sim_issue";
  severity: Severity;
  title: string;
  summary: string;
  count?: number;
  href: string; // console route
  suggestedAction?: { label: string; agent?: string };
  createdAt: string;
}

export interface FleetStats {
  devices: number;
  online: number;
  offline: number;
  messages24h: number;
  decodeRate: number; // 0..1
  avgHealth: number;
  activeCampaigns: number;
  openAlerts: number;
}

export interface DeviceQuery {
  q?: string;
  organization?: string;
  branch?: string;
  oem?: string;
  modelId?: string;
  lifecycle?: LifecycleState;
  connectivity?: Connectivity;
  health?: HealthLevel;
  firmwareVersion?: string;
  assetId?: string;
  tag?: string;
  installedFrom?: string;
  installedTo?: string;
  lastSeenBefore?: string;
  lastSeenAfter?: string;
  sort?: "lastSeen" | "health" | "udi" | "installedAt";
  limit?: number;
  cursor?: string;
}

// ── AI agents ──────────────────────────────────────────────────────────────
export type AgentName =
  | "spec-extractor"
  | "codec-verifier"
  | "payload-triage"
  | "rollout-guardian"
  | "fleet-copilot"
  | "anomaly-sentinel"
  | "integration-builder";
export interface AgentRun {
  id: string;
  agent: AgentName;
  status: "running" | "awaiting_approval" | "completed" | "failed";
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  steps: { at: string; agent: AgentName; note: string }[];
  createdAt: string;
}
