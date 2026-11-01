import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, CHARACTER_LIMIT, type ApiClient } from "../src/server";

type Call = { method: "GET" | "POST"; path: string; body?: unknown };

const device = {
  id: "dev_1",
  tenantId: "t1",
  oemTenantId: "oem",
  modelId: "m_gt200",
  serial: "GT200-0001",
  lifecycle: "activated",
  udi: "UDI-0001",
  assetId: "asset_1",
  assetName: "Excavator 7",
  firmwareVersion: "2.1.0",
  codecId: "acme.gt200",
  codecVersion: "1.0.0",
  tags: ["fleet-a"],
  health: { score: 92, level: "normal", connectivity: "online", battery: 81, issues: [] },
  shadow: { latitude: 12.97, longitude: 77.59 },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

/** Fake Hash8Client: routes by "METHOD path" (query string stripped), records calls. */
class FakeClient implements ApiClient {
  calls: Call[] = [];
  routes = new Map<string, (path: string, body?: unknown) => unknown>();
  on(key: string, fn: (path: string, body?: unknown) => unknown) {
    this.routes.set(key, fn);
    return this;
  }
  private handle(method: "GET" | "POST", path: string, body?: unknown) {
    this.calls.push({ method, path, body });
    const fn = this.routes.get(`${method} ${path.split("?")[0]}`);
    if (!fn) return Promise.reject(new Error(`${method} ${path} → 404: not found`));
    try {
      return Promise.resolve(fn(path, body));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  get<T>(path: string) {
    return this.handle("GET", path) as Promise<T>;
  }
  post<T>(path: string, body?: unknown) {
    return this.handle("POST", path, body) as Promise<T>;
  }
}

let fake: FakeClient;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return { text: res.content[0]?.text ?? "", isError: Boolean(res.isError) };
}

beforeEach(async () => {
  fake = new FakeClient();
  fake
    .on("GET /devices/dev_1", () => device)
    .on("GET /devices", (path) => {
      const q = new URL(path, "http://x").searchParams.get("q");
      const list = !q || device.serial.includes(q) ? [device] : [];
      return { items: list, total: list.length, cursor: list.length ? "c2" : undefined };
    });
  const server = createServer(fake);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterEach(async () => {
  await client.close();
});

describe("tool registry", () => {
  it("exposes all tools with descriptions and annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "ops_inbox",
        "fleet_stats",
        "search_devices",
        "get_device",
        "device_messages",
        "device_timeline",
        "change_lifecycle",
        "send_command",
        "decode_payload",
        "list_codecs",
        "get_codec",
        "list_campaigns",
        "pause_campaign",
        "list_alerts",
        "run_agent",
        "inventory_kpis",
        "list_assets",
        "swap_device",
        "bulk_preview",
        "fleet_report",
        "revoke_credential",
      ].sort(),
    );
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(40);
      expect(t.annotations).toBeDefined();
      expect(t.inputSchema.type).toBe("object");
    }
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.fleet_stats!.annotations!.readOnlyHint).toBe(true);
    expect(byName.change_lifecycle!.annotations!.destructiveHint).toBe(true);
    expect(byName.send_command!.annotations!.readOnlyHint).toBe(false);
    expect(byName.swap_device!.annotations!.destructiveHint).toBe(true);
    expect(byName.revoke_credential!.annotations!.destructiveHint).toBe(true);
    expect(byName.bulk_preview!.annotations!.readOnlyHint).toBe(true);
  });
});

