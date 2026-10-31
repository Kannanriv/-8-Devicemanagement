import { describe, it, expect } from "vitest";
import {
  DEFAULT_WAVES, planWaves, evaluateWave, campaignReducer, checkCompatibility, preflight,
  compareSemver, satisfiesRange, OpsError,
} from "../src/index";
import type { RolloutWave } from "@hash8/sdk-ts";
import { makeCampaign, makeDevice, NOW } from "./fixtures";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `dev-${i}`);

describe("planWaves", () => {
  it("DEFAULT_WAVES is canary/10/50/100", () => {
    expect(DEFAULT_WAVES.map((w) => w.percent)).toEqual([1, 10, 50, 100]);
    expect(DEFAULT_WAVES[0]!.name).toBe("canary");
  });
  it("uses cumulative percents and assigns every device exactly once", () => {
    const { waves, assignments } = planWaves(ids(1000), DEFAULT_WAVES, "seed");
    expect(waves.map((w) => w.targeted)).toEqual([10, 90, 400, 500]);
    expect(Object.keys(assignments)).toHaveLength(1000);
    const counts = [0, 0, 0, 0];
    for (const w of Object.values(assignments)) counts[w]!++;
    expect(counts).toEqual([10, 90, 400, 500]);
  });
  it("initialises waves as pending with zero counts", () => {
    const { waves } = planWaves(ids(10), DEFAULT_WAVES, "s");
    for (const w of waves) expect(w).toMatchObject({ status: "pending", succeeded: 0, failed: 0 });
    expect(waves.map((w) => w.name)).toEqual(["canary", "10%", "50%", "100%"]);
  });
  it("canary gets at least one device even in tiny fleets", () => {
    const { waves } = planWaves(ids(5), DEFAULT_WAVES, "s");
    expect(waves[0]!.targeted).toBe(1);
    expect(waves.reduce((a, w) => a + w.targeted, 0)).toBe(5);
  });
  it("is deterministic for the same seed and input order independent", () => {
    const a = planWaves(ids(200), DEFAULT_WAVES, "abc").assignments;
    const b = planWaves([...ids(200)].reverse(), DEFAULT_WAVES, "abc").assignments;
    expect(a).toEqual(b);
  });
  it("different seeds pick different canaries", () => {
    const canary = (seed: string) => Object.entries(planWaves(ids(500), DEFAULT_WAVES, seed).assignments).filter(([, w]) => w === 0).map(([d]) => d).sort();
    expect(canary("one")).not.toEqual(canary("two"));
  });
  it("deduplicates device ids", () => {
    const { waves } = planWaves(["a", "a", "b"], DEFAULT_WAVES, "s");
    expect(waves.reduce((s, w) => s + w.targeted, 0)).toBe(2);
  });
  it("handles an empty fleet", () => {
    const { waves, assignments } = planWaves([], DEFAULT_WAVES, "s");
    expect(waves.every((w) => w.targeted === 0)).toBe(true);
    expect(assignments).toEqual({});
  });
  it("leaves devices unassigned when the last wave is below 100%", () => {
    const { assignments } = planWaves(ids(100), [{ name: "a", percent: 5 }, { name: "b", percent: 20 }], "s");
    expect(Object.keys(assignments)).toHaveLength(20);
  });
  it("rejects non-ascending or out-of-range percents", () => {
    expect(() => planWaves(ids(10), [{ name: "a", percent: 50 }, { name: "b", percent: 10 }], "s")).toThrow(OpsError);
    expect(() => planWaves(ids(10), [{ name: "a", percent: 0 }], "s")).toThrow(OpsError);
    expect(() => planWaves(ids(10), [{ name: "a", percent: 101 }], "s")).toThrow(OpsError);
    expect(() => planWaves(ids(10), [], "s")).toThrow(OpsError);
  });
});

const wave = (over: Partial<RolloutWave>): RolloutWave => ({ name: "w", percent: 10, status: "running", targeted: 100, succeeded: 0, failed: 0, ...over });
const gate = { maxFailureRate: 0.05, minHealthScore: 60 };

describe("evaluateWave", () => {
  it("continue when complete and healthy", () => {
    expect(evaluateWave(wave({ succeeded: 98, failed: 2 }), gate, 85)).toBe("continue");
  });
  it("wait when incomplete and healthy", () => {
    expect(evaluateWave(wave({ succeeded: 40, failed: 1 }), gate, 85)).toBe("wait");
  });
  it("wait when nothing has reported yet even if fleet health is low", () => {
    expect(evaluateWave(wave({}), gate, 10)).toBe("wait");
  });
  it("pause when failure rate exceeds max", () => {
    expect(evaluateWave(wave({ succeeded: 93, failed: 7 }), gate, 85)).toBe("pause");
  });
  it("rollback when failure rate >= 2x max", () => {
    expect(evaluateWave(wave({ succeeded: 90, failed: 10 }), gate, 85)).toBe("rollback");
    expect(evaluateWave(wave({ succeeded: 5, failed: 5 }), gate, 85)).toBe("rollback");
  });
  it("pause when avg health below min", () => {
    expect(evaluateWave(wave({ succeeded: 100 }), gate, 59)).toBe("pause");
  });
  it("zero-tolerance gate pauses only on actual failures", () => {
    const strict = { maxFailureRate: 0, minHealthScore: 0 };
    expect(evaluateWave(wave({ succeeded: 100 }), strict, 80)).toBe("continue");
    expect(evaluateWave(wave({ succeeded: 99, failed: 1 }), strict, 80)).toBe("rollback");
  });
});

