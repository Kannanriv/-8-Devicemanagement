import { createCodec, runVectors } from "@hash8/codec-runtime";
import { fromHex, safeParseSpec, toHex, type Codec, type DeviceCodecSpec, type Field, type MessageDef, type ScalarField, type TestVector } from "@hash8/dcs-schema";
import { z } from "zod";
import { completeJson } from "../llm";
import type { AgentDef } from "../types";
import { deepDiff, representable, roundLike, walkScalars } from "../util";

export interface Finding {
  severity: "error" | "warning" | "info";
  message: string;
  path?: string;
}

const KNOWN_UNITS = new Set([
  "Cel", "[degF]", "K", "%", "V", "mV", "A", "mA", "W", "kW", "VA", "kVA", "var", "kvar", "W.h", "kW.h", "var.h", "kvar.h", "MW.h", "Hz", "s", "ms", "min", "h", "d",
  "m", "km", "km/h", "m/s", "deg", "dBm", "dB", "hPa", "Pa", "kPa", "bar", "mbar", "[ppm]", "[ppb]", "lx", "g", "kg", "L", "m3", "1", "{count}", "[mi_i]/h", "ug/m3",
]);

export const codecVerifier: AgentDef = {
  name: "codec-verifier",
  title: "Codec Verifier",
  description:
    "Proves a codec: runs its test vectors (decode + round-trip), measures message coverage, synthesises vectors via encode for uncovered messages, checks ranges/units/signedness, and drafts concrete questions for the OEM.",
  async run(input, ctx) {
    let raw: unknown = input.spec;
    if (!raw && typeof input.codecId === "string") {
      raw = await ctx.tools.getCodec(input.codecId, typeof input.version === "string" ? input.version : undefined);
      if (!raw) throw new Error(`codec ${input.codecId} not found`);
      ctx.step(`loaded codec ${input.codecId}`);
    }
    if (!raw) throw new Error("codec-verifier needs input.spec or input.codecId");
    const parsed = safeParseSpec(raw);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      ctx.step(`spec is invalid (${errors.length} schema error(s))`);
      return { output: { valid: false, errors, readyToPublish: false, questions: [], findings: errors.map((m) => ({ severity: "error", message: m })) } };
    }
    const spec = parsed.data;
    const findings: Finding[] = [];
    let codec: Codec;
    try {
      codec = createCodec(spec);
    } catch (e) {
      const msg = (e as { errors?: { message: string }[] }).errors?.map((x) => x.message).join("; ") ?? (e as Error).message;
      ctx.step(`codec failed to compile: ${msg}`);
      return { output: { valid: false, errors: [msg], readyToPublish: false, questions: [], findings: [{ severity: "error", message: msg }] } };
    }

    // 1. vectors
    const results = runVectors(spec);
    const failed = results.filter((r) => !r.pass);
    ctx.step(`vectors: ${results.length - failed.length}/${results.length} pass`);
    for (const f of failed) findings.push({ severity: "error", message: `vector "${f.name}" fails: ${(f.diff ?? []).slice(0, 4).join("; ")}` });

    // 2. coverage
    const all: { m: MessageDef; dir: "uplink" | "downlink" }[] = [
      ...spec.uplink.map((m) => ({ m, dir: "uplink" as const })),
      ...(spec.downlink ?? []).map((m) => ({ m, dir: "downlink" as const })),
    ];
    const covered = new Set<string>();
    for (const v of spec.vectors) {
      if (v.message) covered.add(v.message);
      else if (v.direction === "uplink") {
        const r = codec.decode(fromHex(v.hex), { ...(v.port !== undefined ? { port: v.port } : {}), ...(v.topic ? { topic: v.topic } : {}) });
        if (r.ok) covered.add(r.message);
      }
    }
    const uncovered = all.filter((x) => !covered.has(x.m.name)).map((x) => x.m.name);
    ctx.step(`coverage: ${all.length - uncovered.length}/${all.length} message(s) have vectors`);

    // 3. synthesise vectors
    const synthesized: TestVector[] = [];
    for (const { m, dir } of all) {
      if (covered.has(m.name)) continue;
      const data = synthData(m.fields);
      const enc = codec.encode(m.name, data);
      if (!enc.ok) {
        findings.push({ severity: "warning", message: `${m.name}: could not synthesise a payload (${enc.errors.map((e) => e.message).join("; ")})` });
        continue;
      }
      const hex = toHex(enc.bytes);
      const port = firstPort(m);
      const topic = m.when?.topic?.replace(/\+/g, "dev1").replace(/#/g, "x");
      if (dir === "downlink") {
        synthesized.push({ name: `synth: ${m.name}`, direction: "downlink", ...(enc.port !== undefined ? { port: enc.port } : {}), hex, message: m.name, data });
        continue;
      }
      const dec = codec.decode(enc.bytes, { ...(port !== undefined ? { port } : {}), ...(topic ? { topic } : {}) });
      if (!dec.ok) {
        findings.push({ severity: "error", message: `${m.name}: synthesised payload ${hex} does not decode (${dec.errors.map((e) => e.message).join("; ")})` });
        continue;
      }
      if (dec.message !== m.name) {
        findings.push({
          severity: "error",
          message: `${m.name}: payload ${hex} is decoded as "${dec.message}" — the messages are ambiguous on ${port !== undefined ? `port ${port}` : topic ? `topic ${topic}` : "this channel"}; add a const discriminator or distinct ports`,
        });
        continue;
      }
      const diff = deepDiff(data, dec.data);
      if (diff.length) findings.push({ severity: "error", message: `${m.name}: round-trip mismatch: ${diff.slice(0, 3).join("; ")}` });
      synthesized.push({ name: `synth: ${m.name}`, direction: "uplink", ...(port !== undefined ? { port } : {}), ...(topic ? { topic } : {}), hex, message: m.name, data: dec.data });
    }
    if (synthesized.length) ctx.step(`synthesised ${synthesized.length} vector(s) via encode → decode round-trip`);

    // 4. sanity
    const questions: string[] = [];
    sanity(spec, findings, questions);
    for (const name of uncovered)
      questions.push(`Please send 2–3 real captured payloads (hex, port/topic) for message "${name}" together with the values the device reported, so we can lock the codec with test vectors.`);
    for (const i of (Array.isArray(input.issues) ? input.issues : []) as string[]) {
      if (/gap|assumed|not stated|inferred|unknown|unrecognised|confirm|ask the OEM/i.test(i)) questions.push(`Spec clarification: ${i}`);
    }
    // 5. unverified examples from the extractor
    const examples = ((Array.isArray(input.examples) ? input.examples : []) as { hex: string; port?: number; topic?: string; message?: string }[]).map((ex) => {
      const r = codec.decode(fromHex(ex.hex), { ...(ex.port !== undefined ? { port: ex.port } : {}), ...(ex.topic ? { topic: ex.topic.replace(/\+/g, "dev1") } : {}) });
      if (!r.ok) findings.push({ severity: "warning", message: `example ${ex.hex} does not decode: ${r.errors.map((e) => e.message).join("; ")}` });
      return r.ok ? { hex: ex.hex, ok: true, message: r.message, data: r.data, warnings: r.warnings } : { hex: ex.hex, ok: false, errors: r.errors.map((e) => e.message) };
    });

    const errorsCount = findings.filter((f) => f.severity === "error").length;
    ctx.step(`sanity: ${errorsCount} error(s), ${findings.length - errorsCount} warning/info finding(s); ${questions.length} question(s) for the OEM`);

    let finalQuestions = dedupe(questions);
    if (ctx.llm && finalQuestions.length) {
      const r = await completeJson(
        ctx.llm,
        {
          tier: "fast",
          maxTokens: 4000,
          system:
            "You write concise, concrete questions to a device OEM about their payload specification. Merge duplicates, keep byte/field references, " +
            "one question per item. Reply with a JSON array of strings only.",
          messages: [{ role: "user", content: `Device: ${spec.device.vendor} ${spec.device.model}\nFindings:\n${findings.map((f) => `- [${f.severity}] ${f.message}`).join("\n")}\nDraft questions:\n${finalQuestions.map((q) => `- ${q}`).join("\n")}` }],
        },
        z.array(z.string().min(5)).min(1).max(40),
        1,
      );
      if (r.value) {
        finalQuestions = r.value;
        ctx.step(`questions polished by ${ctx.llm.model}`);
      }
    }

    const passed = results.length - failed.length;
    return {
      output: {
        valid: true,
        codecId: spec.id,
        version: spec.version,
        vectors: { total: results.length, passed, failed: failed.map((f) => ({ name: f.name, diff: f.diff ?? [] })) },
        coverage: { messages: all.length, covered: all.length - uncovered.length, uncovered },
        synthesizedVectors: synthesized,
        examples,
        findings,
        questions: finalQuestions,
        readyToPublish: results.length > 0 && failed.length === 0 && errorsCount === 0,
        specWithVectors: { ...spec, vectors: [...spec.vectors, ...synthesized] },
      },
    };
  },
};

