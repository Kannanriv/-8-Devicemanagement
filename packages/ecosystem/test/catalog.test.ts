import { describe, expect, it } from "vitest";
import type { CertificationRun, CodecRelease, EcosystemPartner } from "@hash8/sdk-ts";
import { badgesFor, buildEcosystemGraph, computeCompatibility, ecosystemOverview, rankCatalog } from "../src";
import { model } from "./fixtures";

describe("computeCompatibility", () => {
  it("LoRaWAN battery sensor: LNS networks yes, carriers no", () => {
    const m = model({ certification: { level: "codec_verified", badges: badgesFor("codec_verified") } });
    const c = computeCompatibility(m);
    const s = (t: string) => c.find((e) => e.target === t)?.status;
    expect(s("ttn")).toBe("certified");
    expect(s("chirpstack")).toBe("certified");
    expect(s("airtel")).toBe("incompatible");
    expect(s("hash8-sim")).toBe("incompatible");
    expect(s("hash8-crm")).toBe("certified");
    expect(c.every((e) => ["network", "gateway", "carrier", "platform", "hash8-product"].includes(e.kind))).toBe(true);
  });

  it("uncertified models are at most compatible", () => {
    const c = computeCompatibility(model());
    expect(c.some((e) => e.status === "certified")).toBe(false);
    expect(c.find((e) => e.target === "ttn")!.status).toBe("compatible");
  });

  it("cellular MQTT tracker: gateway + carriers per RAT", () => {
    const m = model({ protocols: ["mqtt"], connectivity: ["nb-iot", "lte-m"], certification: { level: "hash8_certified", badges: badgesFor("hash8_certified") } });
    const c = computeCompatibility(m);
    const s = (t: string) => c.find((e) => e.target === t)?.status;
    expect(s("hash8-gateway")).toBe("certified");
    expect(s("ttn")).toBe("incompatible");
    expect(s("airtel")).toBe("certified");
    expect(s("1nce")).toBe("certified");
    expect(s("hash8-sim")).toBe("certified");
  });

  it("no codec → products untested", () => {
    const c = computeCompatibility(model({ codecId: undefined }));
    expect(c.find((e) => e.target === "hash8-crm")!.status).toBe("untested");
  });
});

describe("rankCatalog", () => {
  const models = [
    model({ id: "a", name: "Alpha", certification: { level: "listed", badges: ["listed"] }, adoption: { devices: 9000, customers: 3, pluginDownloads: 1 } }),
    model({ id: "b", name: "Bravo meter", category: "energy-meter", protocols: ["mqtt"], connectivity: ["lte-m"], certification: { level: "hash8_certified", badges: badgesFor("hash8_certified") }, adoption: { devices: 10, customers: 1, pluginDownloads: 1 } }),
    model({ id: "c", name: "Charlie", partnerId: "ptn_x", certification: { level: "hash8_certified", badges: badgesFor("hash8_certified") }, adoption: { devices: 500, customers: 2, pluginDownloads: 1 } }),
    model({ id: "d", name: "Delta", certification: { level: "secure", badges: badgesFor("secure") }, adoption: { devices: 50, customers: 1, pluginDownloads: 1 }, tags: ["cold-chain"] }),
  ];
  it("certified first, then adoption", () => {
    expect(rankCatalog(models, {}).map((m) => m.id)).toEqual(["c", "b", "d", "a"]);
  });
  it("filters", () => {
    expect(rankCatalog(models, { q: "meter" }).map((m) => m.id)).toEqual(["b"]);
    expect(rankCatalog(models, { q: "COLD" }).map((m) => m.id)).toEqual(["d"]);
    expect(rankCatalog(models, { category: "energy-meter" }).map((m) => m.id)).toEqual(["b"]);
    expect(rankCatalog(models, { protocol: "mqtt" }).map((m) => m.id)).toEqual(["b"]);
    expect(rankCatalog(models, { connectivity: "lte-m" }).map((m) => m.id)).toEqual(["b"]);
    expect(rankCatalog(models, { partnerId: "ptn_x" }).map((m) => m.id)).toEqual(["c"]);
    // level = minimum level
    expect(rankCatalog(models, { level: "secure" }).map((m) => m.id)).toEqual(["c", "b", "d"]);
  });
});

describe("graph + overview", () => {
  const partners: EcosystemPartner[] = [
    { id: "ptn_envio", name: "Envio Sensors", kind: "oem", tier: "premier", modelsCount: 1, joinedAt: "2025-01-01T00:00:00Z" },
    { id: "ptn_dist", name: "Tessaro Distribution", kind: "distributor", tier: "verified", modelsCount: 0, joinedAt: "2025-01-01T00:00:00Z" },
  ];
  const m = model({ certification: { level: "hash8_certified", badges: badgesFor("hash8_certified") }, adoption: { devices: 1200, customers: 2, pluginDownloads: 40 } });
  m.compatibility = computeCompatibility(m);

  it("links partners → models → codecs → customers (+ products)", () => {
    const g = buildEcosystemGraph(partners, [m], [{ tenantId: "tn_a", tenantName: "Cust A", modelId: m.id, devices: 1000 }], [{ source: "ptn_dist", target: m.id, kind: "distributes" }]);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain("ptn_envio");
    expect(ids).toContain(`model:${m.id}`);
    expect(ids).toContain("codec:envio.th-sense");
    expect(ids).toContain("customer:tn_a");
    expect(ids).toContain("product:hash8-crm");
    expect(g.links).toContainEqual({ source: "ptn_envio", target: `model:${m.id}`, kind: "lists" });
    expect(g.links).toContainEqual({ source: `model:${m.id}`, target: "codec:envio.th-sense", kind: "decoded-by" });
    expect(g.links).toContainEqual({ source: "codec:envio.th-sense", target: "customer:tn_a", kind: "subscribed" });
    expect(g.links).toContainEqual({ source: "ptn_dist", target: `model:${m.id}`, kind: "distributes" });
    for (const l of g.links) {
      expect(ids).toContain(l.source);
      expect(ids).toContain(l.target);
    }
  });

  it("computes overview KPIs", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    const releases: CodecRelease[] = [
      { codecId: "a", version: "1.1.0", breaking: false, changes: [], publishedAt: "2026-10-20T00:00:00Z", subscribers: 1 },
      { codecId: "a", version: "1.0.0", breaking: false, changes: [], publishedAt: "2026-06-01T00:00:00Z", subscribers: 1 },
    ];
    const runs = [{ status: "running" }, { status: "submitted" }, { status: "passed" }] as CertificationRun[];
    const o = ecosystemOverview(partners, [m, model({ id: "x", codecId: undefined })], runs, releases, now);
    expect(o).toEqual({
      partners: 2,
      oems: 1,
      certifiedModels: 1,
      catalogModels: 2,
      codecs: 1,
      pluginDownloads: 40,
      devicesOnCertifiedModels: 1200,
      releases30d: 1,
      pendingCertifications: 2,
    });
  });
});
