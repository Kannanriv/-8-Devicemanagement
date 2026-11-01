import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db";
import { createRepos, compareSemver } from "../src/db/repos";

describe("db", () => {
  it("migrates and round-trips devices with tags/jsonb + keyset pagination", async () => {
    const db = await openDb("memory");
    const r = createRepos(db);
    await r.tenants.insert({ id: "t1", name: "T", kind: "solution", createdAt: new Date().toISOString() });
    await r.models.insert({ id: "m1", tenantId: "t1", vendor: "v", name: "n", category: "c", protocols: [], createdAt: new Date().toISOString() });
    const now = new Date().toISOString();
    const devs = Array.from({ length: 5 }, (_, i) => ({
      id: `d${i}`, udi: `U${i}`, oem: "O", model: "M", provisioning: "provisioned" as const, tenantId: "t1", oemTenantId: "t1", modelId: "m1", serial: `S${i}`, lifecycle: "activated" as const,
      tags: i % 2 ? ["x"] : [], health: { score: 90, level: "normal" as const, connectivity: "online" as const, issues: [] }, shadow: { a: i }, createdAt: now, updatedAt: now,
    }));
    await r.devices.insertMany(devs);
    const p1 = await r.devices.list(["t1"], { limit: 2 });
    expect(p1.total).toBe(5);
    expect(p1.items.map((d) => d.id)).toEqual(["d0", "d1"]);
    const p2 = await r.devices.list(["t1"], { limit: 2, cursor: p1.cursor });
    expect(p2.items.map((d) => d.id)).toEqual(["d2", "d3"]);
    expect((await r.devices.list(["t1"], { tag: "x" })).total).toBe(2);
    expect((await r.devices.get("d3"))?.shadow).toEqual({ a: 3 });
    await db.close();
  });
  it("compares semver", () => {
    expect(compareSemver("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });
});
