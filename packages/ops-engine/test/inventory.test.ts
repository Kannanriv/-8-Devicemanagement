import { describe, it, expect } from "vitest";
import type { AssetAssociation, BulkOp, DeviceCredential } from "@hash8/sdk-ts";
import { computeInventoryKpis, bulkEligibility, swapAssociation, credentialStatus, OpsError } from "../src/index";
import { makeDevice, NOW } from "./fixtures";

describe("computeInventoryKpis", () => {
  it("empty fleet is all zeros", () => {
    expect(computeInventoryKpis([])).toEqual({
      total: 0, connected: 0, stale: 0, offline: 0, notCommissioned: 0, attentionRequired: 0,
      pendingInstallation: 0, activationInProgress: 0, otaInProgress: 0, suspended: 0, retired: 0,
    });
  });
  it("counts connectivity only among activated devices", () => {
    const k = computeInventoryKpis([
      makeDevice({ id: "a" }, { connectivity: "online" }),
      makeDevice({ id: "b" }, { connectivity: "stale" }),
      makeDevice({ id: "c" }, { connectivity: "offline", level: "critical" }),
      makeDevice({ id: "d", lifecycle: "maintenance" }, { connectivity: "offline" }),
      makeDevice({ id: "e", lifecycle: "suspended" }, { connectivity: "online" }),
    ]);
    expect(k).toMatchObject({ total: 5, connected: 1, stale: 1, offline: 1, suspended: 1 });
  });
  it("counts lifecycle buckets", () => {
    const k = computeInventoryKpis([
      makeDevice({ id: "1", lifecycle: "assigned" }, { connectivity: "never_seen", level: "critical", score: 0 }),
      makeDevice({ id: "2", lifecycle: "installing" }, { connectivity: "never_seen", level: "critical", score: 0 }),
      makeDevice({ id: "3", lifecycle: "pending_activation" }),
      makeDevice({ id: "4", lifecycle: "retired" }, { connectivity: "never_seen", level: "critical" }),
      makeDevice({ id: "5", lifecycle: "registered" }, { connectivity: "never_seen", level: "critical" }),
    ]);
    expect(k).toMatchObject({ pendingInstallation: 2, activationInProgress: 1, retired: 1, notCommissioned: 3 });
  });
  it("never-seen and retired devices do not count as attention-required by health alone", () => {
    const k = computeInventoryKpis([
      makeDevice({ id: "1", lifecycle: "registered" }, { connectivity: "never_seen", level: "critical", score: 0 }),
      makeDevice({ id: "2", lifecycle: "retired" }, { connectivity: "offline", level: "critical" }),
    ]);
    expect(k.attentionRequired).toBe(0);
  });
  it("attentionRequired = warning|critical health OR open critical alert, deduplicated", () => {
    const k = computeInventoryKpis(
      [
        makeDevice({ id: "w" }, { level: "warning" }),
        makeDevice({ id: "c" }, { level: "critical" }),
        makeDevice({ id: "ok" }),
        makeDevice({ id: "both" }, { level: "critical" }),
      ],
      new Set(["ok", "both", "not-in-list"]),
    );
    expect(k.attentionRequired).toBe(4);
  });
  it("counts OTA in progress (pending|downloading|installing only)", () => {
    const k = computeInventoryKpis([
      makeDevice({ id: "1", otaStatus: "pending" }),
      makeDevice({ id: "2", otaStatus: "downloading" }),
      makeDevice({ id: "3", otaStatus: "installing" }),
      makeDevice({ id: "4", otaStatus: "succeeded" }),
      makeDevice({ id: "5", otaStatus: "failed" }),
    ]);
    expect(k.otaInProgress).toBe(3);
  });
});

