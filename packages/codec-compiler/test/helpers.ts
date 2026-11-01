import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, fromHex, toHex, type DeviceCodecSpec } from "@hash8/dcs-schema";
import type { GeneratedFile } from "../src";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../..");

/** Fixture specs plus seed specs from samples/specs when present. */
export function loadSpecs(): { name: string; spec: DeviceCodecSpec }[] {
  const dirs = [path.join(here, "fixtures"), path.join(repoRoot, "samples", "specs")];
  const out: { name: string; spec: DeviceCodecSpec }[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      out.push({ name: f, spec: parseSpec(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) });
    }
  }
  return out;
}

export function loadFixture(name: string): DeviceCodecSpec {
  return parseSpec(JSON.parse(fs.readFileSync(path.join(here, "fixtures", name), "utf8")));
}

export function writeFiles(files: GeneratedFile[], prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dcs-${prefix}-`));
  for (const f of files) {
    const p = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
  }
  return dir;
}

/** Deep equality with numeric tolerance 1e-9 (semantics §8). Returns list of differences. */
export function diff(expected: unknown, actual: unknown, at = "$"): string[] {
  if (typeof expected === "number" && typeof actual === "number") {
    return Math.abs(expected - actual) <= 1e-9 * Math.max(1, Math.abs(expected)) ? [] : [`${at}: ${expected} != ${actual}`];
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${at}: expected array`];
    if (expected.length !== actual.length) return [`${at}: length ${expected.length} != ${actual.length}`];
    return expected.flatMap((e, i) => diff(e, actual[i], `${at}[${i}]`));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return [`${at}: expected object`];
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    const keys = new Set([...Object.keys(e), ...Object.keys(a)]);
    return [...keys].flatMap((k) => diff(e[k], a[k], `${at}.${k}`));
  }
  return expected === actual ? [] : [`${at}: ${JSON.stringify(expected)} != ${JSON.stringify(actual)}`];
}

export { fromHex, toHex };
