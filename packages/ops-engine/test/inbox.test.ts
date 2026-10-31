import { describe, it, expect } from "vitest";
import { buildOpsInbox, type OpsSnapshot } from "../src/index";
import type { Alert } from "@hash8/sdk-ts";
import { makeCampaign, NOW } from "./fixtures";

const empty: OpsSnapshot = { campaigns: [], unknownPayloadCount: 0, offlineDevices: { count: 0 }, openAlerts: [] };
const alert = (over: Partial<Alert>): Alert => ({
  id: "al-1", tenantId: "t-1", severity: "warning", title: "Hot", status: "open", source: "health", createdAt: "2026-10-31T10:00:00Z", ...over,
});

describe("buildOpsInbox", () => {
  it("empty snapshot → empty inbox", () => {
    expect(buildOpsInbox(empty, NOW)).toEqual([]);
  });
  it("paused campaign → critical rollout item for Rollout Guardian", () => {
    const c = makeCampaign({ id: "c-9", name: "fw 2.0", status: "paused" });
    c.waves[0] = { ...c.waves[0]!, status: "running", succeeded: 1, failed: 1 };
    const [item] = buildOpsInbox({ ...empty, campaigns: [c] }, NOW);
    expect(item).toMatchObject({
      kind: "rollout", severity: "critical", href: "/ota/c-9", count: 1,
      suggestedAction: { label: "Ask Rollout Guardian", agent: "rollout-guardian" },
    });
    expect(item!.title).toContain("fw 2.0");
    expect(item!.createdAt).toBe(NOW.toISOString());
  });
  it("running campaign over its failure gate is flagged; healthy running/draft/completed are not", () => {
    const hot = makeCampaign({ id: "hot", status: "running" });
    hot.waves[0] = { ...hot.waves[0]!, status: "running", targeted: 100, succeeded: 90, failed: 10 };
    const fine = makeCampaign({ id: "fine", status: "running" });
    fine.waves[0] = { ...fine.waves[0]!, status: "running", succeeded: 1 };
    const items = buildOpsInbox({ ...empty, campaigns: [hot, fine, makeCampaign({ id: "d" }), makeCampaign({ id: "x", status: "completed" })] }, NOW);
    expect(items.map((i) => i.id)).toEqual(["rollout:hot"]);
    expect(items[0]!.severity).toBe("critical");
  });
  it("rolled back / failed campaigns are warnings", () => {
    const items = buildOpsInbox({ ...empty, campaigns: [makeCampaign({ id: "rb", status: "rolled_back" })] }, NOW);
    expect(items[0]).toMatchObject({ kind: "rollout", severity: "warning", href: "/ota/rb" });
  });
  it("unknown payloads summarise top codecs and suggest payload triage", () => {
    const [item] = buildOpsInbox({ ...empty, unknownPayloadCount: 42, unknownByCodec: { a: 2, b: 30, c: 10 } }, NOW);
    expect(item).toMatchObject({ kind: "unknown_payloads", count: 42, href: "/payloads/unknown", suggestedAction: { agent: "payload-triage" } });
    expect(item!.summary.indexOf("b (30)")).toBeGreaterThan(-1);
    expect(item!.summary.indexOf("b (30)")).toBeLessThan(item!.summary.indexOf("c (10)"));
  });
  it("offline cohort with byModel breakdown", () => {
    const [item] = buildOpsInbox({ ...empty, offlineDevices: { count: 120, byModel: { "m-1": 100, "m-2": 20 } } }, NOW);
    expect(item).toMatchObject({ kind: "offline_cohort", count: 120, href: "/fleet?connectivity=offline" });
    expect(item!.summary).toContain("m-1");
  });
  it("alerts grouped by severity; only open alerts count", () => {
    const items = buildOpsInbox({
      ...empty,
      openAlerts: [
        alert({ id: "1", severity: "critical", title: "Flood sensor wet" }),
        alert({ id: "2", severity: "critical" }),
        alert({ id: "3", severity: "warning" }),
        alert({ id: "4", severity: "critical", status: "resolved" }),
      ],
    }, NOW);
    const crit = items.find((i) => i.id === "alerts:critical")!;
    expect(crit).toMatchObject({ kind: "alert", severity: "critical", count: 2, href: "/alerts" });
    expect(crit.summary).toContain("Flood sensor wet");
    expect(items.find((i) => i.id === "alerts:warning")!.count).toBe(1);
  });
  it("spec reviews, cert expiry, config drift items", () => {
    const items = buildOpsInbox({ ...empty, pendingSpecReviews: 3, expiringCerts: 5, driftedConfigs: 7 }, NOW);
    expect(items.find((i) => i.kind === "spec_review")).toMatchObject({ href: "/spec-imports", count: 3 });
    expect(items.find((i) => i.kind === "cert_expiry")).toMatchObject({ count: 5 });
    expect(items.find((i) => i.kind === "config_drift")).toMatchObject({ href: "/fleet?drift=1", count: 7 });
  });
  it("ranks by severity then impact (count)", () => {
    const items = buildOpsInbox({
      ...empty,
      unknownPayloadCount: 10,
      offlineDevices: { count: 50 },
      driftedConfigs: 900,
      openAlerts: [alert({ severity: "critical" })],
    }, NOW);
    const sev = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1]!;
      const b = items[i]!;
      expect(sev[a.severity] < sev[b.severity] || (a.severity === b.severity && (a.count ?? 0) >= (b.count ?? 0))).toBe(true);
    }
    expect(items[0]!.kind).toBe("alert");
  });
  it("escalates large unknown-payload and offline volumes to critical", () => {
    const items = buildOpsInbox({ ...empty, unknownPayloadCount: 5000, offlineDevices: { count: 10_000 } }, NOW);
    expect(items.every((i) => i.severity === "critical")).toBe(true);
  });
  it("every item has a suggested action and unique id", () => {
    const c = makeCampaign({ status: "paused" });
    const items = buildOpsInbox({
      campaigns: [c], unknownPayloadCount: 1, offlineDevices: { count: 1 }, expiringCerts: 1,
      pendingSpecReviews: 1, openAlerts: [alert({})], driftedConfigs: 1,
    }, NOW);
    expect(items).toHaveLength(7);
    expect(new Set(items.map((i) => i.id)).size).toBe(7);
    for (const i of items) expect(i.suggestedAction?.label).toBeTruthy();
  });
});
