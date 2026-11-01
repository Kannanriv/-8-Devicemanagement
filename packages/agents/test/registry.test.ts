import { describe, it, expect, afterEach, vi } from "vitest";
import { createAgentRegistry, createAnthropicLlm, Orchestrator } from "../src";
import { campaign, device, fakeLlm, fakeTools } from "./fakes";

describe("createAnthropicLlm", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("returns undefined without a key", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(createAnthropicLlm()).toBeUndefined();
  });
  it("returns a client with the default Opus model when a key is given", () => {
    vi.stubEnv("HASH8_AGENT_MODEL", "");
    const llm = createAnthropicLlm("sk-test");
    expect(llm?.model).toBe("claude-opus-5-5");
  });
});

describe("agent registry", () => {
  it("lists the seven agents", () => {
    const { tools } = fakeTools();
    const reg = createAgentRegistry({ tools });
    const names = reg.list().map((a) => a.name);
    expect(names.sort()).toEqual(
      ["anomaly-sentinel", "codec-verifier", "fleet-copilot", "integration-builder", "payload-triage", "rollout-guardian", "spec-extractor"].sort(),
    );
    for (const a of reg.list()) {
      expect(a.title.length).toBeGreaterThan(3);
      expect(a.description.length).toBeGreaterThan(20);
    }
  });

  it("records steps, calls onStep, audits, and returns completed runs", async () => {
    const f = fakeTools({ devices: [device({ id: "d1", health: { score: 50, connectivity: "offline", issues: [] } })] });
    const reg = createAgentRegistry({ tools: f.tools });
    const seen: string[] = [];
    const run = await reg.run("fleet-copilot", { question: "which devices are offline?" }, { actor: "user:alice", onStep: (s) => seen.push(s.note) });
    expect(run.status).toBe("completed");
    expect(run.agent).toBe("fleet-copilot");
    expect(run.steps.length).toBeGreaterThan(0);
    expect(run.steps.every((s) => s.agent === "fleet-copilot")).toBe(true);
    expect(seen).toEqual(run.steps.map((s) => s.note));
    expect(reg.get(run.id)).toEqual(run);
    expect(f.called("audit").some((c) => c.args[0] === "agent.run")).toBe(true);
  });

  it("marks a run failed when the agent throws", async () => {
    const f = fakeTools();
    f.tools.fleetStats = async () => {
      throw new Error("db down");
    };
    const reg = createAgentRegistry({ tools: f.tools });
    const run = await reg.run("fleet-copilot", { question: "fleet stats please" });
    expect(run.status).toBe("failed");
    expect(String(run.output?.error)).toMatch(/db down/);
  });

  it("rejects unknown agents and approving non-pending runs", async () => {
    const reg = createAgentRegistry({ tools: fakeTools().tools });
    await expect(reg.run("nope" as never, {})).rejects.toThrow(/unknown agent/i);
    await expect(reg.approve("missing")).rejects.toThrow(/not found/i);
    const run = await reg.run("fleet-copilot", { question: "stats" });
    await expect(reg.approve(run.id)).rejects.toThrow(/not awaiting approval/i);
  });
});

describe("Orchestrator", () => {
  it("routes rollout goals to rollout-guardian and carries pending approvals", async () => {
    const f = fakeTools({
      campaigns: [
        campaign({
          id: "c1",
          waves: [{ name: "canary", percent: 5, status: "running", targeted: 20, succeeded: 10, failed: 10 }],
        }),
      ],
    });
    const reg = createAgentRegistry({ tools: f.tools });
    const orch = new Orchestrator(reg);
    const run = await orch.orchestrate("Is the firmware rollout c1 healthy? stop it if not");
    expect(run.output?.plan).toEqual(["rollout-guardian"]);
    expect(run.status).toBe("awaiting_approval");
    expect(run.steps.some((s) => s.agent === "rollout-guardian")).toBe(true);
    const approved = await reg.approve(run.id);
    expect(approved.status).toBe("completed");
    expect(f.called("rollbackCampaign").length + f.called("pauseCampaign").length).toBe(1);
  });

  it("uses the LLM router when present and falls back on garbage", async () => {
    const f = fakeTools({ devices: [device({ id: "d1" })] });
    const { llm } = fakeLlm([{ text: '{"plan":["fleet-copilot"],"reason":"question"}' }, { text: "There is 1 device." }]);
    const reg = createAgentRegistry({ tools: f.tools, llm });
    const run = await reg.orchestrate("how big is my fleet?");
    expect(run.output?.plan).toEqual(["fleet-copilot"]);
    expect(run.status).toBe("completed");

    const { llm: bad } = fakeLlm([{ text: "no idea" }, { text: '{"plan":["bogus"]}' }, { text: "x" }]);
    const reg2 = createAgentRegistry({ tools: f.tools, llm: bad });
    const run2 = await reg2.orchestrate("find anomalies in temperature readings", {});
    expect(run2.output?.plan).toEqual(["anomaly-sentinel"]);
  });
});
