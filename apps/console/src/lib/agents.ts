import type { AgentName } from "@hash8/sdk-ts";
import {
  Bot,
  FileSpreadsheet,
  Radar,
  ShieldCheck,
  Sparkles,
  Unplug,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

/** Product copy for the seven agents (the roster itself comes from GET /agents). */
export const AGENT_META: Record<AgentName, { title: string; description: string; icon: LucideIcon }> = {
  "spec-extractor": {
    title: "Spec Extractor",
    description: "Reads OEM Excel specs and drafts a Device Codec Spec with a source trace for every field.",
    icon: FileSpreadsheet,
  },
  "codec-verifier": {
    title: "Codec Verifier",
    description: "Runs test vectors, cross-checks units, scales and enums, and flags anything that won’t round-trip.",
    icon: ShieldCheck,
  },
  "payload-triage": {
    title: "Payload Triage",
    description: "Clusters payloads no codec could decode and proposes the message layout that explains them.",
    icon: Unplug,
  },
  "rollout-guardian": {
    title: "Rollout Guardian",
    description: "Watches OTA waves against the health gate and pauses or rolls back before failures spread.",
    icon: Radar,
  },
  "fleet-copilot": {
    title: "Fleet Copilot",
    description: "Answers questions about your fleet and coordinates the other agents to get work done.",
    icon: Sparkles,
  },
  "anomaly-sentinel": {
    title: "Anomaly Sentinel",
    description: "Learns each cohort’s normal telemetry and raises alerts when devices drift from it.",
    icon: Bot,
  },
  "integration-builder": {
    title: "Integration Builder",
    description: "Maps decoded telemetry to CRM, ticketing and webhook payloads and tests the delivery.",
    icon: Waypoints,
  },
};

export const AGENT_NAMES = Object.keys(AGENT_META) as AgentName[];

export function agentMeta(name: string) {
  return AGENT_META[name as AgentName] ?? { title: name, description: "", icon: Bot };
}

/** Pull a human-readable answer out of an agent run's free-form output. */
export function runText(output: Record<string, unknown> | undefined): string | undefined {
  if (!output) return undefined;
  for (const k of ["answer", "text", "summary", "message", "reply", "result", "prompt", "question"]) {
    const v = output[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}
