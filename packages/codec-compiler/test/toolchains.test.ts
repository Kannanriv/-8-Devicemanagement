/**
 * Runs the per-language test suites that the compiler generates (vectors + round-trip)
 * with the real toolchains. Languages whose toolchain is missing are skipped here and
 * covered by .github/workflows/conformance.yml.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generatePlugin } from "../src";
import { javaPackage } from "../src/targets/java";
import { loadSpecs, writeFiles, repoRoot } from "./helpers";

const specs = loadSpecs();

function which(cmd: string, extra: string[] = []): string | null {
  for (const p of extra) if (fs.existsSync(p)) return p;
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0]!.trim() : null;
}

function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: false });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
}

const javaHome = process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, "bin"))
  ? path.join(process.env.JAVA_HOME, "bin")
  : "C:/Program Files/Android/Android Studio/jbr/bin";
const exe = process.platform === "win32" ? ".exe" : "";
const javac = which("javac", [path.join(javaHome, `javac${exe}`)]);
const java = which("java", [path.join(javaHome, `java${exe}`)]);
const go = which("go");
const cc = which("gcc") ?? which("cc") ?? which("clang");
const tsx = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");

describe.each(specs)("generated test suites — $name", ({ spec }) => {
  it("python unittest passes", () => {
    const dir = writeFiles(generatePlugin(spec, "python"), "pyt");
    const r = run("python", ["-m", "unittest", "-q"], path.join(dir, "python"));
    expect(r.code, r.out).toBe(0);
  });

  it("ts013 node test passes", () => {
    const dir = writeFiles(generatePlugin(spec, "ts013"), "t13");
    const r = run(process.execPath, ["codec.test.js"], path.join(dir, "ts013"));
    expect(r.code, r.out).toBe(0);
  });

  it("ts test passes under tsx", () => {
    const dir = writeFiles(generatePlugin(spec, "ts"), "tst");
    const r = spawnSync(tsx, ["codec.test.ts"], { cwd: path.join(dir, "ts"), encoding: "utf8", shell: process.platform === "win32" });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  }, 30_000);

  it.skipIf(!javac || !java)("java compiles with --release 11 and CodecTest passes", () => {
    const dir = writeFiles(generatePlugin(spec, "java"), "jav");
    const srcs = generatePlugin(spec, "java").map((f) => path.join(dir, f.path));
    const c = run(javac!, ["--release", "11", "-Xlint:all", "-d", path.join(dir, "out"), ...srcs], dir);
    expect(c.code, c.out).toBe(0);
    expect(c.out, "javac warnings").not.toMatch(/warning/);
    const r = run(java!, ["-cp", path.join(dir, "out"), `${javaPackage(spec)}.CodecTest`], dir);
    expect(r.code, r.out).toBe(0);
  }, 60_000);

  it.skipIf(!go)("go test passes", () => {
    const dir = writeFiles(generatePlugin(spec, "go"), "go");
    const r = run(go!, ["test", "./..."], path.join(dir, "go"));
    expect(r.code, r.out).toBe(0);
  }, 120_000);

  it.skipIf(!cc)("c test program passes", () => {
    const dir = writeFiles(generatePlugin(spec, "c"), "c");
    const r = run("make", ["test"], path.join(dir, "c"));
    expect(r.code, r.out).toBe(0);
  }, 120_000);
});
