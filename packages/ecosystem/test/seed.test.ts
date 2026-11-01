import { describe, expect, it } from "vitest";
import { runVectors } from "@hash8/codec-runtime";
import { buildSeed, diffSpecs } from "../src";

const now = new Date("2026-11-01T00:00:00.000Z");

describe("ecosystem seed", () => {
  const s = buildSeed(now);

  it("is deterministic", () => {
    expect(JSON.stringify(buildSeed(now))).toBe(JSON.stringify(s));
  });

  it("has the sample OEMs plus fictional partners and ~30 models", () => {
    const names = s.partners.map((p) => p.name);
    for (const n of ["Acme Devices", "Voltix Energy", "Envio Sensors"]) expect(names).toContain(n);
    expect(s.partners.length).toBeGreaterThanOrEqual(15);
    expect(new Set(s.partners.map((p) => p.kind)).size).toBeGreaterThanOrEqual(5);
    expect(s.models.length).toBeGreaterThanOrEqual(28);
    for (const p of s.partners) expect(p.modelsCount).toBe(s.models.filter((m) => m.partnerId === p.id).length);
    for (const m of s.models) {
      expect(s.partners.some((p) => p.id === m.partnerId)).toBe(true);
      expect(m.compatibility.length).toBeGreaterThan(0);
    }
  });

  it("every catalog codec has a spec; certified codecs have passing vectors", () => {
    for (const m of s.models.filter((x) => x.codecId)) {
      const spec = s.specs.find((x) => x.id === m.codecId && x.version === m.codecVersion);
      expect(spec, m.id).toBeTruthy();
      if (m.certification.level !== "listed") expect(runVectors(spec!).every((r) => r.pass), m.id).toBe(true);
    }
  });

  it("releases carry real diffSpecs output", () => {
    const envio = s.releases.filter((r) => r.codecId === "envio.th-sense");
    const r11 = envio.find((r) => r.version === "1.1.0")!;
    expect(r11.previous).toBe("1.0.0");
    expect(r11.breaking).toBe(false);
    expect(r11.changes).toContain("MINOR uplink history: message added");
    const acme = s.releases.find((r) => r.codecId === "acme.tracker-gt200" && r.version === "2.0.0")!;
    expect(acme.breaking).toBe(true);
    const prev = s.history.find((h) => h.id === "acme.tracker-gt200" && h.version === "1.4.0")!;
    const next = s.history.find((h) => h.id === "acme.tracker-gt200" && h.version === "2.0.0")!;
    expect(acme.changes).toEqual(diffSpecs(prev, next).changes);
    expect(s.releases.some((r) => Date.parse(r.publishedAt) > now.getTime() - 30 * 86_400_000)).toBe(true);
  });

  it("certification runs in mixed states", () => {
    const st = new Set(s.runs.map((r) => r.status));
    for (const x of ["passed", "failed", "changes_requested", "submitted"]) expect(st.has(x as never)).toBe(true);
  });

  it("adoptions + subscriptions reference real models/codecs", () => {
    expect(s.adoptions.length).toBeGreaterThan(5);
    for (const a of s.adoptions) expect(s.models.some((m) => m.id === a.modelId)).toBe(true);
    for (const sub of s.subscriptions) expect(s.models.some((m) => m.codecId === sub.codecId)).toBe(true);
  });
});
