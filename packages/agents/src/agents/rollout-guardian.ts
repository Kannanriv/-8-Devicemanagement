import type { OtaCampaign } from "@hash8/sdk-ts";
import type { AgentDef, PendingAction } from "../types";

export interface RolloutDecision {
  campaignId: string;
  name: string;
  decision: "continue" | "pause" | "rollback";
  reasons: string[];
  stats: {
    waves: { name: string; status: string; attempts: number; failed: number; failureRate: number }[];
    overallFailureRate: number;
    cohortDevices: number;
    cohortAvgHealth: number | null;
    cohortOffline: number;
  };
}

export const rolloutGuardian: AgentDef = {
  name: "rollout-guardian",
  title: "Rollout Guardian",
  description:
    "Watches OTA campaign waves against their health gates and recommends continue, pause or rollback with reasons; pause/rollback only execute after a human approves the run.",
  async run(input, ctx) {
    let campaigns: OtaCampaign[];
    if (typeof input.campaignId === "string") {
      const c = await ctx.tools.getCampaign(input.campaignId);
      if (!c) throw new Error(`campaign ${input.campaignId} not found`);
      campaigns = [c];
    } else campaigns = (await ctx.tools.listCampaigns()).filter((c) => c.status === "running");
    ctx.step(`evaluating ${campaigns.length} campaign(s)`);

    const decisions: RolloutDecision[] = [];
    for (const c of campaigns) {
      const d = await evaluate(c, ctx.tools);
      decisions.push(d);
      ctx.step(`${c.id}: ${d.decision.toUpperCase()} — ${d.reasons.join("; ")}`);
    }

    const actions: PendingAction[] = [];
    for (const d of decisions) {
      const c = campaigns.find((x) => x.id === d.campaignId)!;
      const reason = `rollout-guardian: ${d.reasons.join("; ")}`;
      if (d.decision === "rollback" && c.status !== "rolled_back") actions.push({ type: "rollbackCampaign", campaignId: d.campaignId, reason });
      else if (d.decision === "pause" && c.status === "running") actions.push({ type: "pauseCampaign", campaignId: d.campaignId, reason });
    }

    let summary = decisions.map((d) => `${d.name}: ${d.decision} (${d.reasons[0]})`).join(". ") || "No running campaigns.";
    if (ctx.llm && decisions.length) {
      try {
        const r = await ctx.llm.complete({
          tier: "fast",
          maxTokens: 600,
          system: "Summarise OTA rollout health for an operations engineer in 2-3 plain sentences. Do not invent numbers.",
          messages: [{ role: "user", content: JSON.stringify(decisions) }],
        });
        if (r.text.trim()) summary = r.text.trim();
      } catch {
        /* keep deterministic summary */
      }
    }

    const pendingAction: PendingAction | undefined =
      actions.length === 0 ? undefined : actions.length === 1 ? actions[0] : { type: "batch", actions, reason: "rollout-guardian recommendations" };
    return { output: { decisions, summary }, ...(pendingAction ? { pendingAction } : {}) };
  },
};

async function evaluate(c: OtaCampaign, tools: Parameters<AgentDef["run"]>[1]["tools"]): Promise<RolloutDecision> {
  const max = c.healthGate.maxFailureRate;
  const waves = c.waves.map((w) => {
    const attempts = w.succeeded + w.failed;
    return { name: w.name, status: w.status, attempts, failed: w.failed, failureRate: attempts ? round(w.failed / attempts) : 0 };
  });
  const attempts = waves.reduce((n, w) => n + w.attempts, 0);
  const failed = waves.reduce((n, w) => n + w.failed, 0);
  const overall = attempts ? round(failed / attempts) : 0;

  let cohortDevices = 0;
  let avg: number | null = null;
  let offline = 0;
  try {
    const page = await tools.queryDevices({ ...c.cohort, limit: 500 });
    cohortDevices = page.items.length;
    if (cohortDevices) {
      avg = round(page.items.reduce((n, d) => n + d.health.score, 0) / cohortDevices, 1);
      offline = page.items.filter((d) => d.health.connectivity === "offline").length;
    }
  } catch {
    /* cohort health is advisory */
  }

  const reasons: string[] = [];
  let decision: RolloutDecision["decision"] = "continue";
  const canary = waves[0];
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  if (canary && canary.attempts > 0 && (canary.failureRate > 3 * max || (canary.status === "failed" && canary.failureRate >= 0.5))) {
    decision = "rollback";
    reasons.push(`canary wave "${canary.name}" failure rate ${pct(canary.failureRate)} is far above the ${pct(max)} gate`);
  } else if (attempts > 0 && overall > 3 * max) {
    decision = "rollback";
    reasons.push(`overall failure rate ${pct(overall)} exceeds 3× the ${pct(max)} gate`);
  }
  if (decision !== "rollback") {
    for (const w of waves)
      if (w.attempts > 0 && w.failureRate > max) {
        decision = "pause";
        reasons.push(`wave "${w.name}" failure rate ${pct(w.failureRate)} exceeds the ${pct(max)} gate (${w.failed}/${w.attempts})`);
      }
    if (avg !== null && avg < c.healthGate.minHealthScore) {
      decision = "pause";
      reasons.push(`cohort average health ${avg} is below the minimum ${c.healthGate.minHealthScore}`);
    }
    if (cohortDevices >= 5 && offline / cohortDevices > 0.3) {
      decision = "pause";
      reasons.push(`${offline}/${cohortDevices} cohort devices are offline`);
    }
  }
  if (!reasons.length) reasons.push(attempts ? `failure rate ${pct(overall)} within the ${pct(max)} gate${avg !== null ? `, cohort health ${avg}` : ""}` : "no update attempts yet");
  return { campaignId: c.id, name: c.name, decision, reasons, stats: { waves, overallFailureRate: overall, cohortDevices, cohortAvgHealth: avg, cohortOffline: offline } };
}

function round(n: number, d = 4): number {
  return Number(n.toFixed(d));
}
