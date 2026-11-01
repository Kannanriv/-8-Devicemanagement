/**
 * @hash8/codec-compiler — turns a Device Codec Spec (DCS) into ready-to-integrate
 * decoder plugins / SDKs for TypeScript, LoRaWAN TS013 JavaScript, Python, Go,
 * Java and C, and packages them as a zip bundle.
 *
 * Approach: every high-level target embeds the spec as a data literal next to a
 * compact interpreter that is a line-by-line port of the normative semantics
 * (docs/dcs-semantics.md), so all languages produce identical output. The C
 * target embeds the spec as static const tables and decodes without malloc.
 */
import type { DeviceCodecSpec } from "@hash8/dcs-schema";
import type { GeneratedFile } from "./common";
import { generateTs, generateTs013 } from "./targets/js";
import { generatePython } from "./targets/python";
import { generateGo } from "./targets/go";
import { generateJava } from "./targets/java";
import { generateC } from "./targets/c";

export type { GeneratedFile } from "./common";
export { buildBundle } from "./bundle";

/** Mirrors `PluginTarget` in @hash8/sdk-ts. */
export type PluginTarget = "ts" | "ts013" | "python" | "go" | "java" | "c";

export interface TargetInfo {
  target: PluginTarget;
  label: string;
  language: string;
  description: string;
}

const TARGETS: TargetInfo[] = [
  { target: "ts", label: "TypeScript / Node.js", language: "TypeScript", description: "Typed ES module with decode(bytes, port?, topic?) and encode(message, data); per-message data interfaces." },
  { target: "ts013", label: "LoRaWAN TS013 (TTN / ChirpStack)", language: "JavaScript", description: "Plain ES5/ES2015 payload formatter exposing decodeUplink, encodeDownlink and decodeDownlink for The Things Stack and ChirpStack." },
  { target: "python", label: "Python", language: "Python", description: "Single stdlib-only module (Python 3.8+) with decode(data, port=None, topic=None) and encode(message, data)." },
  { target: "go", label: "Go", language: "Go", description: "Standard-library-only Go package with Decode([]byte, *int, string) and Encode(string, map[string]any), plus go.mod and tests." },
  { target: "java", label: "Java", language: "Java", description: "Dependency-free Java 11 package: Codec.decode(byte[], Integer, String) and Codec.encode(String, Map)." },
  { target: "c", label: "C (firmware / gateways)", language: "C", description: "C99 decoder and encoder without malloc: spec as static const tables, JSON written into a caller-provided buffer." },
];

export function listTargets(): TargetInfo[] {
  return TARGETS.map((t) => ({ ...t }));
}

export function generatePlugin(spec: DeviceCodecSpec, target: PluginTarget): GeneratedFile[] {
  switch (target) {
    case "ts":
      return generateTs(spec);
    case "ts013":
      return generateTs013(spec);
    case "python":
      return generatePython(spec);
    case "go":
      return generateGo(spec);
    case "java":
      return generateJava(spec);
    case "c":
      return generateC(spec);
    default:
      throw new Error(`unknown plugin target: ${String(target)}`);
  }
}
