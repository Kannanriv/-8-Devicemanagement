import { safeParseSpec, type DeviceCodecSpec, type MessageDef, type ScalarField } from "@hash8/dcs-schema";
import { z } from "zod";
import { completeJson } from "../llm";
import type { AgentContext, AgentDef } from "../types";
import { walkScalars } from "../util";
import { synthData } from "./codec-verifier";

interface SourceField {
  message: string;
  path: string;
  field: ScalarField;
}

const ENERGY_UNITS = new Set(["kW.h", "W.h", "MW.h", "kvar.h", "var.h", "m3", "L", "km", "h"]);
const COUNTER = /energy|kwh|total|counter|count|volume|consumption|usage|runtime|hours|distance|odometer|pulse|import|export|accumulat/i;
const ALARM = /alarm|alert|fault|error|tamper|sos|event|status|state|warning|leak|fire|trip/i;

export const integrationBuilder: AgentDef = {
  name: "integration-builder",
  title: "Integration Builder",
  description:
    "Maps a codec's decoded fields onto a target schema — #8 IoT CRM usage-billing meter records, #8 ticketing payloads, or any custom schema — and returns the mapping config plus a sample transformed record.",
  async run(input, ctx) {
    const spec = await loadSpec(input, ctx);
    const sources = collect(spec, typeof input.message === "string" ? input.message : undefined);
    ctx.step(`codec ${spec.id}@${spec.version}: ${sources.length} decoded field(s) available`);
    const target = input.target ?? "hash8-crm-usage";
    const sampleFor = (message: string) => sampleEnvelope(spec, message);

    if (target === "hash8-crm-usage" || target === "crm" || target === "hash8-crm") {
      const numeric = sources.filter((s) => (s.field.type === "uint" || s.field.type === "int" || s.field.type === "float") && !s.field.enum);
      let picked = numeric.filter((s) => COUNTER.test(s.path) || (s.field.unit && ENERGY_UNITS.has(s.field.unit)));
      if (!picked.length) picked = numeric.filter((s) => s.field.unit);
      const records = picked.map((s) => ({
        message: s.message,
        meter: `${spec.id}.${s.path}`,
        quantity: `$.data.${s.path}`,
        unit: s.field.unit ?? "1",
        mode: /total|import|export|counter|odometer|energy|volume|accumulat|runtime|hours/i.test(s.path) || (s.field.unit && ENERGY_UNITS.has(s.field.unit)) ? "cumulative" : "gauge",
        customerId: "$.device.tenantId",
        at: "$.receivedAt",
      }));
      ctx.step(`mapped ${records.length} meter(s): ${records.map((r) => `${r.meter} (${r.mode})`).join(", ") || "none"}`);
      const mapping = { target: "hash8-crm-usage", recordSchema: "{customerId, meter, quantity, unit, at}", records, notes: "cumulative meters should be billed on the delta between consecutive readings" };
      const output = records.map((r) => {
        const env = sampleFor(r.message);
        return { customerId: get(env, r.customerId), meter: r.meter, quantity: get(env, r.quantity), unit: r.unit, at: get(env, r.at) };
      });
      return { output: { target: "hash8-crm-usage", mapping, sample: { input: records[0] ? sampleFor(records[0].message) : null, output } } };
    }

    if (target === "hash8-ticketing" || target === "ticketing") {
      const triggers = sources
        .filter((s) => (s.field.enum && (ALARM.test(s.path) || Object.values(s.field.enum).some((l) => ALARM.test(l)))) || (s.field.type === "bool" && ALARM.test(s.path)))
        .map((s) => {
          const normal = s.field.enum ? Object.entries(s.field.enum).find(([k, l]) => k === "0" || /^(none|ok|normal|no ?alarm|clear|idle)$/i.test(l))?.[1] : false;
          const labels = s.field.enum ? Object.values(s.field.enum) : [];
          const high = labels.some((l) => /tamper|sos|fire|leak|over|critical|fault|loss|fail/i.test(l)) || /tamper|sos|fire|leak/i.test(s.path);
          return {
            message: s.message,
            field: s.path,
            condition: s.field.enum ? `data.${s.path} != ${JSON.stringify(normal ?? "")}` : `data.${s.path} == true`,
            priority: high ? "high" : "medium",
          };
        });
      ctx.step(`found ${triggers.length} alarm-like field(s): ${triggers.map((t) => t.field).join(", ") || "none"}`);
      const mapping = {
        target: "hash8-ticketing",
        triggers,
        payload: {
          title: "{{field}} = {{value}} on {{device.name || device.id}}",
          description: "Device {{device.id}} reported {{field}} = {{value}} at {{receivedAt}} (message {{message}}).",
          priority: "{{trigger.priority}}",
          deviceId: "$.device.id",
          customerId: "$.device.tenantId",
          labels: ["iot", spec.id, "{{message}}"],
        },
      };
      const output = triggers.map((t) => {
        const env = sampleFor(t.message);
        const value = get(env, `$.data.${t.field}`);
        return {
          title: `${t.field} = ${String(value)} on ${env.device.id}`,
          description: `Device ${env.device.id} reported ${t.field} = ${String(value)} at ${env.receivedAt} (message ${t.message}).`,
          priority: t.priority,
          deviceId: env.device.id,
          customerId: env.device.tenantId,
          labels: ["iot", spec.id, t.message],
        };
      });
      return { output: { target: "hash8-ticketing", mapping, sample: { input: triggers[0] ? sampleFor(triggers[0].message) : null, output } } };
    }

    // custom target schema
    const t = target as { name?: string; fields?: Record<string, string> };
    if (!t || typeof t !== "object" || !t.fields) throw new Error('integration-builder: target must be "hash8-crm-usage", "hash8-ticketing" or {name, fields:{targetField: description}}');
    const candidates = [
      ...sources.map((s) => ({ path: `$.data.${s.path}`, words: tokens(`${s.path} ${s.field.description ?? ""} ${unitWords(s.field.unit)}`), message: s.message })),
      { path: "$.device.id", words: tokens("device id deviceid serial"), message: "" },
      { path: "$.device.tenantId", words: tokens("customer tenant account client"), message: "" },
      { path: "$.receivedAt", words: tokens("timestamp time at date received ts"), message: "" },
    ];
    let fields: Record<string, string | null> = {};
    let mappedBy = "heuristics";
    for (const [name, desc] of Object.entries(t.fields)) {
      const want = tokens(`${name} ${desc}`);
      let best: { path: string; score: number } | undefined;
      for (const c of candidates) {
        const score = overlap(want, c.words);
        if (score > 0 && (!best || score > best.score)) best = { path: c.path, score };
      }
      fields[name] = best?.path ?? null;
    }
    if (ctx.llm) {
      const valid = new Set(candidates.map((c) => c.path));
      const r = await completeJson(
        ctx.llm,
        {
          tier: "fast",
          maxTokens: 2000,
          system: 'Map target schema fields to source JSON paths of a decoded IoT message. Reply with JSON only: {"fields": {"<targetField>": "<source path>" | null}}. Use only the given source paths.',
          messages: [{ role: "user", content: `Target ${t.name ?? "schema"}: ${JSON.stringify(t.fields)}\nSource paths:\n${candidates.map((c) => `- ${c.path}`).join("\n")}\nHeuristic guess: ${JSON.stringify(fields)}` }],
        },
        z.object({ fields: z.record(z.string(), z.string().nullable()) }),
        1,
        (v) => Object.values(v.fields).filter((p) => p !== null && !valid.has(p)).map((p) => `unknown source path ${p}`),
      );
      if (r.value) {
        fields = { ...fields, ...r.value.fields };
        mappedBy = ctx.llm.model;
      }
    }
    const unmapped = Object.entries(fields).filter(([, v]) => v === null).map(([k]) => k);
    ctx.step(`mapped ${Object.keys(fields).length - unmapped.length}/${Object.keys(fields).length} target field(s) (${mappedBy})`);
    const msg = sources.find((s) => Object.values(fields).includes(`$.data.${s.path}`))?.message ?? spec.uplink[0]!.name;
    const env = sampleFor(msg);
    const out: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(fields)) out[k] = p ? get(env, p) : null;
    return { output: { target: t.name ?? "custom", mapping: { target: t.name ?? "custom", message: msg, fields, unmapped, mappedBy }, sample: { input: env, output: [out] } } };
  },
};

