import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { safeParseSpec, type DeviceCodecSpecInput } from "@hash8/dcs-schema";
import { createAgentRegistry } from "../src";
import { campaign, device, emSpec, fakeLlm, fakeTools, message, thSpec } from "./fakes";

async function xlsxBase64(): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Uplink");
  const rows: (string | number)[][] = [
    ["Uplink fPort 1 - Periodic"],
    ["Byte", "Size", "Field", "Type", "Unit", "Resolution", "Example"],
    [0, 2, "Temperature", "int16", "°C", "0.01", 21.5],
    [2, 1, "Humidity", "U8", "%", "0.5", 45],
    [4, 2, "Battery", "U16", "mV", "", 3600],
    [],
    ["Example: 08 66 5A 00 0E 10"],
  ];
  rows.forEach((r, i) => r.forEach((v, j) => (ws.getCell(i + 1, j + 1).value = v)));
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer).toString("base64");
}

const names = (fields: unknown[]) => fields.map((f) => (f as { name: string }).name);

describe("spec-extractor", () => {
  it("runs heuristics only without an LLM", async () => {
    const reg = createAgentRegistry({ tools: fakeTools().tools });
    const run = await reg.run("spec-extractor", { xlsxBase64: await xlsxBase64(), fileName: "Envio_TH-Sense_Payload_Spec.xlsx" });
    expect(run.status).toBe("completed");
    const out = run.output!;
    expect(out.refinedBy).toBe("heuristics");
    expect(out.valid).toBe(true);
    const draft = out.draft as DeviceCodecSpecInput;
    expect(names(draft.uplink[0]!.fields)).toEqual(["temperature", "humidity", "reserved3", "battery"]);
    expect((out.trace as Record<string, unknown>)["periodic.temperature"]).toBeTruthy();
    expect(Array.isArray(out.issues)).toBe(true);
  });

  it("accepts pasted text tables", async () => {
    const reg = createAgentRegistry({ tools: fakeTools().tools });
    const text = ["Port 3 - Status", "Byte | Length | Name | Type | Unit", "0 | 2 | Voltage | U16 | mV", "2 | 1 | Flags | U8 |"].join("\n");
    const run = await reg.run("spec-extractor", { text, vendor: "Acme", model: "X1" });
    const draft = run.output!.draft as DeviceCodecSpecInput;
    expect(draft.uplink[0]!.when).toEqual({ port: 3 });
    expect(names(draft.uplink[0]!.fields)).toEqual(["voltage", "flags"]);
  });

  it("refines with Claude, retries on schema errors, and preserves source refs", async () => {
    let seenPrompt = "";
    const { llm, requests } = fakeLlm([
      (req) => {
        seenPrompt = JSON.stringify(req.messages);
        return { text: '```json\n{"dcs":"1.0","id":"BAD ID"}\n```' };
      },
      () => {
        return {
          text: JSON.stringify({
            dcs: "1.0",
            id: "envio.th-sense",
            version: "1.0.0-draft",
            device: { vendor: "Envio", model: "TH-Sense" },
            uplink: [
              {
                name: "periodic",
                when: { port: 1 },
                fields: [
                  { name: "temperature", type: "int", bits: 16, scale: 0.01, unit: "Cel" },
                  { name: "humidity", type: "uint", bits: 8, scale: 0.5, unit: "%" },
                  { name: "reserved3", type: "uint", bits: 8, hidden: true },
                  { name: "batteryVoltage", type: "uint", bits: 16, unit: "mV", source: { sheet: "Uplink", cell: "C5", confidence: 0.8 } },
                ],
              },
            ],
            vectors: [],
          }),
        };
      },
    ]);
    const reg = createAgentRegistry({ tools: fakeTools().tools, llm });
    const run = await reg.run("spec-extractor", { xlsxBase64: await xlsxBase64(), fileName: "x.xlsx" });
    expect(requests).toHaveLength(2);
    expect(String(requests[1]!.messages.at(-1)!.content)).toMatch(/failed validation/);
    expect(seenPrompt).toContain("Temperature");
    const out = run.output!;
    expect(out.refinedBy).toBe("fake-model");
    const draft = out.draft as DeviceCodecSpecInput;
    expect(safeParseSpec(draft).success).toBe(true);
    const f0 = draft.uplink[0]!.fields[0] as { source?: { cell?: string } };
    expect(f0.source?.cell).toBe("C3"); // copied from heuristic trace
    expect((out.trace as Record<string, { cell?: string }>)["periodic.batteryVoltage"]?.cell).toBe("C5");
    // heuristic vectors are kept when the model drops them
    expect((draft.vectors ?? []).length).toBe(1);
  });

  it("falls back to the heuristic draft when Claude never produces a valid spec", async () => {
    const { llm } = fakeLlm([{ text: "nope" }, { text: "{}" }, { text: "[]" }]);
    const reg = createAgentRegistry({ tools: fakeTools().tools, llm });
    const run = await reg.run("spec-extractor", { xlsxBase64: await xlsxBase64() });
    expect(run.output!.refinedBy).toBe("heuristics");
    expect((run.output!.issues as string[]).join(" ")).toMatch(/refinement failed/i);
  });
});

