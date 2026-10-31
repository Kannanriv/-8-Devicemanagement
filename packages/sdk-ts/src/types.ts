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

export type LifecycleState =
  | "manufactured"
  | "provisioned"
  | "in_stock"
  | "transferred"
  | "installed"
  | "active"
  | "maintenance"
  | "suspended"
  | "retired";

export const LIFECYCLE_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  manufactured: ["provisioned", "retired"],
  provisioned: ["in_stock", "transferred", "installed", "retired"],
  in_stock: ["transferred", "installed", "retired"],
  transferred: ["in_stock", "installed", "retired"],
  installed: ["active", "maintenance", "retired"],
  active: ["maintenance", "suspended", "retired"],
  maintenance: ["active", "retired"],
  suspended: ["active", "retired"],
  retired: [],
};

export type Connectivity = "online" | "offline" | "never_seen";

export interface DeviceHealth {
  score: number; // 0..100
  connectivity: Connectivity;
  lastSeenAt?: string;
  battery?: number; // %
  signal?: number; // dBm / RSSI
  msgRatePerHour?: number;
  issues: string[];
}

export interface Device {
  id: string;
  tenantId: string; // current owner
  oemTenantId: string; // manufacturer
  modelId: string;
  serial: string;
  imei?: string;
  iccid?: string;
  name?: string;
  batchId?: string;
  lifecycle: LifecycleState;
  firmwareVersion?: string;
  codecId?: string;
  codecVersion?: string;
  tags: string[];
  site?: { name: string; lat?: number; lng?: number };
  health: DeviceHealth;
  /** Latest decoded values (device shadow, reported). */
  shadow: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
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

export type TimelineKind = "message" | "lifecycle" | "command" | "config" | "ota" | "alert" | "audit";
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
  severity: Severity;
  title: string;
  detail?: string;
  status: "open" | "acknowledged" | "resolved";
  source: string; // "automation:<id>" | "health" | "agent:<name>" | ...
  createdAt: string;
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
  kind: "rollout" | "unknown_payloads" | "offline_cohort" | "cert_expiry" | "spec_review" | "alert" | "config_drift";
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
  modelId?: string;
  lifecycle?: LifecycleState;
  connectivity?: Connectivity;
  tag?: string;
  firmwareVersion?: string;
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
