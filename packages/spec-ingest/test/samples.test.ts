import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runVectors } from "@hash8/codec-runtime";
import { safeParseSpec, type DeviceCodecSpec, type Field, type ScalarField } from "@hash8/dcs-schema";
import { extractFromWorkbook, type ExtractedSpec } from "../src";

const root = path.resolve(import.meta.dirname, "../../..");
const xlsx = (f: string) => path.join(root, "samples/excel", f);
const specPath = (f: string) => path.join(root, "samples/specs", f);

const CASES = [
  { file: "Envio_TH-Sense_Payload_Spec.xlsx", spec: "envio.th-sense.json", minMatch: 1, vectorsMustPass: true },
  { file: "Voltix_EM3_Modbus-MQTT_Map.xlsx", spec: "voltix.energy-em3.json", minMatch: 1, vectorsMustPass: true },
  // GT200 sheet uses one table per message ID; the reference spec models a single frame with a switch.
  { file: "Acme_GT200_Protocol_v2.3.xlsx", spec: "acme.tracker-gt200.json", minMatch: 0.9, vectorsMustPass: false },
];

/** Leaf scalars keyed by "<message>/<path>" — switch cases are flattened into their parent. */
function leaves(spec: { uplink: { name: string; fields: unknown[] }[]; downlink?: { name: string; fields: unknown[] }[] }, flattenMessages: boolean) {
  const out = new Map<string, ScalarField>();
  const walk = (msg: string, fields: Field[], prefix: string) => {
    for (const f of fields) {
      if (f.kind === "scalar" || f.kind === undefined) {
        const s = f as ScalarField;
        if (!s.hidden) out.set(`${flattenMessages ? "*" : msg}/${prefix}${s.name}`, s);
      } else if (f.kind === "group" || f.kind === "repeat") walk(msg, f.fields, `${prefix}${f.name}.`);
      else if (f.kind === "switch") for (const c of Object.values(f.cases)) walk(msg, c, prefix);
    }
  };
  for (const m of [...spec.uplink, ...(spec.downlink ?? [])]) walk(m.name, m.fields as Field[], "");
  return out;
}

const normUnit = (u?: string) => (u === "dB[mW]" ? "dBm" : u);

function compare(draft: ExtractedSpec["draft"], spec: DeviceCodecSpec, flatten: boolean) {
  const want = leaves(spec, flatten);
  const got = leaves(draft as never, flatten);
  const mismatches: string[] = [];
  let ok = 0;
  for (const [k, w] of want) {
    const g = got.get(k);
    if (!g) {
      mismatches.push(`${k}: missing`);
      continue;
    }
    const diffs: string[] = [];
    if (g.type !== w.type) diffs.push(`type ${g.type}≠${w.type}`);
    if ((g.bits ?? defBits(g)) !== (w.bits ?? defBits(w))) diffs.push(`bits ${g.bits}≠${w.bits}`);
    if (Math.abs((g.scale ?? 1) - (w.scale ?? 1)) > 1e-12) diffs.push(`scale ${g.scale}≠${w.scale}`);
    if ((g.offset ?? 0) !== (w.offset ?? 0)) diffs.push(`offset ${g.offset}≠${w.offset}`);
    if (normUnit(g.unit) !== normUnit(w.unit)) diffs.push(`unit ${g.unit}≠${w.unit}`);
    if (JSON.stringify(Object.keys(g.enum ?? {})) !== JSON.stringify(Object.keys(w.enum ?? {}))) diffs.push("enum keys");
    if (diffs.length) mismatches.push(`${k}: ${diffs.join(", ")}`);
    else ok++;
  }
  return { ratio: want.size ? ok / want.size : 1, ok, total: want.size, mismatches };
}

function defBits(f: ScalarField) {
  return f.type === "bool" ? 1 : f.type === "float" ? 32 : f.type === "uint" || f.type === "int" ? 8 : undefined;
}

describe.each(CASES)("sample $file", ({ file, spec: specFile, minMatch, vectorsMustPass }) => {
  it("exists and extracts to a valid DCS draft with source trace", async () => {
    expect(existsSync(xlsx(file))).toBe(true);
    const r = await extractFromWorkbook(readFileSync(xlsx(file)), { fileName: file });
    const v = safeParseSpec(r.draft);
    expect(v.success, v.success ? "" : JSON.stringify(v.error.issues.slice(0, 3))).toBe(true);
    expect(Object.keys(r.trace).length).toBeGreaterThan(8);
    for (const ref of Object.values(r.trace)) expect(ref).toMatchObject({ file, sheet: expect.any(String), cell: expect.stringMatching(/^[A-Z]+\d+$/) });
    expect(r.confidence).toBeGreaterThan(0.8);
    expect(r.sheets.some((s) => s.role === "messages")).toBe(true);
    // the draft's own example-derived vectors must hold
    const own = runVectors(r.draft);
    expect(own.filter((o) => !o.pass).map((o) => `${o.name}: ${o.diff?.join("; ")}`)).toEqual([]);
  });

  it.runIf(existsSync(specPath(specFile)))("matches the reference spec field by field", async () => {
    const spec = safeParseSpec(JSON.parse(readFileSync(specPath(specFile), "utf8")));
    if (!spec.success) throw new Error("reference spec invalid");
    const r = await extractFromWorkbook(readFileSync(xlsx(file)), { fileName: file });
    const cmp = compare(r.draft, spec.data, !vectorsMustPass);
    expect(cmp.ratio, cmp.mismatches.join("\n")).toBeGreaterThanOrEqual(minMatch);
    const results = runVectors({ ...r.draft, vectors: spec.data.vectors });
    const failed = results.filter((x) => !x.pass).map((x) => `${x.name}: ${x.diff?.slice(0, 2).join("; ")}`);
    if (vectorsMustPass) expect(failed).toEqual([]);
    else expect(results.filter((x) => x.pass).length).toBeGreaterThanOrEqual(3); // all downlinks
  });
});

describe("GT200 sample specifics", () => {
  it("skips the struck-through HDOP row, keeps hex-only examples and models the status byte as a bit group", async () => {
    const file = "Acme_GT200_Protocol_v2.3.xlsx";
    const r = await extractFromWorkbook(readFileSync(xlsx(file)), { fileName: file });
    expect(r.issues.join("\n")).toMatch(/HDOP.*struck through/);
    expect(r.examples.map((e) => e.message)).toEqual(["location", "heartbeat", "alarm"]);
    expect(r.examples[0]).toMatchObject({ topic: "acme/gt200/+/up", hex: "a50107bb4f132e3ffd9b01c4010e09e00e72" });
    const loc = r.draft.uplink.find((m) => m.name === "location")!;
    const flags = loc.fields.find((f) => (f as { name: string }).name === "flags");
    expect(flags).toMatchObject({ kind: "group", fields: [{ name: "ignition", type: "bool" }, { name: "moving" }, { name: "gpsFix" }, { hidden: true }] });
    expect(loc.fields.at(-1)).toMatchObject({ kind: "checksum", algo: "crc16-ccitt" });
    expect(r.draft.device).toMatchObject({ vendor: "Acme", model: "GT200", category: "tracker" });
    expect(r.draft.defaults).toEqual({ endian: "big" });
  });
});