describe("codec-verifier", () => {
  it("runs vectors, reports coverage, synthesises vectors and asks OEM questions", async () => {
    const reg = createAgentRegistry({ tools: fakeTools().tools });
    const run = await reg.run("codec-verifier", { codecId: "envio.th-sense" });
    expect(run.status).toBe("completed");
    const o = run.output as Record<string, any>;
    expect(o.vectors).toMatchObject({ total: 1, passed: 1 });
    expect(o.coverage.uncovered).toEqual(expect.arrayContaining(["alarm", "setInterval"]));
    const synth = o.synthesizedVectors as { message: string; hex: string; direction: string }[];
    expect(synth.map((v) => v.message)).toEqual(expect.arrayContaining(["alarm", "setInterval"]));
    expect(synth.find((v) => v.message === "setInterval")!.direction).toBe("downlink");
    expect(o.questions.join("\n")).toMatch(/reserved3/);
    expect(o.questions.join("\n")).toMatch(/captured payload/i);
  });

  it("finds sanity problems: unsigned latitude and a range that cannot be represented", async () => {
    const reg = createAgentRegistry({ tools: fakeTools().tools });
    const spec: DeviceCodecSpecInput = {
      dcs: "1.0",
      id: "a.b",
      version: "0.1.0",
      device: { vendor: "a", model: "b" },
      uplink: [
        {
          name: "loc",
          fields: [
            { name: "latitude", type: "uint", bits: 32, scale: 0.000001, unit: "deg" },
            { name: "temperature", type: "uint", bits: 8, unit: "Cel", min: -40, max: 85 },
          ],
        },
      ],
    };
    const run = await reg.run("codec-verifier", { spec });
    const o = run.output as Record<string, any>;
    const text = o.findings.map((f: { message: string }) => f.message).join("\n");
    expect(text).toMatch(/latitude.*signed/i);
    expect(text).toMatch(/temperature.*-40/);
    expect(o.readyToPublish).toBe(false);
  });

  it("reports invalid specs", async () => {
    const reg = createAgentRegistry({ tools: fakeTools().tools });
    const run = await reg.run("codec-verifier", { spec: { dcs: "1.0", id: "Bad" } });
    expect(run.output!.valid).toBe(false);
  });
});

