/** Load DCS specs from disk and derive per-message templates from their uplink vectors. */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fromHex, safeParseSpec, type Codec, type DeviceCodecSpec } from "@hash8/dcs-schema";

export interface LoadedSpec {
  spec: DeviceCodecSpec;
  file: string;
}

/** Resolve the specs dir relative to cwd, falling back to this package's location. */
export function resolveSpecsDir(dir: string): string {
  if (isAbsolute(dir)) return dir;
  const fromCwd = resolve(process.cwd(), dir);
  if (existsSync(fromCwd)) return fromCwd;
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return resolve(pkgRoot, dir);
}

export function loadSpecs(dir: string): LoadedSpec[] {
  const abs = resolveSpecsDir(dir);
  if (!existsSync(abs)) throw new Error(`specs directory not found: ${abs}`);
  const out: LoadedSpec[] = [];
  for (const f of readdirSync(abs).filter((x) => x.endsWith(".json")).sort()) {
    const file = join(abs, f);
    const parsed = safeParseSpec(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) {
      console.error(`skip ${f}: invalid DCS — ${parsed.error.issues[0]?.message ?? "?"}`);
      continue;
    }
    out.push({ spec: parsed.data, file });
  }
  if (!out.length) throw new Error(`no valid DCS specs in ${abs}`);
  return out;
}

/** Decode each uplink vector to learn a realistic baseline per message name. */
export function templatesFromVectors(codec: Codec): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const v of codec.spec.vectors) {
    if (v.direction === "downlink") continue;
    let name = v.message;
    let data = v.data;
    if (!name) {
      const r = codec.decode(fromHex(v.hex), { port: v.port, topic: v.topic });
      if (!r.ok) continue;
      name = r.message;
      data = r.data;
    }
    if (!out[name]) out[name] = data;
  }
  return out;
}

export interface BenchPayload {
  bytes: Uint8Array;
  port?: number;
  topic?: string;
}

export function vectorPayloads(spec: DeviceCodecSpec): BenchPayload[] {
  return spec.vectors
    .filter((v) => v.direction !== "downlink")
    .map((v) => ({ bytes: fromHex(v.hex), port: v.port, topic: v.topic }));
}