async function loadSpec(input: Record<string, unknown>, ctx: AgentContext): Promise<DeviceCodecSpec> {
  let raw: unknown = input.spec;
  if (!raw && typeof input.codecId === "string") raw = await ctx.tools.getCodec(input.codecId, typeof input.version === "string" ? input.version : undefined);
  if (!raw) throw new Error("integration-builder needs input.spec or input.codecId");
  const p = safeParseSpec(raw);
  if (!p.success) throw new Error(`invalid codec spec: ${p.error.issues[0]?.message}`);
  return p.data;
}

function collect(spec: DeviceCodecSpec, onlyMessage?: string): SourceField[] {
  const out: SourceField[] = [];
  const seen = new Set<string>();
  for (const m of spec.uplink as MessageDef[]) {
    if (onlyMessage && m.name !== onlyMessage) continue;
    walkScalars(m.fields, (f, path) => {
      if (f.hidden || seen.has(`${m.name}.${path}`)) return;
      seen.add(`${m.name}.${path}`);
      out.push({ message: m.name, path, field: f });
    });
  }
  return out;
}

interface Envelope {
  device: { id: string; tenantId: string; name: string };
  receivedAt: string;
  codecId: string;
  message: string;
  data: Record<string, unknown>;
}

function sampleEnvelope(spec: DeviceCodecSpec, message: string): Envelope {
  const v = spec.vectors.find((x) => x.direction === "uplink" && x.message === message) ?? spec.vectors.find((x) => x.direction === "uplink" && !x.message && spec.uplink[0]?.name === message);
  const m = spec.uplink.find((x) => x.name === message);
  return {
    device: { id: "dev-0001", tenantId: "customer-0001", name: `${spec.device.model} #1` },
    receivedAt: "2026-11-01T08:00:00.000Z",
    codecId: spec.id,
    message,
    data: v ? (v.data as Record<string, unknown>) : m ? synthData(m.fields) : {},
  };
}