describe("payload-triage", () => {
  it("clusters unknown payloads and proposes a candidate message with evidence", async () => {
    const unknown = [
      ...Array.from({ length: 6 }, (_, i) =>
        message(`d${i % 2}`, i, {}, { status: "unknown", port: 5, payloadHex: `a101${(0x10 + i).toString(16).padStart(2, "0")}00${(i * 7).toString(16).padStart(2, "0")}ff`, message: undefined }),
      ),
      ...Array.from({ length: 2 }, (_, i) => message("d0", 10 + i, {}, { status: "unknown", port: 9, payloadHex: "0102", message: undefined })),
    ];
    const f = fakeTools({ unknown, devices: [device({ id: "d0", codecId: "envio.th-sense" }), device({ id: "d1", codecId: "envio.th-sense" })] });
    const reg = createAgentRegistry({ tools: f.tools });
    const run = await reg.run("payload-triage", {});
    const o = run.output as Record<string, any>;
    expect(o.clusters).toHaveLength(2);
    expect(o.clusters[0]).toMatchObject({ count: 6, port: 5, length: 6, leadingBytes: "a101" });
    const patch = o.patches[0];
    expect(patch).toMatchObject({ codecId: "envio.th-sense", op: "add-uplink-message" });
    expect(patch.message.when).toEqual({ port: 5 });
    expect(patch.message.fields[0]).toMatchObject({ kind: "const", value: 0xa1 });
    expect(patch.evidence.samples.length).toBeGreaterThan(0);
    expect(patch.evidence.decodesAll).toBe(true);
    expect(patch.evidence.devices).toEqual(["d0", "d1"]);
  });
});

describe("rollout-guardian", () => {
  it("continues a healthy campaign", async () => {
    const f = fakeTools({
      campaigns: [campaign({ id: "c1", waves: [{ name: "canary", percent: 5, status: "passed", targeted: 50, succeeded: 49, failed: 1 }] })],
      devices: [device({ id: "d1" })],
    });
    const reg = createAgentRegistry({ tools: f.tools });
    const run = await reg.run("rollout-guardian", { campaignId: "c1" });
    expect(run.status).toBe("completed");
    expect((run.output!.decisions as any[])[0]).toMatchObject({ campaignId: "c1", decision: "continue" });
    expect(run.output!.pendingAction).toBeUndefined();
  });

  it("asks for approval before pausing and executes on approve", async () => {
    const f = fakeTools({
      campaigns: [campaign({ id: "c2", waves: [{ name: "canary", percent: 5, status: "passed", targeted: 50, succeeded: 48, failed: 2 }, { name: "25%", percent: 25, status: "running", targeted: 200, succeeded: 150, failed: 25 }] })],
      devices: [device({ id: "d1" })],
    });
    const reg = createAgentRegistry({ tools: f.tools });
    const run = await reg.run("rollout-guardian", { campaignId: "c2" }, { actor: "user:bob" });
    expect(run.status).toBe("awaiting_approval");
    expect(run.output!.pendingAction).toMatchObject({ type: "pauseCampaign", campaignId: "c2" });
    expect(f.called("pauseCampaign")).toHaveLength(0);
    const done = await reg.approve(run.id);
    expect(done.status).toBe("completed");
    expect(f.called("pauseCampaign")).toHaveLength(1);
    expect(f.called("audit").some((c) => c.args[0] === "agent.action.approved")).toBe(true);
  });

  it("recommends rollback for a failing canary and pauses on poor cohort health", async () => {
    const f = fakeTools({
      campaigns: [
        campaign({ id: "c3", waves: [{ name: "canary", percent: 5, status: "failed", targeted: 20, succeeded: 8, failed: 12 }] }),
        campaign({ id: "c4", waves: [{ name: "canary", percent: 5, status: "running", targeted: 20, succeeded: 20, failed: 0 }] }),
      ],
      devices: [device({ id: "d1", health: { score: 20, connectivity: "online", issues: [] } })],
    });
    const reg = createAgentRegistry({ tools: f.tools });
    const run = await reg.run("rollout-guardian", {});
    const d = run.output!.decisions as any[];
    expect(d.find((x) => x.campaignId === "c3").decision).toBe("rollback");
    expect(d.find((x) => x.campaignId === "c4").decision).toBe("pause");
    expect(run.output!.pendingAction).toMatchObject({ type: "batch" });
    await reg.approve(run.id);
    expect(f.called("rollbackCampaign")[0]!.args[0]).toBe("c3");
    expect(f.called("pauseCampaign")[0]!.args[0]).toBe("c4");
  });
});