describe("read tools", () => {
  it("fleet_stats returns API JSON", async () => {
    fake.on("GET /fleet/stats", () => ({ devices: 10, online: 7 }));
    const r = await call("fleet_stats");
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ devices: 10, online: 7 });
  });

  it("ops_inbox filters by severity", async () => {
    fake.on("GET /ops/inbox", () => [
      { id: "1", severity: "critical", title: "a" },
      { id: "2", severity: "info", title: "b" },
    ]);
    const r = await call("ops_inbox", { severity: "critical" });
    expect(r.text).toContain("1 inbox item");
    expect(r.text).not.toContain('"b"');
  });

  it("search_devices forwards filters as query params and summarises", async () => {
    const r = await call("search_devices", { q: "GT200", lifecycle: "activated", connectivity: "stale", health: "critical", limit: 5 });
    const last = fake.calls.at(-1)!;
    expect(last.path).toBe("/devices?q=GT200&lifecycle=activated&connectivity=stale&health=critical&limit=5");
    const body = JSON.parse(r.text);
    expect(body.total).toBe(1);
    expect(body.hasMore).toBe(true);
    expect(body.devices[0]).toMatchObject({ serial: "GT200-0001", udi: "UDI-0001", connectivity: "online", healthLevel: "normal", asset: { id: "asset_1", name: "Excavator 7" }, codec: "acme.gt200@1.0.0" });
    expect(body.devices[0].shadow).toBeUndefined();
  });

  it("get_device resolves a serial via search fallback", async () => {
    const r = await call("get_device", { device: "GT200-0001" });
    expect(r.isError).toBe(false);
    const body = JSON.parse(r.text);
    expect(body.id).toBe("dev_1");
    expect(body.allowedTransitions).toEqual(["maintenance", "suspended", "swap", "retired"]);
  });

  it("device_messages uses the resolved id and filters status", async () => {
    fake.on("GET /devices/dev_1/messages", () => [
      { id: "m1", status: "decoded" },
      { id: "m2", status: "unknown" },
    ]);
    const r = await call("device_messages", { device: "dev_1", limit: 10, status: "unknown" });
    expect(fake.calls.at(-1)!.path).toBe("/devices/dev_1/messages?limit=10");
    expect(r.text).toContain("m2");
    expect(r.text).not.toContain('"m1"');
  });

  it("get_codec picks the latest published version and summarises", async () => {
    fake
      .on("GET /codecs", () => [
        { codecId: "acme.gt200", version: "1.2.0", status: "published" },
        { codecId: "acme.gt200", version: "1.10.0", status: "published" },
        { codecId: "acme.gt200", version: "2.0.0", status: "draft" },
      ])
      .on("GET /codecs/acme.gt200/versions/1.10.0", () => ({
        id: "acme.gt200",
        version: "1.10.0",
        device: { vendor: "Acme", model: "GT200" },
        uplink: [{ name: "position", when: { port: 1 }, fields: [{ name: "lat", type: "int", bits: 32, unit: "deg" }] }],
        downlink: [{ name: "set_interval", fields: [{ name: "seconds", type: "uint", bits: 16 }] }],
        vectors: [{}, {}],
      }));
    const r = await call("get_codec", { codecId: "acme.gt200" });
    const body = JSON.parse(r.text);
    expect(body.version).toBe("1.10.0");
    expect(body.uplink[0].fields).toEqual(["lat:int32 deg"]);
    expect(body.downlink[0].name).toBe("set_interval");
    expect(body.vectors).toBe(2);
  });

  it("get_codec errors helpfully for unknown codec", async () => {
    fake.on("GET /codecs", () => []);
    const r = await call("get_codec", { codecId: "nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("list_codecs");
  });

  it("list_alerts filters, sorts newest first and limits", async () => {
    fake.on("GET /alerts", () => ({
      items: [
        { id: "a1", severity: "critical", status: "open", createdAt: "2026-01-01" },
        { id: "a2", severity: "critical", status: "open", createdAt: "2026-03-01" },
        { id: "a3", severity: "info", status: "open", createdAt: "2026-04-01" },
      ],
      total: 3,
    }));
    const r = await call("list_alerts", { severity: "critical", limit: 1 });
    expect(r.text).toContain("a2");
    expect(r.text).not.toContain("a1");
    expect(r.text).not.toContain("a3");
  });

  it("truncates oversize responses", async () => {
    fake.on("GET /ops/inbox", () => [{ id: "x", severity: "info", summary: "y".repeat(CHARACTER_LIMIT * 2) }]);
    const r = await call("ops_inbox");
    expect(r.text.length).toBeLessThan(CHARACTER_LIMIT + 500);
    expect(r.text).toContain("truncated");
  });
});

