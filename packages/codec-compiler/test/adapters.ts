/**
 * Executes generated plugins (ts, ts013, python) behind one uniform adapter so the
 * same conformance + behaviour suites run against each language.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import type { DeviceCodecSpec } from "@hash8/dcs-schema";
import { generatePlugin } from "../src";
import { writeFiles, fromHex, toHex } from "./helpers";
import { javaPackage } from "../src/targets/java";

export interface Op {
  op: "decode" | "encode" | "decodeDownlink";
  hex?: string;
  port?: number;
  topic?: string;
  message?: string;
  data?: Record<string, unknown>;
}
export interface OpResult {
  ok: boolean;
  message?: string;
  data?: unknown;
  hex?: string;
  port?: number;
  codes?: string[];
  warnings: string[];
}
export interface Adapter {
  run(ops: Op[]): Promise<OpResult[]>;
}

function norm(r: any): OpResult {
  if (r.ok) {
    return {
      ok: true,
      message: r.message,
      data: r.data,
      hex: r.bytes ? toHex(Uint8Array.from(r.bytes)) : undefined,
      port: r.port ?? undefined,
      warnings: r.warnings,
    };
  }
  return { ok: false, codes: r.errors.map((e: any) => e.code), warnings: r.warnings };
}

export async function tsAdapter(spec: DeviceCodecSpec): Promise<Adapter> {
  const files = generatePlugin(spec, "ts");
  const main = files.find((f) => f.path.endsWith(".ts") && !f.path.includes("test"))!;
  const js = ts.transpileModule(main.content, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const dir = writeFiles([{ path: "codec.mjs", content: js }], "ts");
  const mod: any = await import(pathToFileURL(path.join(dir, "codec.mjs")).href);
  return {
    async run(ops) {
      return ops.map((o) => {
        if (o.op === "encode") return norm(mod.encode(o.message, o.data));
        if (o.op === "decodeDownlink") return norm(mod.decodeDownlink(fromHex(o.hex!), o.port));
        return norm(mod.decode(fromHex(o.hex!), o.port, o.topic));
      });
    },
  };
}

export function ts013Adapter(spec: DeviceCodecSpec): Adapter {
  const files = generatePlugin(spec, "ts013");
  const main = files.find((f) => f.path.endsWith(".js") && !f.path.includes("test"))!;
  const ctx: any = vm.createContext({});
  vm.runInContext(main.content, ctx);
  return {
    async run(ops) {
      return ops.map((o) => {
        if (o.op === "encode") {
          const r = ctx.encodeDownlink({ data: { message: o.message, ...o.data } });
          return r.errors.length
            ? { ok: false, codes: r.errors.map((e: string) => e.split(":")[0]), warnings: r.warnings }
            : { ok: true, hex: toHex(Uint8Array.from(r.bytes)), port: r.fPort, warnings: r.warnings };
        }
        const input = { bytes: Array.from(fromHex(o.hex!)), fPort: o.port };
        const r = o.op === "decodeDownlink" ? ctx.decodeDownlink(input) : ctx.decodeUplink(input);
        return r.errors.length
          ? { ok: false, codes: r.errors.map((e: string) => e.split(":")[0]), warnings: r.warnings }
          : { ok: true, data: r.data, warnings: r.warnings };
      });
    },
  };
}

const PY_RUNNER = `
import json, sys, importlib
sys.path.insert(0, sys.argv[1])
codec = importlib.import_module(sys.argv[2])
ops = json.load(open(sys.argv[3]))
out = []
for o in ops:
    if o["op"] == "encode":
        r = codec.encode(o["message"], o["data"])
    elif o["op"] == "decodeDownlink":
        r = codec.decode_downlink(bytes.fromhex(o["hex"]), o.get("port"))
    else:
        r = codec.decode(bytes.fromhex(o["hex"]), o.get("port"), o.get("topic"))
    if r["ok"] and "bytes" in r:
        r["bytes"] = list(r["bytes"])
    out.append(r)
print(json.dumps(out))
`;

export function pythonAdapter(spec: DeviceCodecSpec): Adapter & { dir: string; files: string[] } {
  const files = generatePlugin(spec, "python");
  const dir = writeFiles(files, "py");
  fs.writeFileSync(path.join(dir, "_runner.py"), PY_RUNNER);
  const mod = files.find((f) => f.path.endsWith(".py") && !path.basename(f.path).startsWith("test_"))!;
  const modDir = path.join(dir, path.dirname(mod.path));
  const modName = path.basename(mod.path, ".py");
  return {
    dir,
    files: files.map((f) => f.path),
    async run(ops) {
      const job = path.join(dir, "_ops.json");
      fs.writeFileSync(job, JSON.stringify(ops));
      const out = execFileSync("python", ["-I", path.join(dir, "_runner.py"), modDir, modName, job], { encoding: "utf8" });
      return (JSON.parse(out) as any[]).map(norm);
    },
  };
}

const JAVA_RUNNER = (pkg: string) => String.raw`package ${pkg};

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;

public final class Runner {
    static void w(StringBuilder b, Object v) {
        if (v == null) {
            b.append("null");
        } else if (v instanceof String) {
            b.append('"');
            for (char c : ((String) v).toCharArray()) {
                if (c == '"' || c == '\\') b.append('\\').append(c);
                else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                else b.append(c);
            }
            b.append('"');
        } else if (v instanceof Double) {
            b.append(Double.toString((Double) v));
        } else if (v instanceof Boolean || v instanceof Number) {
            b.append(v);
        } else if (v instanceof byte[]) {
            StringBuilder h = new StringBuilder();
            for (byte x : (byte[]) v) h.append(String.format("%02x", x & 0xFF));
            w(b, h.toString());
        } else if (v instanceof Codec.CodecError) {
            b.append("{\"code\":");
            w(b, ((Codec.CodecError) v).code);
            b.append("}");
        } else if (v instanceof Map) {
            b.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) b.append(',');
                first = false;
                w(b, String.valueOf(e.getKey()));
                b.append(':');
                w(b, e.getValue());
            }
            b.append('}');
        } else if (v instanceof List) {
            b.append('[');
            boolean first = true;
            for (Object x : (List<?>) v) {
                if (!first) b.append(',');
                first = false;
                w(b, x);
            }
            b.append(']');
        } else {
            w(b, String.valueOf(v));
        }
    }

    static byte[] unhex(String h) {
        byte[] out = new byte[h.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(h.substring(i * 2, i * 2 + 2), 16);
        return out;
    }

    public static void main(String[] args) throws Exception {
        List<Object> ops = Codec.asList(Codec.Json.parse(new String(Files.readAllBytes(Paths.get(args[0])), StandardCharsets.UTF_8)));
        StringBuilder b = new StringBuilder("[");
        for (int i = 0; i < ops.size(); i++) {
            Map<String, Object> o = Codec.asMap(ops.get(i));
            if (i > 0) b.append(',');
            Integer port = o.get("port") == null ? null : ((Double) o.get("port")).intValue();
            String op = (String) o.get("op");
            Map<String, Object> m = new java.util.LinkedHashMap<>();
            if (op.equals("encode")) {
                Codec.EncodeResult r = Codec.encode((String) o.get("message"), Codec.asMap(o.get("data")));
                m.put("ok", r.ok); m.put("bytes", r.bytes); m.put("port", r.port); m.put("warnings", r.warnings); m.put("errors", r.errors);
            } else {
                Codec.DecodeResult r = op.equals("decodeDownlink")
                    ? Codec.decodeDownlink(unhex((String) o.get("hex")), port)
                    : Codec.decode(unhex((String) o.get("hex")), port, (String) o.get("topic"));
                m.put("ok", r.ok); m.put("message", r.message); m.put("data", r.data); m.put("warnings", r.warnings); m.put("errors", r.errors);
            }
            w(b, m);
        }
        System.out.println(b.append(']'));
    }
}
`;

export const JAVA_BIN = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin") : "C:/Program Files/Android/Android Studio/jbr/bin";
export const hasJava = fs.existsSync(path.join(JAVA_BIN, process.platform === "win32" ? "javac.exe" : "javac"));

export function javaAdapter(spec: DeviceCodecSpec): Adapter {
  const files = generatePlugin(spec, "java");
  const pkg = javaPackage(spec);
  const runner = { path: `java/src/test/java/${pkg.replace(/\./g, "/")}/Runner.java`, content: JAVA_RUNNER(pkg) };
  const dir = writeFiles([...files, runner], "javad");
  execFileSync(path.join(JAVA_BIN, "javac"), ["--release", "11", "-d", path.join(dir, "out"), ...[...files, runner].map((f) => path.join(dir, f.path))]);
  return {
    async run(ops) {
      const job = path.join(dir, "_ops.json");
      fs.writeFileSync(job, JSON.stringify(ops));
      const out = execFileSync(path.join(JAVA_BIN, "java"), ["-cp", path.join(dir, "out"), `${pkg}.Runner`, job], { encoding: "utf8" });
      return (JSON.parse(out) as any[]).map((r) => {
        if (r.ok && typeof r.bytes === "string") r.bytes = Array.from(fromHex(r.bytes));
        return norm(r);
      });
    },
  };
}