describe("fleet-copilot", () => {
  const fleet = () =>
    fakeTools({
      devices: [
        device({ id: "d1", firmwareVersion: "1.9.0", health: { score: 90, connectivity: "online", issues: [], battery: 12 } }),
        device({ id: "d2", firmwareVersion: "2.0.0", health: { score: 40, connectivity: "offline", issues: [], battery: 70 } }),
        device({ id: "d3", firmwareVersion: "2.0.0", health: { score: 80, connectivity: "online", issues: [], battery: 25 } }),
      ],
    });
  it("answers offline / firmware / battery questions without an LLM", async () => {
    const reg = createAgentRegistry({ tools: fleet().tools });
    const off = await reg.run("fleet-copilot", { question: "Which devices are offline?" });
    expect(off.output!.intent).toBe("offline");
    expect(String(off.output!.answer)).toMatch(/1 device/);
    expect(String(off.output!.answer)).toContain("d2");
    const fw = await reg.run("fleet-copilot", { question: "show the firmware version distribution" });
    expect(fw.output!.data).toMatchObject({ "2.0.0": 2, "1.9.0": 1 });
    const bat = await reg.run("fleet-copilot", { question: "devices with battery below 30%" });
    expect((bat.output!.data as any[]).map((d) => d.id)).toEqual(["d1", "d3"]);
  });

  it("handles lifecycle, stale telemetry, SIM and swap questions without an LLM", async () => {
    const f = fakeTools({
      devices: [
        device({ id: "p1", lifecycle: "pending_activation", organization: "Acme Foods" }),
        device({ id: "p2", lifecycle: "pending_activation" }),
        device({ id: "s1", health: { connectivity: "stale", lastSeenAt: "2026-11-01T06:00:00Z" } }),
        device({ id: "m1", sim: { iccid: "8991000000000000001", carrier: "Airtel", status: "suspended" } }),
        device({ id: "m2", sim: { iccid: "8991000000000000002", carrier: "Jio", status: "active" } }),
        device({ id: "w1", lifecycle: "swap", assetId: "a1", assetName: "Excavator EX-12" }),
        device({ id: "c1", health: { score: 20, issues: ["battery critical"] } }),
      ],
    });
    const reg = createAgentRegistry({ tools: f.tools });
    const ask = async (question: string) => (await reg.run("fleet-copilot", { question })).output!;

    const pend = await ask("Which devices are pending activation?");
    expect(pend.intent).toBe("lifecycle-pending_activation");
    expect((pend.data as any[]).map((d) => d.id)).toEqual(["p1", "p2"]);
    expect(String(pend.answer)).toMatch(/2 devices pending activation/);

    const stale = await ask("show devices with stale telemetry");
    expect(stale.intent).toBe("stale");
    expect((stale.data as any[]).map((d) => d.id)).toEqual(["s1"]);

    const sims = await ask("Which SIMs are suspended?");
    expect(sims.intent).toBe("sims-suspended");
    expect((sims.data as any[]).map((d) => d.id)).toEqual(["m1"]);
    expect(String(sims.answer)).toContain("8991000000000000001");

    const swap = await ask("list assets with swapped devices");
    expect(swap.intent).toBe("swap");
    expect(String(swap.answer)).toContain("Excavator EX-12");

    const crit = await ask("devices needing attention (critical health)");
    expect((crit.data as any[]).map((d) => d.id)).toEqual(["c1"]);
  });

  it("runs a Claude tool-use loop over read-only tools", async () => {
    const f = fleet();
    const { llm, requests } = fakeLlm([
      { toolUses: [{ id: "t1", name: "queryDevices", input: { connectivity: "offline" } }] },
      { text: "d2 is offline." },
    ]);
    const reg = createAgentRegistry({ tools: f.tools, llm });
    const run = await reg.run("fleet-copilot", { question: "what's offline?" });
    expect(run.output!.answer).toBe("d2 is offline.");
    expect(run.output!.toolCalls).toEqual([expect.objectContaining({ name: "queryDevices" })]);
    expect(requests[0]!.tools!.map((t) => t.name)).toContain("queryDevices");
    expect(requests[0]!.tools!.map((t) => t.name)).not.toContain("pauseCampaign");
    const last = requests[1]!.messages.at(-1)!;
    expect(JSON.stringify(last.content)).toContain("tool_result");
  });

  it("turns proposed write actions into approvals", async () => {
    const f = fleet();
    const { llm } = fakeLlm([
      { toolUses: [{ id: "t1", name: "proposeAction", input: { type: "sendCommand", deviceId: "d1", message: "setInterval", data: { seconds: 60 }, reason: "user asked" } }] },
      { text: "I've proposed the command; it needs approval." },
    ]);
    const reg = createAgentRegistry({ tools: f.tools, llm });
    const run = await reg.run("fleet-copilot", { question: "set d1 interval to 60s" });
    expect(run.status).toBe("awaiting_approval");
    await reg.approve(run.id);
    expect(f.called("sendCommand")[0]!.args).toEqual(["d1", "setInterval", { seconds: 60 }]);
  });
});