describe("write tools", () => {
  it("change_lifecycle rejects invalid transitions without calling the API", async () => {
    const r = await call("change_lifecycle", { device: "dev_1", to: "assigned" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("maintenance, suspended, swap, retired");
    expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("change_lifecycle posts valid transitions", async () => {
    fake.on("POST /devices/dev_1/lifecycle", (_p, body) => ({ ...device, lifecycle: (body as { to: string }).to }));
    const r = await call("change_lifecycle", { device: "dev_1", to: "maintenance", note: "battery swap" });
    expect(r.isError).toBe(false);
    expect(fake.calls.at(-1)).toEqual({
      method: "POST",
      path: "/devices/dev_1/lifecycle",
      body: { to: "maintenance", note: "battery swap" },
    });
    expect(r.text).toContain("activated → maintenance");
  });

  it("send_command posts message + data", async () => {
    fake.on("POST /devices/dev_1/commands", (_p, body) => ({ id: "cmd_1", status: "queued", ...(body as object) }));
    const r = await call("send_command", { device: "dev_1", message: "set_interval", data: { seconds: 60 } });
    expect(fake.calls.at(-1)!.body).toEqual({ message: "set_interval", data: { seconds: 60 } });
    expect(r.text).toContain("cmd_1");
  });

  it("decode_payload forwards to diagnostics", async () => {
    fake.on("POST /diagnostics/decode", (_p, body) => ({ ok: true, message: "position", data: {}, echo: body }));
    const r = await call("decode_payload", { codecId: "acme.gt200", hex: "01ff", port: 1 });
    expect(JSON.parse(r.text).echo).toEqual({ codecId: "acme.gt200", hex: "01ff", port: 1 });
  });

  it("decode_payload validates hex input", async () => {
    const r = await call("decode_payload", { codecId: "acme.gt200", hex: "zz" });
    expect(r.isError).toBe(true);
  });

  it("pause_campaign and run_agent hit the right routes", async () => {
    fake
      .on("POST /ota/campaigns/c1/pause", () => ({ id: "c1", name: "FW 2.2", status: "paused" }))
      .on("POST /agents/fleet-copilot/run", (_p, body) => ({ id: "run_1", agent: "fleet-copilot", status: "completed", input: body }));
    expect((await call("pause_campaign", { campaignId: "c1", reason: "failures" })).text).toContain("now paused");
    const r = await call("run_agent", { agent: "fleet-copilot", input: { question: "how many offline?" } });
    expect(fake.calls.at(-1)!.body).toEqual({ question: "how many offline?" });
    expect(r.text).toContain("run_1");
  });

  it("maps connection failures to an actionable error", async () => {
    fake.on("GET /fleet/stats", () => {
      throw new Error("fetch failed");
    });
    const r = await call("fleet_stats");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("npm run dev:api");
  });
});

describe("v1.1 module tools", () => {
  const other = { ...device, id: "dev_2", serial: "GT200-0002", udi: "UDI-0002", assetId: undefined, assetName: undefined, lifecycle: "registered" };

  it("inventory_kpis returns the KPI cards", async () => {
    fake.on("GET /inventory/kpis", () => ({ total: 10, connected: 6, stale: 1, offline: 1 }));
    expect(JSON.parse((await call("inventory_kpis")).text)).toMatchObject({ total: 10, stale: 1 });
  });

  it("list_assets filters and returns one asset with associations", async () => {
    fake
      .on("GET /assets", () => [
        { id: "asset_1", name: "Excavator 7", type: "excavator", deviceIds: ["dev_1"] },
        { id: "asset_2", name: "Genset 2", type: "generator", deviceIds: [] },
      ])
      .on("GET /assets/asset_1", () => ({ id: "asset_1", name: "Excavator 7", deviceIds: ["dev_1"] }))
      .on("GET /assets/asset_1/associations", () => [{ id: "as1", assetId: "asset_1", deviceId: "dev_1", role: "primary" }]);
    const list = await call("list_assets", { type: "generator" });
    expect(list.text).toContain("Genset 2");
    expect(list.text).not.toContain("Excavator 7");
    const one = JSON.parse((await call("list_assets", { assetId: "asset_1" })).text);
    expect(one.asset.name).toBe("Excavator 7");
    expect(one.associations).toHaveLength(1);
  });

  it("swap_device resolves both devices and defaults to the old device's asset", async () => {
    fake
      .on("GET /devices/dev_2", () => other)
      .on("POST /assets/asset_1/swap", (_p, body) => ({ ok: true, body }));
    const r = await call("swap_device", { oldDevice: "GT200-0001", newDevice: "dev_2" });
    expect(r.isError).toBe(false);
    expect(fake.calls.at(-1)).toEqual({ method: "POST", path: "/assets/asset_1/swap", body: { oldDeviceId: "dev_1", newDeviceId: "dev_2" } });
    expect(r.text).toContain("GT200-0001 → GT200-0002");
  });

  it("swap_device refuses a retired replacement without calling the API", async () => {
    fake.on("GET /devices/dev_2", () => ({ ...other, lifecycle: "retired" }));
    const r = await call("swap_device", { oldDevice: "dev_1", newDevice: "dev_2" });
    expect(r.isError).toBe(true);
    expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("bulk_preview posts the query and summarises ineligibility reasons", async () => {
    fake.on("POST /devices/bulk/preview", () => ({
      op: "suspend",
      eligible: ["a", "b"],
      ineligible: [
        { deviceId: "c", reason: "retired" },
        { deviceId: "d", reason: "retired" },
        { deviceId: "e", reason: "no permission" },
      ],
      requiresPermission: "device.suspend",
      warnings: [],
    }));
    const r = await call("bulk_preview", { op: "suspend", query: { connectivity: "offline" } });
    expect(fake.calls.at(-1)!.body).toEqual({ op: "suspend", params: {}, query: { connectivity: "offline" } });
    const body = JSON.parse(r.text.split("\n\n")[1]!);
    expect(body.eligibleCount).toBe(2);
    expect(body.ineligibleReasons).toContainEqual({ reason: "retired", count: 2 });
    expect((await call("bulk_preview", { op: "tag" })).isError).toBe(true);
  });

  it("fleet_report forwards the period and drops the series by default", async () => {
    fake.on("GET /reports/fleet", () => ({
      period: { from: "a", to: "b" },
      reliability: { uptimePct: 99.2, series: [{ at: "x", onlinePct: 99 }] },
    }));
    const r = JSON.parse((await call("fleet_report", { from: "2026-10-01", to: "2026-10-31" })).text);
    expect(fake.calls.at(-1)!.path).toBe("/reports/fleet?from=2026-10-01&to=2026-10-31");
    expect(r.reliability).toEqual({ uptimePct: 99.2, seriesPoints: 1 });
  });

  it("revoke_credential by device picks the single active credential", async () => {
    fake
      .on("GET /devices/dev_1/credentials", () => [
        { id: "cred_old", kind: "x509", fingerprint: "aa".repeat(16), status: "revoked" },
        { id: "cred_1", kind: "x509", fingerprint: "bb".repeat(16), status: "active" },
      ])
      .on("POST /credentials/cred_1/revoke", (_p, body) => ({ id: "cred_1", status: "revoked", revokedReason: (body as { reason: string }).reason }));
    const r = await call("revoke_credential", { device: "GT200-0001", reason: "device stolen" });
    expect(r.isError).toBe(false);
    expect(fake.calls.at(-1)).toEqual({ method: "POST", path: "/credentials/cred_1/revoke", body: { reason: "device stolen" } });
  });

  it("revoke_credential asks to choose when several are active", async () => {
    fake.on("GET /devices/dev_1/credentials", () => [
      { id: "c1", kind: "x509", fingerprint: "aa".repeat(16), status: "active" },
      { id: "c2", kind: "psk", fingerprint: "bb".repeat(16), status: "expiring" },
    ]);
    const r = await call("revoke_credential", { device: "dev_1", reason: "rotate keys" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("c1");
    expect(r.text).toContain("c2");
  });

  it("device_timeline passes kinds", async () => {
    fake.on("GET /devices/dev_1/timeline", () => [
      { id: "t1", kind: "association" },
      { id: "t2", kind: "message" },
    ]);
    const r = await call("device_timeline", { device: "dev_1", kinds: ["association", "security"] });
    expect(fake.calls.at(-1)!.path).toBe("/devices/dev_1/timeline?limit=50&kinds=association%2Csecurity");
    expect(r.text).toContain("t1");
    expect(r.text).not.toContain('"t2"');
  });
});
