import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createAgentRegistry } from "../src";
import { fakeTools } from "./fakes";

const sample = (f: string) => readFileSync(path.resolve(import.meta.dirname, "../../../samples/excel", f)).toString("base64");

describe("spec import pipeline on real OEM samples (no API key)", () => {
  it("TH-Sense: spec-extractor → codec-verifier, collaborative steps, all vectors pass", async () => {
    const reg = createAgentRegistry({ tools: fakeTools().tools });
    const run = await reg.orchestrate("Import this OEM spec sheet", { xlsxBase64: sample("Envio_TH-Sense_Payload_Spec.xlsx"), fileName: "Envio_TH-Sense_Payload_Spec.xlsx" });
    expect(run.output!.plan).toEqual(["spec-extractor", "codec-verifier"]);
    expect(run.status).toBe("completed");
    expect(new Set(run.steps.map((s) => s.agent))).toEqual(new Set(["spec-extractor", "codec-verifier"]));
    const v = (run.output!.results as Record<string, any>)["codec-verifier"];
    expect(v.valid).toBe(true);
    expect(v.vectors.total).toBeGreaterThanOrEqual(5);
    expect(v.vectors.passed).toBe(v.vectors.total);
    expect(v.coverage.uncovered).toEqual([]);
  });

  it("GT200: verifier decodes the hex-only examples and flags the uint16 interval range", async () => {
    const reg = createAgentRegistry({ tools: fakeTools().tools });
    const run = await reg.orchestrate("extract the spec from this excel", { xlsxBase64: sample("Acme_GT200_Protocol_v2.3.xlsx"), fileName: "Acme_GT200_Protocol_v2.3.xlsx" });
    const v = (run.output!.results as Record<string, any>)["codec-verifier"];
    expect(v.examples.map((e: any) => e.ok)).toEqual([true, true, true]);
    expect(v.examples[0].data).toMatchObject({ lat: 12.9715987, lng: 77.5945627, speed: 45.2, flags: { ignition: true } });
    expect(v.findings.map((f: any) => f.message).join("\n")).toMatch(/set_interval\.interval.*86400/);
    expect(v.synthesizedVectors.length).toBeGreaterThan(0);
    expect(v.questions.length).toBeGreaterThan(0);
  });
});
