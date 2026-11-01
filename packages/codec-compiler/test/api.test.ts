import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import ts from "typescript";
import path from "node:path";
import { generatePlugin, buildBundle, listTargets, type PluginTarget } from "../src";
import { loadSpecs, loadFixture, writeFiles } from "./helpers";

const ALL: PluginTarget[] = ["ts", "ts013", "python", "go", "java", "c"];
const specs = loadSpecs();

describe("listTargets", () => {
  it("lists all six targets with labels", () => {
    const t = listTargets();
    expect(t.map((x) => x.target)).toEqual(ALL);
    for (const x of t) {
      expect(x.label).toBeTruthy();
      expect(x.language).toBeTruthy();
      expect(x.description.length).toBeGreaterThan(10);
    }
  });
});

describe("generatePlugin", () => {
  it.each(ALL)("%s: every source file carries the do-not-edit header", (target) => {
    const spec = loadFixture("tracker.json");
    const files = generatePlugin(spec, target);
    expect(files.length).toBeGreaterThan(0);
    const sources = files.filter((f) => /\.(ts|js|py|go|java|c|h)$/.test(f.path));
    expect(sources.length).toBeGreaterThan(0);
    for (const f of sources) {
      const head = f.content.slice(0, 600);
      expect(head, f.path).toContain("test.tracker");
      expect(head, f.path).toContain("1.2.0");
      expect(head, f.path).toContain("#8 Device Management");
      expect(head, f.path).toMatch(/DO NOT EDIT/);
    }
  });

  it("rejects unknown targets", () => {
    expect(() => generatePlugin(loadFixture("tracker.json"), "rust" as PluginTarget)).toThrow();
  });

  it("generated TypeScript typechecks under strict mode", () => {
    for (const { spec } of specs) {
      const files = generatePlugin(spec, "ts");
      const dir = writeFiles(files, "tsc");
      const roots = files.filter((f) => f.path.endsWith(".ts")).map((f) => path.join(dir, f.path));
      const program = ts.createProgram(roots, {
        strict: true, noEmit: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], lib: ["lib.es2020.d.ts"],
        noUncheckedIndexedAccess: true, allowImportingTsExtensions: true,
      });
      const diags = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(diags, spec.id).toEqual([]);
    }
  });

  it("ts013 output is plain ES2015 JS without module syntax or BigInt", () => {
    const js = generatePlugin(loadFixture("bits.json"), "ts013").find((f) => f.path.endsWith(".js") && !f.path.includes("test"))!;
    expect(js.content).not.toMatch(/^\s*(import|export)\s/m);
    expect(js.content).not.toMatch(/BigInt|\d+n\b|=>|`/);
    expect(js.content).toContain("function decodeUplink(");
    expect(js.content).toContain("function encodeDownlink(");
    expect(js.content).toContain("function decodeDownlink(");
  });

  it("go: package with Decode/Encode, go.mod and a vector test", () => {
    const files = generatePlugin(loadFixture("meter.json"), "go");
    const names = files.map((f) => f.path).sort();
    expect(names).toContain("go/go.mod");
    const src = files.find((f) => f.path.endsWith("codec.go"))!.content;
    expect(src).toMatch(/^package \w+/m);
    expect(src).toContain("func Decode(payload []byte, port *int, topic string) Result");
    expect(src).toContain("func Encode(message string, data map[string]any) EncodeResult");
    expect(src).not.toMatch(/"github\.com/);
    const test = files.find((f) => f.path.endsWith("_test.go"))!.content;
    expect(test).toContain("reading LE with ref repeat");
    expect(balanced(src)).toBe(true);
    expect(balanced(test)).toBe(true);
  });

  it("java: single package Codec class with decode(byte[], Integer, String)", () => {
    const files = generatePlugin(loadFixture("meter.json"), "java");
    const codec = files.find((f) => f.path.endsWith("/Codec.java"))!.content;
    expect(codec).toMatch(/^package [a-z0-9_.]+;/m);
    expect(codec).toContain("public static DecodeResult decode(byte[] payload, Integer port, String topic)");
    expect(codec).toContain("public static EncodeResult encode(String message, Map<String, Object> data)");
    expect(codec).not.toMatch(/import (?!java\.)/);
    const test = files.find((f) => f.path.endsWith("CodecTest.java"))!.content;
    expect(test).toContain("history remaining");
    expect(balanced(codec)).toBe(true);
    expect(balanced(test)).toBe(true);
  });

  it("c: header + C99 source, no malloc, test program with vectors", () => {
    const files = generatePlugin(loadFixture("tracker.json"), "c");
    const h = files.find((f) => f.path === "c/test_tracker_codec.h")!.content;
    const c = files.find((f) => f.path === "c/test_tracker_codec.c")!.content;
    expect(h).toContain("int test_tracker_decode(");
    expect(h).toContain("int test_tracker_encode(");
    expect(h).toContain("test_tracker_encode_setMode(");
    expect(c + h).not.toMatch(/\bmalloc\b|\bfree\(|\bcalloc\b/);
    const test = files.find((f) => f.path === "c/test_tracker_test.c")!.content;
    expect(test).toContain("crc8 check value");
    expect(files.some((f) => f.path === "c/Makefile")).toBe(true);
    expect(balanced(c)).toBe(true);
    expect(balanced(h)).toBe(true);
  });

  it("is deterministic", () => {
    for (const t of ALL) {
      const spec = loadFixture("bits.json");
      expect(generatePlugin(spec, t)).toEqual(generatePlugin(spec, t));
    }
  });
});

describe("buildBundle", () => {
  it("zips per-target folders with README, LICENSE, spec.json and tests", async () => {
    const spec = loadFixture("tracker.json");
    const zipBytes = await buildBundle(spec, ["ts", "python", "c"]);
    expect(zipBytes).toBeInstanceOf(Uint8Array);
    const zip = await JSZip.loadAsync(zipBytes);
    const names = Object.keys(zip.files);
    expect(names).toContain("README.md");
    expect(names).toContain("LICENSE");
    expect(names).toContain("spec.json");
    expect(names.some((n) => n.startsWith("ts/"))).toBe(true);
    expect(names.some((n) => n.startsWith("python/") && n.includes("test_"))).toBe(true);
    expect(names.some((n) => n.startsWith("c/"))).toBe(true);
    expect(names.some((n) => n.startsWith("go/"))).toBe(false);
    const readme = await zip.file("README.md")!.async("string");
    for (const s of ["TTN", "ChirpStack", "Node", "Python", "Go", "Java", "C"]) expect(readme).toContain(s);
    expect(readme).toContain("| latitude |");
    expect(readme).toContain("Battery voltage");
    expect(readme).toContain("deg");
    expect(await zip.file("LICENSE")!.async("string")).toContain("Apache License");
    expect(JSON.parse(await zip.file("spec.json")!.async("string")).id).toBe("test.tracker");
  });
});

function balanced(src: string): boolean {
  // strip strings/comments roughly, then check (), {}, [] balance
  const s = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])'/g, "''")
    .replace(/`[^`]*`/g, "");
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "}": "{", "]": "[" };
  for (const ch of s) {
    if ("({[".includes(ch)) stack.push(ch);
    else if (ch in pairs) { if (stack.pop() !== pairs[ch]) return false; }
  }
  return stack.length === 0;
}