/** Minimal "$.a.b" path getter. */
export function get(obj: unknown, path: string): unknown {
  const parts = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const SYN: Record<string, string> = { kwh: "energy", wh: "energy", volts: "voltage", volt: "voltage", v: "voltage", amps: "current", amp: "current", temp: "temperature", hum: "humidity", rh: "humidity", bat: "battery", batt: "battery", lat: "latitude", lon: "longitude", lng: "longitude", ts: "timestamp", cust: "customer", qty: "quantity" };

function tokens(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 || w === "v")
    .flatMap((w) => {
      const base = w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
      return SYN[w] ? [base, SYN[w]!] : SYN[base] ? [base, SYN[base]!] : [base];
    });
}

function unitWords(u?: string): string {
  if (!u) return "";
  const m: Record<string, string> = { "kW.h": "kwh energy", "W.h": "wh energy", V: "volt voltage", mV: "millivolt voltage", A: "amp current", Cel: "celsius temperature", "%": "percent", W: "watt power", kW: "kw power", Hz: "frequency" };
  return m[u] ?? u;
}

function overlap(a: string[], b: string[]): number {
  let s = 0;
  for (const x of new Set(a)) {
    if (b.includes(x)) s += 1;
    else if (x.length >= 4 && b.some((y) => y.length >= 4 && (y.startsWith(x) || x.startsWith(y)))) s += 0.5;
  }
  return s;
}