describe("bulkEligibility", () => {
  const ok = { eligible: true };
  it("suspend only from activated", () => {
    expect(bulkEligibility("suspend", makeDevice(), {})).toEqual(ok);
    const r = bulkEligibility("suspend", makeDevice({ lifecycle: "maintenance" }), {});
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/maintenance/i);
  });
  it("reactivate only from suspended", () => {
    expect(bulkEligibility("reactivate", makeDevice({ lifecycle: "suspended" }), {})).toEqual(ok);
    expect(bulkEligibility("reactivate", makeDevice(), {}).eligible).toBe(false);
  });
  it("start_ota needs activated + preflight", () => {
    expect(bulkEligibility("start_ota", makeDevice(), {})).toEqual(ok);
    expect(bulkEligibility("start_ota", makeDevice({}, { battery: 10 }), {}).reason).toMatch(/battery/i);
    expect(bulkEligibility("start_ota", makeDevice({}, { connectivity: "offline" }), {}).eligible).toBe(false);
    expect(bulkEligibility("start_ota", makeDevice({ lifecycle: "maintenance" }), {}).eligible).toBe(false);
  });
  it("start_ota rejects devices already in an OTA", () => {
    expect(bulkEligibility("start_ota", makeDevice({ otaStatus: "downloading" }), {}).reason).toMatch(/OTA/);
    expect(bulkEligibility("start_ota", makeDevice({ otaStatus: "succeeded" }), {})).toEqual(ok);
  });
  it("start_ota checks firmware compatibility when given", () => {
    const params = { firmware: { version: "1.3.0" }, fromVersions: ["^1.2.0"] };
    expect(bulkEligibility("start_ota", makeDevice({ firmwareVersion: "1.2.1" }), params)).toEqual(ok);
    expect(bulkEligibility("start_ota", makeDevice({ firmwareVersion: "1.3.0" }), params).reason).toMatch(/already/i);
  });
  it("assign only from registered or assigned", () => {
    expect(bulkEligibility("assign", makeDevice({ lifecycle: "registered" }), { assetId: "as-1" })).toEqual(ok);
    expect(bulkEligibility("assign", makeDevice({ lifecycle: "assigned" }), { assetId: "as-1" })).toEqual(ok);
    expect(bulkEligibility("assign", makeDevice(), { assetId: "as-1" }).eligible).toBe(false);
  });
  it("apply_config on anything but retired", () => {
    expect(bulkEligibility("apply_config", makeDevice({ lifecycle: "installing" }), {})).toEqual(ok);
    expect(bulkEligibility("apply_config", makeDevice({ lifecycle: "retired" }), {}).eligible).toBe(false);
  });
  it("lifecycle uses the transition table and requires params.to", () => {
    expect(bulkEligibility("lifecycle", makeDevice(), { to: "maintenance" })).toEqual(ok);
    expect(bulkEligibility("lifecycle", makeDevice({ lifecycle: "registered" }), { to: "activated" }).reason).toMatch(/registered/);
    expect(bulkEligibility("lifecycle", makeDevice(), {}).reason).toMatch(/to/);
  });
  it("command requires a message and an operational lifecycle", () => {
    expect(bulkEligibility("command", makeDevice(), { message: "reboot" })).toEqual(ok);
    expect(bulkEligibility("command", makeDevice(), {}).eligible).toBe(false);
    expect(bulkEligibility("command", makeDevice({ lifecycle: "suspended" }), { message: "reboot" }).eligible).toBe(false);
    expect(bulkEligibility("command", makeDevice({ lifecycle: "retired" }), { message: "reboot" }).eligible).toBe(false);
  });
  it("diagnostics needs a device that has communicated and is not retired", () => {
    expect(bulkEligibility("diagnostics", makeDevice({ lifecycle: "maintenance" }), {})).toEqual(ok);
    expect(bulkEligibility("diagnostics", makeDevice({}, { connectivity: "never_seen" }), {}).eligible).toBe(false);
    expect(bulkEligibility("diagnostics", makeDevice({ lifecycle: "retired" }), {}).eligible).toBe(false);
  });
  it("transfer requires a different target tenant and a settled device", () => {
    expect(bulkEligibility("transfer", makeDevice(), { tenantId: "t-2" })).toEqual(ok);
    expect(bulkEligibility("transfer", makeDevice(), { tenantId: "t-1" }).reason).toMatch(/already/i);
    expect(bulkEligibility("transfer", makeDevice(), {}).eligible).toBe(false);
    expect(bulkEligibility("transfer", makeDevice({ lifecycle: "installing" }), { tenantId: "t-2" }).eligible).toBe(false);
    expect(bulkEligibility("transfer", makeDevice({ lifecycle: "retired" }), { tenantId: "t-2" }).eligible).toBe(false);
  });
  it("tag and export are always eligible", () => {
    expect(bulkEligibility("tag", makeDevice({ lifecycle: "retired" }), { add: ["x"] })).toEqual(ok);
    expect(bulkEligibility("export", makeDevice({ lifecycle: "retired" }), {})).toEqual(ok);
  });
  it("unknown op is ineligible, not a throw", () => {
    expect(bulkEligibility("explode" as BulkOp, makeDevice(), {}).eligible).toBe(false);
  });
  it("every BulkOp is handled", () => {
    const ops: BulkOp[] = ["assign", "lifecycle", "apply_config", "start_ota", "suspend", "reactivate", "diagnostics", "command", "tag", "transfer", "export"];
    for (const op of ops) expect(bulkEligibility(op, makeDevice(), {}).reason ?? "").not.toMatch(/unknown operation/i);
  });
});

