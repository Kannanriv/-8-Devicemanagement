import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Device } from "@hash8/sdk-ts";
import { getServer, json } from "./helpers";
import type { Platform } from "../src/platform";

let app: FastifyInstance;
let p: Platform;

beforeAll(async () => {
  const s = await getServer();
  app = s.app;
  p = s.platform;
}, 120_000);
afterAll(async () => app.close());

async function anyDevice(q = "lifecycle=activated&connectivity=online"): Promise<Device> {
  const r = await json<{ items: Device[] }>(app, "GET", `/devices?${q}&limit=50`);
  expect(r.status).toBe(200);
  expect(r.body.items.length).toBeGreaterThan(0);
  return r.body.items[0]!;
}

describe("ops / health", () => {
  it("returns a ranked ops inbox and fleet stats", async () => {
    const inbox = await json(app, "GET", "/ops/inbox");
    expect(inbox.status).toBe(200);
    expect(Array.isArray(inbox.body)).toBe(true);
    expect(inbox.body.length).toBeGreaterThan(0);
    for (const i of inbox.body) expect(["info", "warning", "critical"]).toContain(i.severity);
    const stats = await json(app, "GET", "/fleet/stats");
    expect(stats.body.devices).toBeGreaterThan(0);
  });
  it("computes device health on separate axes", async () => {
    const d = await anyDevice();
    const h = await json(app, "GET", `/devices/${d.id}/health`);
    expect(h.status).toBe(200);
    expect(["normal", "warning", "critical"]).toContain(h.body.level);
    expect(["online", "stale", "offline", "never_seen"]).toContain(h.body.connectivity);
  });
  it("exposes /healthz", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
  });
});

