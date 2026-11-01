import { describe, expect, it } from "vitest";
import type { CertificationRun } from "@hash8/sdk-ts";
import { achievedLevel, certificationSteps, requiredSteps, runCertification } from "../src";
import { acmeSpec, envioSpec, model } from "./fixtures";

const fixed = { now: () => new Date("2026-11-01T10:00:00.000Z"), id: () => "cert_test" };

describe("certification pipeline", () => {
  it("required steps are cumulative by level", () => {
    expect(requiredSteps("listed")).toEqual(["spec_import"]);
    expect(requiredSteps("codec_verified")).toEqual(["spec_import", "codec_vectors", "plugin_conformance"]);
    expect(requiredSteps("ota_ready")).toContain("ota_dry_run");
    expect(requiredSteps("secure")).toContain("security_review");
    expect(requiredSteps("hash8_certified")).toEqual(["spec_import", "codec_vectors", "plugin_conformance", "ota_dry_run", "security_review", "interop"]);
  });

  it("certifies a LoRaWAN model end-to-end by actually running vectors and generating plugins", async () => {
    const run = await runCertification(model(), envioSpec(), "hash8_certified", fixed);
    const byName = Object.fromEntries(run.steps.map((s) => [s.name, s]));
    expect(run.status).toBe("passed");
    expect(byName.codec_vectors!.status).toBe("passed");
    expect(byName.codec_vectors!.detail).toMatch(/8\/8 vectors pass/);
    expect(byName.codec_vectors!.detail).toMatch(/5\/5 messages covered/);
    expect(byName.plugin_conformance!.status).toBe("passed");
    expect(byName.plugin_conformance!.detail).toMatch(/ts013 executed/);
    expect(byName.plugin_conformance!.detail).toMatch(/c: skipped/);
    expect(byName.security_review!.status).toBe("passed");
    expect(byName.ota_dry_run!.status).toBe("passed");
    expect(byName.interop!.status).toBe("passed");
    expect(achievedLevel(run)).toBe("hash8_certified");
  });

  it("fails codec_vectors when a vector is wrong", async () => {
    const spec = envioSpec();
    (spec.vectors[0]!.data as Record<string, unknown>).humidity = 12;
    const run = await runCertification(model(), spec, "codec_verified", fixed);
    expect(run.status).toBe("failed");
    const v = run.steps.find((s) => s.name === "codec_vectors")!;
    expect(v.status).toBe("failed");
    expect(v.detail).toMatch(/7\/8 vectors pass/);
    expect(achievedLevel(run)).toBe("listed");
  });

  it("fails coverage when a message has no vector", async () => {
    const spec = envioSpec();
    spec.vectors = spec.vectors.filter((v) => v.message !== "history");
    const run = await runCertification(model(), spec, "codec_verified", fixed);
    const v = run.steps.find((s) => s.name === "codec_vectors")!;
    expect(v.status).toBe("failed");
    expect(v.detail).toMatch(/uncovered: uplink history/);
  });

  it("fails spec_import when there is no codec", async () => {
    const run = await runCertification(model({ codecId: undefined }), undefined, "codec_verified", fixed);
    expect(run.status).toBe("failed");
    expect(run.steps[0]).toMatchObject({ name: "spec_import", status: "failed" });
    expect(run.steps.find((s) => s.name === "codec_vectors")!.status).toBe("skipped");
  });

  it("a plugin generator that throws (not 'not implemented') fails conformance", async () => {
    const run = await runCertification(model(), envioSpec(), "codec_verified", {
      ...fixed,
      generatePlugin: (_s, t) => {
        if (t === "python") throw new Error("boom");
        return [{ path: "x", content: "y" }];
      },
    });
    const p = run.steps.find((s) => s.name === "plugin_conformance")!;
    expect(p.status).toBe("failed");
    expect(p.detail).toMatch(/python: boom/);
  });

  it("security review requests changes for plaintext MQTT", async () => {
    const m = model({ id: "acme-gt200", protocols: ["mqtt"], connectivity: ["nb-iot"], tags: [], codecId: "acme.tracker-gt200", latestFirmware: "2.3.0" });
    const run = await runCertification(m, acmeSpec(), "secure", fixed);
    const s = run.steps.find((x) => x.name === "security_review")!;
    expect(s.status).toBe("failed");
    expect(s.detail).toMatch(/mqtt.*TLS/);
    expect(run.status).toBe("changes_requested");
    expect(achievedLevel(run)).toBe("ota_ready");
    const ok = await runCertification({ ...m, tags: ["mtls", "x509"] }, acmeSpec(), "secure", fixed);
    expect(ok.status).toBe("passed");
  });

  it("OTA dry run needs firmware lineage matching the codec range", async () => {
    const run = await runCertification(model({ latestFirmware: "3.0.0" }), envioSpec(), "ota_ready", fixed);
    const s = run.steps.find((x) => x.name === "ota_dry_run")!;
    expect(s.status).toBe("failed");
    expect(s.detail).toMatch(/outside codec range/);
    const none = await runCertification(model({ latestFirmware: undefined }), envioSpec(), "ota_ready", fixed);
    expect(none.steps.find((x) => x.name === "ota_dry_run")!.status).toBe("failed");
  });

  it("steps not required for the level are skipped", async () => {
    const run = await runCertification(model(), envioSpec(), "codec_verified", fixed);
    expect(run.steps.find((s) => s.name === "interop")).toMatchObject({ status: "skipped" });
    expect(run.status).toBe("passed");
  });

  it("streams progressive snapshots", async () => {
    const snaps: CertificationRun[] = [];
    for await (const s of certificationSteps(model(), envioSpec(), "hash8_certified", fixed)) snaps.push(structuredClone(s));
    expect(snaps[0]!.status).toBe("running");
    expect(snaps[0]!.steps.every((s) => s.status === "pending" || s.status === "running")).toBe(true);
    expect(snaps.length).toBeGreaterThanOrEqual(7);
    expect(snaps.at(-1)!.status).toBe("passed");
  });
});