describe("swapAssociation", () => {
  const current: AssetAssociation = {
    id: "assoc-1", assetId: "as-1", deviceId: "old", role: "primary", from: "2026-01-01T00:00:00.000Z", reason: "install", actor: "user:7",
  };
  it("closes the current association and opens a new one", () => {
    const r = swapAssociation("as-1", "old", "new", "user:9", NOW, current);
    expect(r.closed).toEqual({ ...current, to: NOW.toISOString() });
    expect(r.opened).toMatchObject({ assetId: "as-1", deviceId: "new", role: "primary", from: NOW.toISOString(), reason: "swap", actor: "user:9" });
    expect(r.opened.to).toBeUndefined();
    expect(r.opened.id).not.toBe(r.closed.id);
  });
  it("returns lifecycle targets: old → swap, new → activated", () => {
    const r = swapAssociation("as-1", "old", "new", "user:9", NOW);
    expect(r.lifecycle).toEqual({ old: { deviceId: "old", to: "swap" }, new: { deviceId: "new", to: "activated" } });
  });
  it("synthesises the closed record when the current one is not supplied", () => {
    const r = swapAssociation("as-1", "old", "new", "user:9", NOW);
    expect(r.closed).toMatchObject({ assetId: "as-1", deviceId: "old", to: NOW.toISOString(), actor: "user:9" });
  });
  it("carries the role over from the current association", () => {
    const r = swapAssociation("as-1", "old", "new", "u", NOW, { ...current, role: "secondary" });
    expect(r.opened.role).toBe("secondary");
  });
  it("is deterministic", () => {
    expect(swapAssociation("as-1", "old", "new", "u", NOW)).toEqual(swapAssociation("as-1", "old", "new", "u", NOW));
  });
  it("rejects swapping a device with itself or a mismatched/closed current association", () => {
    expect(() => swapAssociation("as-1", "old", "old", "u", NOW)).toThrow(OpsError);
    expect(() => swapAssociation("as-1", "other", "new", "u", NOW, current)).toThrow(OpsError);
    expect(() => swapAssociation("as-2", "old", "new", "u", NOW, current)).toThrow(OpsError);
    try {
      swapAssociation("as-1", "old", "new", "u", NOW, { ...current, to: "2026-02-01T00:00:00.000Z" });
      expect.unreachable();
    } catch (e) {
      expect((e as OpsError).code).toBe("INVALID_SWAP");
    }
  });
});

describe("credentialStatus", () => {
  const cred = (over: Partial<DeviceCredential>): DeviceCredential => ({
    id: "cr-1", deviceId: "dev-1", kind: "x509", fingerprint: "ab:cd", issuedAt: "2026-01-01T00:00:00.000Z", status: "active", ...over,
  });
  const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();
  it("active when far from expiry or no expiry", () => {
    expect(credentialStatus(cred({ expiresAt: inDays(90) }), NOW)).toBe("active");
    expect(credentialStatus(cred({}), NOW)).toBe("active");
  });
  it("expiring within the window (default 30 days)", () => {
    expect(credentialStatus(cred({ expiresAt: inDays(29) }), NOW)).toBe("expiring");
    expect(credentialStatus(cred({ expiresAt: inDays(30) }), NOW)).toBe("expiring");
    expect(credentialStatus(cred({ expiresAt: inDays(31) }), NOW)).toBe("active");
    expect(credentialStatus(cred({ expiresAt: inDays(31) }), NOW, 60)).toBe("expiring");
  });
  it("expired at or after expiresAt", () => {
    expect(credentialStatus(cred({ expiresAt: inDays(0) }), NOW)).toBe("expired");
    expect(credentialStatus(cred({ expiresAt: inDays(-1) }), NOW)).toBe("expired");
  });
  it("revoked wins over everything", () => {
    expect(credentialStatus(cred({ status: "revoked", expiresAt: inDays(-5) }), NOW)).toBe("revoked");
    expect(credentialStatus(cred({ revokedAt: "2026-05-01T00:00:00.000Z" }), NOW)).toBe("revoked");
  });
  it("recomputes from dates rather than trusting a stored status", () => {
    expect(credentialStatus(cred({ status: "expired", expiresAt: inDays(90) }), NOW)).toBe("active");
  });
});