describe("campaignReducer", () => {
  it("start: draft -> running, first wave running", () => {
    const c = campaignReducer(makeCampaign(), { type: "start" }, NOW);
    expect(c.status).toBe("running");
    expect(c.waves[0]!.status).toBe("running");
    expect(c.waves[1]!.status).toBe("pending");
    expect(c.updatedAt).toBe(NOW.toISOString());
  });
  it("does not mutate input", () => {
    const orig = makeCampaign();
    campaignReducer(orig, { type: "start" }, NOW);
    expect(orig.status).toBe("draft");
    expect(orig.waves[0]!.status).toBe("pending");
  });
  it("pause and resume", () => {
    const running = campaignReducer(makeCampaign(), { type: "start" }, NOW);
    const paused = campaignReducer(running, { type: "pause" }, NOW);
    expect(paused.status).toBe("paused");
    expect(campaignReducer(paused, { type: "resume" }, NOW).status).toBe("running");
  });
  it("wave_progress below target only updates counts", () => {
    const running = campaignReducer(makeCampaign(), { type: "start" }, NOW);
    const c = campaignReducer(running, { type: "wave_progress", waveIndex: 0, succeeded: 1, failed: 0 }, NOW);
    expect(c.waves[0]).toMatchObject({ status: "running", succeeded: 1 });
    expect(c.status).toBe("running");
  });
  it("wave_progress completing a healthy wave advances to the next wave", () => {
    const running = campaignReducer(makeCampaign(), { type: "start" }, NOW);
    const c = campaignReducer(running, { type: "wave_progress", waveIndex: 0, succeeded: 2, failed: 0, avgHealth: 90 }, NOW);
    expect(c.waves[0]!.status).toBe("passed");
    expect(c.waves[1]!.status).toBe("running");
    expect(c.status).toBe("running");
  });
  it("completing the last wave completes the campaign", () => {
    let c = campaignReducer(makeCampaign(), { type: "start" }, NOW);
    c = campaignReducer(c, { type: "wave_progress", waveIndex: 0, succeeded: 2, failed: 0 }, NOW);
    c = campaignReducer(c, { type: "wave_progress", waveIndex: 1, succeeded: 10, failed: 0 }, NOW);
    expect(c.status).toBe("completed");
    expect(c.waves.every((w) => w.status === "passed")).toBe(true);
  });
  it("wave_progress far past the gate rolls the campaign back", () => {
    let c = campaignReducer(makeCampaign(), { type: "start" }, NOW);
    c = campaignReducer(c, { type: "wave_progress", waveIndex: 0, succeeded: 2, failed: 0 }, NOW);
    c = campaignReducer(c, { type: "wave_progress", waveIndex: 1, succeeded: 3, failed: 1 }, NOW);
    expect(c.status).toBe("rolled_back");
    expect(c.waves[1]!.status).toBe("failed");
  });
  it("wave_progress just over the gate pauses (wave stays running)", () => {
    const base = makeCampaign();
    base.waves[0]!.targeted = 100;
    let c = campaignReducer(base, { type: "start" }, NOW);
    c = campaignReducer(c, { type: "wave_progress", waveIndex: 0, succeeded: 15, failed: 1 }, NOW);
    expect(c.status).toBe("paused");
    expect(c.waves[0]!.status).toBe("running");
  });
  it("wave_progress is accepted while paused (in-flight devices keep reporting)", () => {
    let c = campaignReducer(makeCampaign(), { type: "start" }, NOW);
    c = campaignReducer(c, { type: "pause" }, NOW);
    c = campaignReducer(c, { type: "wave_progress", waveIndex: 0, succeeded: 2, failed: 0 }, NOW);
    expect(c.status).toBe("paused");
    expect(c.waves[0]!.succeeded).toBe(2);
  });
  it("wave_progress with low health pauses", () => {
    let c = campaignReducer(makeCampaign(), { type: "start" }, NOW);
    c = campaignReducer(c, { type: "wave_progress", waveIndex: 0, succeeded: 1, failed: 0, avgHealth: 20 }, NOW);
    expect(c.status).toBe("paused");
  });
  it("rollback marks the running wave failed", () => {
    const running = campaignReducer(makeCampaign(), { type: "start" }, NOW);
    const c = campaignReducer(running, { type: "rollback" }, NOW);
    expect(c.status).toBe("rolled_back");
    expect(c.waves[0]!.status).toBe("failed");
  });
  it("complete forces completion from running", () => {
    const running = campaignReducer(makeCampaign(), { type: "start" }, NOW);
    const c = campaignReducer(running, { type: "complete" }, NOW);
    expect(c.status).toBe("completed");
    expect(c.waves[0]!.status).toBe("passed");
  });
  it("rejects invalid transitions with INVALID_CAMPAIGN_TRANSITION", () => {
    const draft = makeCampaign();
    for (const ev of [{ type: "pause" }, { type: "resume" }, { type: "complete" }] as const) {
      try {
        campaignReducer(draft, ev, NOW);
        expect.unreachable();
      } catch (e) {
        expect((e as OpsError).code).toBe("INVALID_CAMPAIGN_TRANSITION");
      }
    }
    const done = makeCampaign({ status: "completed" });
    expect(() => campaignReducer(done, { type: "start" }, NOW)).toThrow(OpsError);
    expect(() => campaignReducer(makeCampaign({ status: "rolled_back" }), { type: "resume" }, NOW)).toThrow(OpsError);
  });
  it("rejects progress for an unknown wave index", () => {
    const running = campaignReducer(makeCampaign(), { type: "start" }, NOW);
    expect(() => campaignReducer(running, { type: "wave_progress", waveIndex: 9, succeeded: 1, failed: 0 }, NOW)).toThrow(OpsError);
  });
});