function firstPort(m: MessageDef): number | undefined {
  const p = m.when?.port;
  return Array.isArray(p) ? p[0] : p;
}

/** Representative values for every emitted field of a message (encode input). */
export function synthData(fields: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    switch (f.kind) {
      case "scalar":
        if (!f.hidden) out[f.name] = sampleValue(f);
        break;
      case "group":
        out[f.name] = synthData(f.fields);
        break;
      case "repeat": {
        const n = typeof f.count === "number" ? f.count : 2;
        out[f.name] = Array.from({ length: n }, () => synthData(f.fields));
        break;
      }
      case "switch": {
        const key = Object.keys(f.cases)[0];
        if (key === undefined) break;
        const onField = fields.find((x) => x.name === f.on && x.kind === "scalar") as ScalarField | undefined;
        if (onField) {
          const rawKey = Number(key);
          out[onField.name] = onField.enum?.[String(rawKey)] ?? roundLike(rawKey * (onField.scale ?? 1) + (onField.offset ?? 0), onField);
        }
        Object.assign(out, synthData(f.cases[key]!));
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function sampleValue(f: ScalarField): unknown {
  if (f.enum && Object.keys(f.enum).length) {
    const keys = Object.keys(f.enum);
    return f.enum[keys[Math.min(1, keys.length - 1)]!];
  }
  const len = typeof f.length === "number" ? f.length : 4;
  switch (f.type) {
    case "bool":
      return true;
    case "float":
      return f.min !== undefined && f.max !== undefined ? (f.min + f.max) / 2 : 1.5;
    case "string":
      return "TEST".repeat(Math.ceil(len / 4)).slice(0, len);
    case "bcd":
      return "1234567890".repeat(Math.ceil((len * 2) / 10)).slice(0, len * 2);
    case "bytes":
      return "a5".repeat(len);
    default: {
      const bits = f.bits ?? 8;
      const scale = f.scale ?? 1;
      const offset = f.offset ?? 0;
      const [lo, hi] = representable(f.type, bits);
      let rawV: number;
      if (f.min !== undefined && f.max !== undefined) rawV = Math.round(((f.min + f.max) / 2 - offset) / scale);
      else rawV = Math.floor(Math.min(hi, bits <= 16 ? hi / 3 : 123456));
      rawV = Math.max(lo, Math.min(hi, rawV));
      return roundLike(rawV * scale + offset, f);
    }
  }
}

function sanity(spec: DeviceCodecSpec, findings: Finding[], questions: string[]): void {
  const msgs = [...spec.uplink.map((m) => ({ m, dir: "uplink" })), ...(spec.downlink ?? []).map((m) => ({ m, dir: "downlink" }))];
  for (const { m } of msgs) {
    walkScalars(m.fields, (f, path) => {
      const at = `${m.name}.${path}`;
      if (f.hidden) {
        if (/^reserved/i.test(f.name)) questions.push(`What do the bits of "${f.name}" in message "${m.name}" contain? Are they always zero, or reserved for future use?`);
        return;
      }
      if (f.type === "uint" || f.type === "int") {
        const bits = f.bits ?? 8;
        const [lo, hi] = representable(f.type, bits);
        const s = f.scale ?? 1;
        const o = f.offset ?? 0;
        const a = lo * s + o;
        const b = hi * s + o;
        const pmin = Math.min(a, b);
        const pmax = Math.max(a, b);
        if ((f.min !== undefined && f.min < pmin - 1e-9) || (f.max !== undefined && f.max > pmax + 1e-9)) {
          findings.push({
            severity: "error",
            path: at,
            message: `${at}: declared range [${f.min ?? "…"}, ${f.max ?? "…"}] cannot be represented by ${f.type}${bits}${s !== 1 ? ` ×${s}` : ""}${o ? ` ${o > 0 ? "+" : ""}${o}` : ""} (representable [${roundLike(pmin, f)}, ${roundLike(pmax, f)}]) — is it signed, or is there an offset?`,
          });
          questions.push(`Is "${f.description ?? f.name}" (${at}) signed? The sheet gives range ${f.min}..${f.max} but the stated type ${f.type}${bits} cannot hold it.`);
        }
        if (/\b(lat|latitude|lon|lng|longitude)\b/i.test(splitWords(f.name)) && f.type === "uint" && o === 0) {
          findings.push({ severity: "error", path: at, message: `${at}: latitude/longitude is unsigned — southern/western hemisphere values need a signed type (int)` });
          questions.push(`Is ${f.name} (${at}) a signed two's-complement value? Unsigned coordinates cannot represent negative latitudes/longitudes.`);
        }
        if (/\b(lat|latitude)\b/i.test(splitWords(f.name)) && pmax < 90 - 1e-9) findings.push({ severity: "warning", path: at, message: `${at}: cannot represent 90° (max ${roundLike(pmax, f)}) — check the scale` });
        if (s >= 1000 || (s > 0 && s < 1e-7)) findings.push({ severity: "info", path: at, message: `${at}: unusual scale ${s}` });
      }
      const words = splitWords(f.name);
      if (/\b(temp|temperature)\b/i.test(words) && f.unit && !["Cel", "[degF]", "K"].includes(f.unit))
        findings.push({ severity: "warning", path: at, message: `${at}: temperature with unit "${f.unit}"` });
      if (/\b(humidity|rh)\b/i.test(words) && f.unit && f.unit !== "%") findings.push({ severity: "warning", path: at, message: `${at}: humidity with unit "${f.unit}"` });
      if ((f.type === "uint" || f.type === "int" || f.type === "float") && !f.enum && !f.unit && (f.scale !== undefined || /\b(temp|volt|voltage|current|power|energy|speed|pressure|humidity|battery|distance)\b/i.test(words))) {
        findings.push({ severity: "info", path: at, message: `${at}: physical quantity without a unit` });
        questions.push(`What is the engineering unit of "${f.description ?? f.name}" (${at})?`);
      }
      if (f.unit && !KNOWN_UNITS.has(f.unit)) findings.push({ severity: "info", path: at, message: `${at}: unit "${f.unit}" is not a recognised UCUM code` });
    });
  }
  // channel ambiguity: same port, no leading const
  const byChan = new Map<string, MessageDef[]>();
  for (const m of spec.uplink) {
    const ports = m.when?.port === undefined ? [] : Array.isArray(m.when.port) ? m.when.port : [m.when.port];
    const keys = ports.length ? ports.map((p) => `port ${p}`) : [m.when?.topic ? `topic ${m.when.topic}` : "any channel"];
    for (const k of keys) byChan.set(k, [...(byChan.get(k) ?? []), m]);
  }
  for (const [k, ms] of byChan) {
    if (ms.length < 2) continue;
    const noConst = ms.filter((m) => m.fields[0]?.kind !== "const");
    if (noConst.length >= 2 || (noConst.length === 1 && noConst[0] !== ms[ms.length - 1]))
      findings.push({ severity: "warning", message: `${ms.map((m) => m.name).join(", ")} share ${k} without a leading const discriminator — selection relies on payload length/order` });
  }
  if (spec.uplink.some((m) => m.fields.some((f) => f.kind === "scalar" && (f.bits ?? 8) > 8 && f.type !== "bytes")) && !spec.defaults)
    questions.push("Are multi-byte values big-endian (MSB first) or little-endian?");
}

function splitWords(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
}

function dedupe(a: string[]): string[] {
  return [...new Set(a)];
}
