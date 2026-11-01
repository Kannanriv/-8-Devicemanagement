import type { DeviceCodecSpec } from "@hash8/dcs-schema";
import type {
  AgentName,
  AgentRun,
  Alert,
  CodecVersionSummary,
  Command,
  Device,
  DeviceMessage,
  DeviceQuery,
  FleetStats,
  OtaCampaign,
  Page,
  Severity,
} from "@hash8/sdk-ts";
import type { LlmClient } from "./llm";

/** Platform capabilities the agents may use. Implemented by apps/api. */
export interface AgentTools {
  queryDevices(q: DeviceQuery): Promise<Page<Device>>;
  getDevice(id: string): Promise<Device | undefined>;
  getMessages(deviceId: string, limit: number): Promise<DeviceMessage[]>;
  listUnknownPayloads(limit: number): Promise<DeviceMessage[]>;
  getCodec(id: string, version?: string): Promise<DeviceCodecSpec | undefined>;
  listCodecs(): Promise<CodecVersionSummary[]>;
  getCampaign(id: string): Promise<OtaCampaign | undefined>;
  listCampaigns(): Promise<OtaCampaign[]>;
  pauseCampaign(id: string, reason: string): Promise<void>;
  rollbackCampaign(id: string, reason: string): Promise<void>;
  sendCommand(deviceId: string, message: string, data: Record<string, unknown>): Promise<Command>;
  createAlert(a: { severity: Severity; category: Alert["category"]; title: string; detail?: string; deviceId?: string; assetId?: string; source: string }): Promise<Alert>;
  fleetStats(): Promise<FleetStats>;
  audit(action: string, target: string, detail?: Record<string, unknown>): Promise<void>;
}

export interface AgentDeps {
  tools: AgentTools;
  llm?: LlmClient;
}

export type AgentStep = AgentRun["steps"][number];

/** A write action that only runs after a human approves the run. */
export type PendingAction =
  | { type: "pauseCampaign"; campaignId: string; reason: string }
  | { type: "rollbackCampaign"; campaignId: string; reason: string }
  | { type: "sendCommand"; deviceId: string; message: string; data: Record<string, unknown>; reason?: string }
  | { type: "createAlert"; severity: Severity; category?: Alert["category"]; title: string; detail?: string; deviceId?: string; reason?: string }
  | { type: "batch"; actions: PendingAction[]; reason?: string };

export interface RunOptions {
  actor?: string;
  onStep?: (s: AgentStep) => void;
}

export interface AgentContext {
  runId: string;
  actor: string;
  tools: AgentTools;
  llm?: LlmClient;
  step(note: string, agent?: AgentName): void;
}

export interface AgentOutcome {
  output: Record<string, unknown>;
  /** Set to request human approval; the registry stores it as output.pendingAction. */
  pendingAction?: PendingAction;
}

export interface AgentDef {
  name: AgentName;
  title: string;
  description: string;
  run(input: Record<string, unknown>, ctx: AgentContext): Promise<AgentOutcome>;
}

export interface AgentRegistry {
  list(): { name: AgentName; title: string; description: string }[];
  run(name: AgentName, input: Record<string, unknown>, opts?: RunOptions): Promise<AgentRun>;
  approve(runId: string): Promise<AgentRun>;
  /** Route a free-text goal to one agent or a chain of agents. */
  orchestrate(goal: string, input?: Record<string, unknown>, opts?: RunOptions): Promise<AgentRun>;
  get(runId: string): AgentRun | undefined;
  runs(): AgentRun[];
}