describe("semver", () => {
  it("compares versions", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.10.0", "1.9.9")).toBe(1);
    expect(compareSemver("v2.0.0", "10.0.0")).toBe(-1);
    expect(compareSemver("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
  });
  it.each([
    ["1.2.5", "^1.2.0", true],
    ["2.0.0", "^1.2.0", false],
    ["0.2.5", "^0.2.0", true],
    ["0.3.0", "^0.2.0", false],
    ["1.2.9", "~1.2.0", true],
    ["1.3.0", "~1.2.0", false],
    ["1.4.0", ">=1.2.0 <2.0.0", true],
    ["2.0.0", ">=1.2.0 <2.0.0", false],
    ["1.2.7", "1.2.x", true],
    ["1.3.0", "1.x", true],
    ["3.0.0", "*", true],
    ["1.2.3", "1.2.3", true],
    ["1.2.4", "1.2.3", false],
    ["0.9.0", "1.x || 0.9.x", true],
    ["1.0.0", "=1.0.0", true],
    ["1.0.1", ">1.0.0", true],
    ["1.0.0", "<=1.0.0", true],
  ])("%s satisfies %s -> %s", (v, r, ok) => {
    expect(satisfiesRange(v, r)).toBe(ok);
  });
  it("garbage versions never satisfy", () => {
    expect(satisfiesRange("banana", "*")).toBe(false);
  });
});

describe("checkCompatibility", () => {
  const fw = { version: "1.3.0", codecVersion: "2.0.0" };
  it("ok when device is in range and codec compatible", () => {
    expect(checkCompatibility(fw, { firmwareVersion: "1.2.4", codecVersion: "2.1.0" }, ["^1.2.0"])).toEqual({ ok: true, reasons: [] });
  });
  it("rejects devices outside the source range", () => {
    const r = checkCompatibility(fw, { firmwareVersion: "1.1.0", codecVersion: "2.1.0" }, ["^1.2.0", "1.0.x"]);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain("1.1.0");
  });
  it("empty fromVersions accepts any source version", () => {
    expect(checkCompatibility(fw, { firmwareVersion: "0.1.0", codecVersion: "2.0.0" }, []).ok).toBe(true);
  });
  it("rejects unknown device firmware when ranges given", () => {
    expect(checkCompatibility(fw, { codecVersion: "2.0.0" }, ["^1.0.0"]).ok).toBe(false);
  });
  it("rejects devices already on target and downgrades", () => {
    expect(checkCompatibility(fw, { firmwareVersion: "1.3.0" }, []).reasons.join()).toMatch(/already/i);
    expect(checkCompatibility(fw, { firmwareVersion: "1.4.0" }, []).reasons.join()).toMatch(/downgrade/i);
  });
  it("rejects codec major mismatch", () => {
    const r = checkCompatibility(fw, { firmwareVersion: "1.2.0", codecVersion: "1.9.0" }, []);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/codec/i);
  });
  it("skips codec check when firmware does not require one", () => {
    expect(checkCompatibility({ version: "1.3.0" }, { firmwareVersion: "1.2.0" }, []).ok).toBe(true);
  });
});

describe("preflight", () => {
  it("passes for an online active device with battery", () => {
    expect(preflight(makeDevice())).toEqual({ ok: true, reasons: [] });
  });
  it("passes for installed and mains-powered (no battery) devices", () => {
    expect(preflight(makeDevice({ lifecycle: "installed" }, { battery: undefined })).ok).toBe(true);
  });
  it("fails on low battery, offline, wrong lifecycle with all reasons", () => {
    const r = preflight(makeDevice({ lifecycle: "maintenance" }, { battery: 29, connectivity: "offline" }));
    expect(r.ok).toBe(false);
    expect(r.reasons).toHaveLength(3);
    expect(r.reasons.join(" ")).toMatch(/29%/);
  });
});
