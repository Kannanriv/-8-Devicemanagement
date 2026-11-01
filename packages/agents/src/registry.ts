import type { AgentName, AgentRun } from "@hash8/sdk-ts";
import { z } from "zod";
import type { AgentContext, AgentDef, AgentDeps, AgentRegistry, AgentStep, PendingAction, RunOptions } from "./types";
import { completeJson } from "./llm";
import { specExtractor } from "./agents/spec-extractor";
import { codecVerifier } from "./agents/codec-verifier";
import { payloadTriage } from "./agents/payload-triage";
import { rolloutGuardian } from "./agents/rollout-guardian";
import { fleetCopilot } from "./agents/fleet-copilot";
import { anomalySentinel } from "./agents/anomaly-sentinel";
import { integrationBuilder } from "./agents/integration-builder";

export const AGENTS: AgentDef[] = [
  specExtractor,
  codecVerifier,
  payloadTriage,
  rolloutGuardian,
  fleetCopilot,
  anomalySentinel,
  integrationBuilder,
];

let counter = 0;
const newId = () => `run_${Date.now().toString(36)}_${(++counter).toString(36)}`;
const now = () => new Date().toISOString();

export function createAgentRegistry(deps: AgentDeps): AgentRegistry {
  const byName = new Map(AGENTS.map((a) => [a.name, a]));
  const store = new Map<string, AgentRun>();
  const actors = new Map<string, string>();

  function makeCtx(run: AgentRun, actor: string, opts?: RunOptions, defaultAgent?: AgentName): AgentContext {
    return {
      runId: run.id,
      actor,
      tools: deps.tools,
      ...(deps.llm ? { llm: deps.llm } : {}),
      step(note, agent) {
        const s: AgentStep = { at: now(), agent: agent ?? defaultAgent ?? run.agent, note };
        run.steps.push(s);
        opts?.onStep?.(s);
      },
    };
  }

  async function execute(name: AgentName, input: Record<string, unknown>, run: AgentRun, ctx: AgentContext): Promise<void> {
    const def = byName.get(name);
    if (!def) throw new Error(`unknown agent: ${name}`);
    try {
      const outcome = await def.run(input, ctx);
      run.output = { ...outcome.output };
      if (outcome.pendingAction) {
        run.output.pendingAction = outcome.pendingAction;
        run.status = "awaiting_approval";
        ctx.step(`awaiting approval: ${describeAction(outcome.pendingAction)}`);
      } else run.status = "completed";
    } catch (e) {
      run.status = "failed";
      run.output = { ...(run.output ?? {}), error: (e as Error).message };
      ctx.step(`failed: ${(e as Error).message}`);
    }
  }

  const registry: AgentRegistry = {
    list() {
      return AGENTS.map(({ name, title, description }) => ({ name, title, description }));
    },

    async run(name, input, opts) {
      if (!byName.has(name)) throw new Error(`unknown agent: ${name}`);
      const actor = opts?.actor ?? "system";
      const run: AgentRun = { id: newId(), agent: name, status: "running", input, steps: [], createdAt: now() };
      store.set(run.id, run);
      actors.set(run.id, actor);
      const ctx = makeCtx(run, actor, opts);
      await execute(name, input, run, ctx);
      await safeAudit(deps, "agent.run", `agent:${name}`, { runId: run.id, actor, status: run.status });
      return clone(run);
    },

    async approve(runId) {
      const run = store.get(runId);
      if (!run) throw new Error(`run not found: ${runId}`);
      if (run.status !== "awaiting_approval") throw new Error(`run ${runId} is not awaiting approval (status ${run.status})`);
      const action = run.output?.pendingAction as PendingAction | undefined;
      if (!action) throw new Error(`run ${runId} has no pending action`);
      const actor = actors.get(runId) ?? "system";
      const ctx = makeCtx(run, actor);
      const executed: unknown[] = [];
      try {
        for (const a of flatten(action)) {
          executed.push(await perform(deps, a, run.agent));
          ctx.step(`executed ${describeAction(a)}`);
          await safeAudit(deps, "agent.action.approved", targetOf(a), { runId, actor, action: a });
        }
        run.status = "completed";
        run.output = { ...run.output, executed, approvedAt: now() };
      } catch (e) {
        run.status = "failed";
        run.output = { ...run.output, executed, error: (e as Error).message };
        ctx.step(`approved action failed: ${(e as Error).message}`);
      }
      return clone(run);
    },

    async orchestrate(goal, input = {}, opts) {
      const actor = opts?.actor ?? "system";
      const { plan, reason, routedBy } = await route(goal, input, deps);
      const run: AgentRun = { id: newId(), agent: plan[0]!, status: "running", input: { goal, ...input }, steps: [], createdAt: now() };
      store.set(run.id, run);
      actors.set(run.id, actor);
      const ctx = makeCtx(run, actor, opts);
      ctx.step(`orchestrator: plan ${plan.join(" → ")} (${routedBy}: ${reason})`);
      const results: Record<string, unknown> = {};
      let carry: Record<string, unknown> = { ...input, goal };
      let pending: PendingAction | undefined;
      run.status = "completed";
      for (const name of plan) {
        const child: AgentRun = { ...run, agent: name, steps: run.steps, status: "running" };
        const childCtx = makeCtx(child, actor, opts, name);
        await execute(name, chainInput(name, carry), child, childCtx);
        results[name] = child.output;
        if (child.status === "failed") {
          run.status = "failed";
          break;
        }
        if (child.status === "awaiting_approval") {
          pending = child.output?.pendingAction as PendingAction;
          run.status = "awaiting_approval";
          break;
        }
        carry = { ...carry, ...handoff(name, child.output ?? {}) };
      }
      run.output = { plan, routedBy, reason, results, ...(pending ? { pendingAction: pending } : {}) };
      await safeAudit(deps, "agent.orchestrate", `agent:${plan.join("+")}`, { runId: run.id, actor, goal, status: run.status });
      return clone(run);
    },

    get(runId) {
      const r = store.get(runId);
      return r ? clone(r) : undefined;
    },
    runs() {
      return [...store.values()].map(clone);
    },
  };
  return registry;
}