describe("anomaly-sentinel", () => {
  it("flags a spike with an alert and leaves steady series alone", async () => {
    const noisy = (i: number) => 21 + Math.sin(i) * 0.3;
    const f = fakeTools({
      devices: [device({ id: "d1" }), device({ id: "d2" })],
      messages: {
        d1: [...Array.from({ length: 30 }, (_, i) => message("d1", i, { temperature: noisy(i), humidity: 40 })), message("d1", 31, { temperature: 64, humidity: 40 })],
        d2: Array.from({ length: 30 }, (_, i) => message("d2", i, { temperature: noisy(i) })),
      },
    });
    const reg = createAgentRegistry({ tools: f.tools });
    const run = await reg.run("anomaly-sentinel", {});
    const anomalies = run.output!.anomalies as any[];
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ deviceId: "d1", field: "temperature", value: 64 });
    expect(f.alerts).toHaveLength(1);
    expect(f.alerts[0]).toMatchObject({ deviceId: "d1", category: "abnormal_telemetry", source: "agent:anomaly-sentinel" });
  });
});

describe("integration-builder", () => {
  it("maps an energy meter to CRM usage-billing meter records", async () => {
    const reg = createAgentRegistry({ tools: fakeTools().tools });
    const run = await reg.run("integration-builder", { codecId: "voltix.em3", target: "hash8-crm-usage" });
    const o = run.output as Record<string, any>;
    expect(o.mapping.records[0]).toMatchObject({ meter: "voltix.em3.activeEnergyImport", quantity: "$.data.activeEnergyImport", unit: "kW.h", mode: "cumulative" });
    expect(o.sample.output[0]).toMatchObject({ meter: "voltix.em3.activeEnergyImport", quantity: 1000, unit: "kW.h" });
    expect(o.sample.output[0].customerId).toBeTruthy();
    expect(o.sample.output[0].at).toBeTruthy();
  });

  it("maps alarm fields to a ticketing payload", async () => {
    const reg = createAgentRegistry({ tools: fakeTools().tools });
    const run = await reg.run("integration-builder", { spec: thSpec, target: "hash8-ticketing" });
    const o = run.output as Record<string, any>;
    expect(o.mapping.triggers.map((t: any) => t.field)).toContain("alarmType");
    expect(o.sample.output[0]).toMatchObject({ deviceId: expect.any(String), priority: expect.any(String), title: expect.stringContaining("alarm") });
  });

  it("maps to a custom target schema by fuzzy names", async () => {
    const reg = createAgentRegistry({ tools: fakeTools().tools });
    const run = await reg.run("integration-builder", { spec: emSpec, target: { name: "erp", fields: { kwh_total: "total energy", volts: "line voltage" } } });
    const o = run.output as Record<string, any>;
    expect(o.mapping.fields).toMatchObject({ kwh_total: "$.data.activeEnergyImport", volts: "$.data.voltageL1" });
  });
});