describe("inventory", () => {
  it("filters and paginates devices with a cursor", async () => {
    const p1 = await json(app, "GET", "/devices?limit=5");
    expect(p1.body.items).toHaveLength(5);
    expect(p1.body.cursor).toBeTruthy();
    const p2 = await json(app, "GET", `/devices?limit=5&cursor=${p1.body.cursor}`);
    const ids1 = p1.body.items.map((d: Device) => d.id);
    for (const d of p2.body.items) expect(ids1).not.toContain(d.id);
    const act = await json(app, "GET", "/devices?lifecycle=activated&limit=500");
    expect(act.body.items.every((d: Device) => d.lifecycle === "activated")).toBe(true);
    expect(act.body.total).toBe(act.body.items.length);
    const sorted = await json(app, "GET", "/devices?sort=health&limit=10");
    const scores = sorted.body.items.map((d: Device) => d.health.score);
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
    const p3 = await json(app, "GET", `/devices?sort=health&limit=10&cursor=${sorted.body.cursor}`);
    expect(p3.body.items[0].health.score).toBeGreaterThanOrEqual(scores[scores.length - 1]);
  });
  it("filters by organization and health; rejects bad filters", async () => {
    const org = await json(app, "GET", "/devices?organization=Metro%20Utilities&limit=200");
    expect(org.body.items.every((d: Device) => d.organization === "Metro Utilities")).toBe(true);
    const bad = await json(app, "GET", "/devices?lifecycle=flying");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("BAD_REQUEST");
  });
  it("returns inventory KPIs and lifecycle summary", async () => {
    const k = await json(app, "GET", "/inventory/kpis");
    expect(k.body.total).toBeGreaterThan(0);
    const s = await json(app, "GET", "/lifecycle/summary");
    expect(Object.keys(s.body)).toContain("pending_activation");
  });
  it("exports CSV", async () => {
    const r = await app.inject({ method: "GET", url: "/api/v1/devices/export?lifecycle=activated" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(r.body.split("\n")[0]).toContain("udi,serial");
  });
  it("imports devices from CSV", async () => {
    const r = await app.inject({ method: "POST", url: "/api/v1/devices/import", headers: { "content-type": "text/csv" }, payload: "serial,imei,iccid,modelId\nCSV-0001,861111111111111,8991000000000000001,acme-gt200\n" });
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.body);
    expect(body.imported).toBe(1);
    expect(body.items[0].lifecycle).toBe("registered");
    expect(body.items[0].udi).toMatch(/^UDI-/);
  });
});

describe("lifecycle", () => {
  it("rejects invalid transitions with 409 and writes audit for valid ones", async () => {
    const d = await anyDevice("lifecycle=registered");
    const bad = await json(app, "POST", `/devices/${d.id}/lifecycle`, { to: "activated" });
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe("INVALID_TRANSITION");
    const ok = await json(app, "POST", `/devices/${d.id}/lifecycle`, { to: "assigned", note: "test" }, { "x-actor": "user:tester" });
    expect(ok.status).toBe(200);
    expect(ok.body.lifecycle).toBe("assigned");
    const audit = await json(app, "GET", `/audit?target=device:${d.id}`);
    expect(audit.body.some((a: { action: string; actor: string }) => a.action === "device.lifecycle.update" && a.actor === "user:tester")).toBe(true);
    const tl = await json(app, "GET", `/devices/${d.id}/timeline?kinds=lifecycle`);
    expect(tl.body.every((e: { kind: string }) => e.kind === "lifecycle")).toBe(true);
  });
});

describe("ingest → decode pipeline", () => {
  it("decodes an HTTP uplink, stores the message and updates the shadow", async () => {
    const d = await anyDevice("modelId=envio-th-sense&lifecycle=activated");
    const spec = (await p.repos.codecs.get("envio.th-sense", "1.1.0"))!.spec;
    const v = spec.vectors.find((x) => x.message === "periodic")!;
    const r = await json(app, "POST", `/ingest/http/${d.serial}`, { hex: v.hex, port: v.port });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("decoded");
    const msgs = await json(app, "GET", `/devices/${d.id}/messages?limit=1`);
    expect(msgs.body[0].id).toBe(r.body.messageId);
    expect(msgs.body[0].data.temperature).toBe(v.data.temperature);
    const dev = await json(app, "GET", `/devices/${d.id}`);
    expect(dev.body.shadow.temperature).toBe(v.data.temperature);
    expect(dev.body.health.connectivity).toBe("online");
  });
  it("stores undecodable payloads as unknown and can redecode", async () => {
    const d = await anyDevice("modelId=envio-th-sense&lifecycle=activated");
    const r = await json(app, "POST", `/ingest/http/${d.serial}`, { hex: "deadbeef", port: 99 });
    expect(r.body.status).not.toBe("decoded");
    const u = await json(app, "GET", `/payloads/unknown?deviceId=${d.id}`);
    expect(u.body.some((x: { payloadHex: string }) => x.payloadHex === "deadbeef")).toBe(true);
    const re = await json(app, "POST", "/payloads/redecode", { deviceId: d.id });
    expect(re.status).toBe(200);
    expect(re.body.attempted).toBeGreaterThan(0);
  });
});

describe("commands & diagnostics", () => {
  it("encodes a downlink via the codec and acks it", async () => {
    const d = await anyDevice("modelId=envio-th-sense&lifecycle=activated");
    const r = await json(app, "POST", `/devices/${d.id}/commands`, { message: "set_interval", data: { interval: 15 } });
    expect(r.status).toBe(201);
    expect(r.body.payloadHex).toBeTruthy();
    expect(r.body.status).toBe("sent");
    const ack = await json(app, "POST", `/commands/${r.body.id}/ack`, {});
    expect(ack.body.status).toBe("acked");
    const bad = await json(app, "POST", `/devices/${d.id}/commands`, { message: "nope", data: {} });
    expect(bad.status).toBe(422);
  });
  it("decodes via diagnostics", async () => {
    const r = await json(app, "POST", "/diagnostics/decode", { codecId: "acme.tracker-gt200", hex: (await p.repos.codecs.get("acme.tracker-gt200", "2.3.0"))!.spec.vectors[0]!.hex });
    expect(r.body.ok).toBe(true);
  });
});

describe("codecs", () => {
  it("lists codecs and downloads a plugin zip", async () => {
    const list = await json(app, "GET", "/codecs");
    expect(list.body.length).toBeGreaterThanOrEqual(3);
    const r = await app.inject({ method: "GET", url: "/api/v1/codecs/envio.th-sense/versions/1.1.0/plugin?target=ts" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("application/zip");
    expect(String(r.headers["content-disposition"])).toContain("envio.th-sense-1.1.0-ts.zip");
    expect(r.rawPayload.subarray(0, 2).toString()).toBe("PK");
  });
  it("runs vectors", async () => {
    const r = await json(app, "POST", "/codecs/voltix.energy-em3/versions/1.4.0/test");
    expect(r.body.every((v: { pass: boolean }) => v.pass)).toBe(true);
  });
});

describe("OTA", () => {
  it("creates, starts and pauses a campaign", async () => {
    const fws = await json(app, "GET", "/firmware?modelId=acme-gt200");
    const fw = fws.body.find((f: { version: string }) => f.version === "2.4.0");
    expect(fw).toBeTruthy();
    const c = await json(app, "POST", "/ota/campaigns", { name: "test rollout", firmwareId: fw.id, cohort: { modelId: "acme-gt200", lifecycle: "activated" }, fromVersions: [">=2.0.0 <2.4.0"] });
    expect(c.status).toBe(201);
    expect(c.body.status).toBe("draft");
    const s = await json(app, "POST", `/ota/campaigns/${c.body.id}/start`, {});
    expect(s.body.status).toBe("running");
    const pz = await json(app, "POST", `/ota/campaigns/${c.body.id}/pause`, { reason: "test" });
    expect(pz.body.status).toBe("paused");
    const again = await json(app, "POST", `/ota/campaigns/${c.body.id}/pause`, {});
    expect(again.status).toBe(409);
    const list = await json(app, "GET", "/ota/campaigns");
    expect(list.body.map((x: { status: string }) => x.status)).toEqual(expect.arrayContaining(["completed", "rolled_back", "running"]));
  });
});

describe("automations", () => {
  it("dry-runs an automation against a device without side effects", async () => {
    const d = await anyDevice("modelId=envio-th-sense&lifecycle=activated");
    const before = await json(app, "GET", "/alerts?limit=1000");
    const r = await json(app, "POST", "/automations/aut_high_temp/dry-run", { deviceId: d.id, data: { temperature: 35 } });
    expect(r.status).toBe(200);
    expect(r.body.matched).toBe(true);
    expect(r.body.actions[0].type).toBe("alert");
    const r2 = await json(app, "POST", "/automations/aut_high_temp/dry-run", { deviceId: d.id, data: { temperature: 20 } });
    expect(r2.body.matched).toBe(false);
    const after = await json(app, "GET", "/alerts?limit=1000");
    expect(after.body.length).toBe(before.body.length);
  });
  it("rejects invalid conditions", async () => {
    const r = await json(app, "POST", "/automations", { name: "bad", trigger: { type: "message" }, condition: "data.x >", actions: [{ type: "tag", add: ["x"] }] });
    expect(r.status).toBe(400);
  });
});

describe("alerts", () => {
  it("filters by category and acks / resolves with resolution", async () => {
    const sec = await json(app, "GET", "/alerts?category=security&limit=50");
    expect(sec.body.every((a: { category: string }) => a.category === "security")).toBe(true);
    const open = await json(app, "GET", "/alerts?status=open&limit=1");
    const id = open.body[0].id;
    const ack = await json(app, "POST", `/alerts/${id}/ack`, {}, { "x-actor": "user:alice" });
    expect(ack.body.acknowledgedBy).toBe("user:alice");
    const res = await json(app, "POST", `/alerts/${id}/resolve`, { resolution: "fixed" });
    expect(res.body.status).toBe("resolved");
    expect(res.body.resolution).toBe("fixed");
  });
});

describe("assets, SIM, security, bulk, reports", () => {
  it("swaps a device on an asset and keeps association history", async () => {
    const assets = await json(app, "GET", "/assets?limit=200");
    const asset = assets.body.items.find((a: { deviceIds: string[] }) => a.deviceIds.length === 1);
    const spare = await anyDevice("lifecycle=registered");
    const oldId = asset.deviceIds[0];
    const r = await json(app, "POST", `/assets/${asset.id}/swap`, { oldDeviceId: oldId, newDeviceId: spare.id });
    expect(r.status).toBe(200);
    expect(r.body.newDevice.assetId).toBe(asset.id);
    expect(r.body.newDevice.lifecycle).toBe("activated");
    const hist = await json(app, "GET", `/assets/${asset.id}/associations`);
    expect(hist.body.some((a: { deviceId: string; to?: string; reason?: string }) => a.deviceId === oldId && a.to && a.reason === "swap")).toBe(true);
    expect(hist.body.some((a: { deviceId: string; to?: string }) => a.deviceId === spare.id && !a.to)).toBe(true);
  });
  it("lists SIMs and suspends one", async () => {
    const sims = await json(app, "GET", "/sims?status=active&limit=5");
    expect(sims.body.length).toBeGreaterThan(0);
    const r = await json(app, "POST", `/devices/${sims.body[0].deviceId}/sim/suspend`, {});
    expect(r.body.status).toBe("suspended");
  });
  it("issues and revokes an X.509 credential; security overview", async () => {
    const d = await anyDevice();
    const issued = await json(app, "POST", `/devices/${d.id}/credentials`, { days: 30 });
    expect(issued.status).toBe(201);
    expect(issued.body.certificatePem).toContain("BEGIN CERTIFICATE");
    expect(issued.body.credential.status).toBe("expiring");
    const rev = await json(app, "POST", `/credentials/${issued.body.credential.id}/revoke`, { reason: "test" });
    expect(rev.body.status).toBe("revoked");
    const ov = await json(app, "GET", "/security/overview");
    expect(ov.body.credentials.total).toBeGreaterThan(0);
    expect(ov.body.tenantIsolation.length).toBeGreaterThan(0);
  });
  it("previews and runs a bulk tag job with per-device results", async () => {
    const list = await json(app, "GET", "/devices?lifecycle=activated&limit=3");
    const ids = list.body.items.map((d: Device) => d.id);
    const pv = await json(app, "POST", "/devices/bulk/preview", { op: "suspend", deviceIds: [...ids, "dev_missing"], params: {} });
    expect(pv.body.eligible.length).toBe(3);
    expect(pv.body.ineligible[0].deviceId).toBe("dev_missing");
    const viewer = await json(app, "POST", "/devices/bulk/preview", { op: "tag", deviceIds: ids, params: { add: ["x"] } }, { "x-actor": "viewer:bob" });
    expect(viewer.body.eligible).toHaveLength(0);
    const job = await json(app, "POST", "/devices/bulk", { op: "tag", deviceIds: ids, params: { add: ["bulk-test"] } });
    expect(job.status).toBe(201);
    expect(job.body.status).toBe("completed");
    expect(job.body.results).toHaveLength(3);
    const got = await json(app, "GET", `/bulk-jobs/${job.body.id}`);
    expect(got.body.succeeded).toBe(3);
  });
  it("builds fleet report and trends", async () => {
    const r = await json(app, "GET", "/reports/fleet");
    expect(r.status).toBe(200);
    expect(r.body.utilization.messages).toBeGreaterThan(0);
    const t = await json(app, "GET", "/reports/trends?days=30");
    expect(t.body).toHaveLength(30);
  });
});

describe("tenancy & audit", () => {
  it("scopes data to the x-tenant-id header", async () => {
    const metro = await json(app, "GET", "/devices?limit=500", undefined, { "x-tenant-id": "tn_customer_metro" });
    expect(metro.body.items.every((d: Device) => d.tenantId === "tn_customer_metro")).toBe(true);
    const unknown = await json(app, "GET", "/devices", undefined, { "x-tenant-id": "nope" });
    expect(unknown.status).toBe(400);
  });
  it("writes audit entries for mutations", async () => {
    const r = await json(app, "POST", "/integrations", { kind: "webhook", name: "t", events: ["*"], config: {} }, { "x-actor": "user:auditor" });
    expect(r.status).toBe(201);
    const t = await json(app, "POST", `/integrations/${r.body.id}/test`, {});
    expect(t.body.delivery.status).toBe("delivered");
    const a = await json(app, "GET", "/audit?actor=user:auditor");
    expect(a.body.some((x: { action: string }) => x.action === "integration.create")).toBe(true);
  });
});