/** Thin wrapper so callers can depend on an orchestrator object. */
export class Orchestrator {
  constructor(private readonly registry: AgentRegistry) {}
  orchestrate(goal: string, input?: Record<string, unknown>, opts?: RunOptions): Promise<AgentRun> {
    return this.registry.orchestrate(goal, input, opts);
  }
}

// ── routing ───────────────────────────────────────────────────────────────

const AgentNameSchema = z.enum(["spec-extractor", "codec-verifier", "payload-triage", "rollout-guardian", "fleet-copilot", "anomaly-sentinel", "integration-builder"]);
const PlanSchema = z.object({ plan: z.array(AgentNameSchema).min(1).max(4), reason: z.string().optional() });

export function keywordRoute(goal: string, input: Record<string, unknown> = {}): { plan: AgentName[]; reason: string } {
  const g = goal.toLowerCase();
  if (input.xlsxBase64 || input.text || /\b(import|ingest|extract|parse)\b.*\b(spec|excel|xlsx|sheet|workbook)\b|\b(spec|excel|xlsx|sheet)\b.*\b(import|ingest|extract)/.test(g))
    return { plan: ["spec-extractor", "codec-verifier"], reason: "spec import pipeline" };
  if (/\b(verify|validate|test vectors?|conformance|check)\b.*\b(codec|spec|dcs)\b|\b(codec|spec)\b.*\b(verify|validate)/.test(g))
    return { plan: ["codec-verifier"], reason: "codec verification" };
  if (/unknown|undecoded|unrecogni[sz]ed|triage|cannot decode|can't decode|decode fail/.test(g))
    return { plan: ["payload-triage", "codec-verifier"], reason: "unknown payload triage, then verify the patched codec" };
  if (/rollout|campaign|\bota\b|firmware update|canary|wave/.test(g)) return { plan: ["rollout-guardian"], reason: "OTA rollout health" };
  if (/anomal|spike|outlier|unusual|drift|abnormal/.test(g)) return { plan: ["anomaly-sentinel"], reason: "anomaly scan" };
  if (/integrat|crm|billing|meter record|ticket|webhook|map(ping)? .*field|erp/.test(g)) return { plan: ["integration-builder"], reason: "integration mapping" };
  return { plan: ["fleet-copilot"], reason: "general fleet question" };
}

async function route(goal: string, input: Record<string, unknown>, deps: AgentDeps) {
  const fallback = keywordRoute(goal, input);
  if (!deps.llm) return { ...fallback, routedBy: "keywords" };
  const catalogue = AGENTS.map((a) => `- ${a.name}: ${a.description}`).join("\n");
  const r = await completeJson(
    deps.llm,
    {
      tier: "fast",
      maxTokens: 1024,
      system:
        "You route operations goals for an IoT device-management platform to specialist agents. Reply with JSON only: " +
        '{"plan": ["agent-name", ...], "reason": "..."}. Use a chain only when a later agent needs an earlier one\'s output ' +
        "(e.g. spec-extractor then codec-verifier for a spec import).",
      messages: [{ role: "user", content: `Agents:\n${catalogue}\n\nInput keys: ${Object.keys(input).join(", ") || "(none)"}\nGoal: ${goal}` }],
    },
    PlanSchema,
    1,
  );
  if (!r.value) return { ...fallback, routedBy: "keywords" };
  return { plan: r.value.plan as AgentName[], reason: r.value.reason ?? "LLM routing", routedBy: deps.llm.model };
}

function chainInput(name: AgentName, carry: Record<string, unknown>): Record<string, unknown> {
  const goal = String(carry.goal ?? "");
  if (name === "fleet-copilot") return { question: carry.question ?? goal, ...carry };
  return carry;
}

/** What one agent hands to the next in a chain. */
function handoff(name: AgentName, out: Record<string, unknown>): Record<string, unknown> {
  if (name === "spec-extractor") return { spec: out.draft, issues: out.issues, examples: out.examples };
  if (name === "payload-triage") {
    const p = (out.patches as { patchedSpec?: unknown }[] | undefined)?.find((x) => x.patchedSpec);
    return p ? { spec: p.patchedSpec } : {};
  }
  return {};
}

// ── approved actions ──────────────────────────────────────────────────────

function flatten(a: PendingAction): PendingAction[] {
  return a.type === "batch" ? a.actions.flatMap(flatten) : [a];
}

async function perform(deps: AgentDeps, a: PendingAction, agent: AgentName): Promise<unknown> {
  const t = deps.tools;
  switch (a.type) {
    case "pauseCampaign":
      await t.pauseCampaign(a.campaignId, a.reason);
      return { type: a.type, campaignId: a.campaignId };
    case "rollbackCampaign":
      await t.rollbackCampaign(a.campaignId, a.reason);
      return { type: a.type, campaignId: a.campaignId };
    case "sendCommand":
      return { type: a.type, command: await t.sendCommand(a.deviceId, a.message, a.data) };
    case "createAlert":
      return {
        type: a.type,
        alert: await t.createAlert({ severity: a.severity, category: a.category ?? "other", title: a.title, ...(a.detail ? { detail: a.detail } : {}), ...(a.deviceId ? { deviceId: a.deviceId } : {}), source: `agent:${agent}` }),
      };
    case "batch":
      return Promise.all(a.actions.map((x) => perform(deps, x, agent)));
  }
}

export function describeAction(a: PendingAction): string {
  switch (a.type) {
    case "pauseCampaign":
      return `pause campaign ${a.campaignId} — ${a.reason}`;
    case "rollbackCampaign":
      return `roll back campaign ${a.campaignId} — ${a.reason}`;
    case "sendCommand":
      return `send ${a.message} to ${a.deviceId}`;
    case "createAlert":
      return `create ${a.severity} alert "${a.title}"`;
    case "batch":
      return a.actions.map(describeAction).join("; ");
  }
}

function targetOf(a: PendingAction): string {
  if (a.type === "pauseCampaign" || a.type === "rollbackCampaign") return `campaign:${a.campaignId}`;
  if (a.type === "sendCommand") return `device:${a.deviceId}`;
  if (a.type === "createAlert") return a.deviceId ? `device:${a.deviceId}` : "fleet";
  return "batch";
}

async function safeAudit(deps: AgentDeps, action: string, target: string, detail: Record<string, unknown>) {
  try {
    await deps.tools.audit(action, target, detail);
  } catch {
    /* auditing must never break an agent run */
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
