/**
 * Differential test: the generated TS plugin must agree with @hash8/codec-runtime
 * (the reference interpreter) on vectors and on mutated payloads (truncated,
 * extended, bit-flipped) — same ok/message/data/warnings, same error codes.
 */
import { describe, it, expect } from "vitest";
import { createCodec } from "@hash8/codec-runtime";
import { fromHex } from "@hash8/dcs-schema";
import { loadSpecs, diff } from "./helpers";
import { tsAdapter, type Op } from "./adapters";

const specs = loadSpecs();

function mutations(hex: string): string[] {
  const b = fromHex(hex);
  const out: string[] = [];
  const h = (a: Uint8Array) => Array.from(a, (x) => x.toString(16).padStart(2, "0")).join("");
  out.push(h(b.slice(0, Math.max(0, b.length - 1))), h(b.slice(0, Math.floor(b.length / 2))), h(new Uint8Array([...b, 0])));
  for (let i = 0; i < b.length; i++) {
    for (const mask of [0x01, 0x80, 0xff]) {
      const c = b.slice();
      c[i] = c[i]! ^ mask;
      out.push(h(c));
    }
  }
  return out;
}

describe.each(specs)("runtime parity — $name", ({ spec }) => {
  it("decodes vectors and mutated payloads exactly like @hash8/codec-runtime", async () => {
    const ref = createCodec(spec);
    const plugin = await tsAdapter(spec);
    const cases: Op[] = [];
    for (const v of spec.vectors) {
      if (v.direction === "downlink") continue;
      for (const hex of [v.hex, ...mutations(v.hex)]) cases.push({ op: "decode", hex, port: v.port, topic: v.topic });
    }
    const got = await plugin.run(cases);
    const problems: string[] = [];
    cases.forEach((c, i) => {
      const r = ref.decode(fromHex(c.hex!), { port: c.port, topic: c.topic });
      const p = got[i]!;
      const tag = `${c.hex} port=${c.port ?? "-"}`;
      if (r.ok !== p.ok) return problems.push(`${tag}: ok ${r.ok} vs ${p.ok}`);
      if (r.ok) {
        if (r.message !== p.message) problems.push(`${tag}: message ${r.message} vs ${p.message}`);
        for (const d of diff(r.data, p.data)) problems.push(`${tag}: ${d}`);
        if (JSON.stringify(r.warnings) !== JSON.stringify(p.warnings)) problems.push(`${tag}: warnings ${JSON.stringify(r.warnings)} vs ${JSON.stringify(p.warnings)}`);
      } else if (JSON.stringify(r.errors.map((e) => e.code)) !== JSON.stringify(p.codes)) {
        problems.push(`${tag}: codes ${r.errors.map((e) => e.code)} vs ${p.codes}`);
      }
    });
    expect(problems.slice(0, 15)).toEqual([]);
  });

  it("encodes vector data exactly like @hash8/codec-runtime", async () => {
    const ref = createCodec(spec);
    const plugin = await tsAdapter(spec);
    const ops: Op[] = [];
    for (const v of spec.vectors) {
      let data = v.data;
      let msg = v.message;
      if (v.direction !== "downlink") {
        const d = ref.decode(fromHex(v.hex), { port: v.port, topic: v.topic });
        if (!d.ok) continue;
        data = d.data;
        msg = d.message;
      }
      if (!msg) continue;
      ops.push({ op: "encode", message: msg, data });
      // drop each top-level key in turn: error codes must agree too
      for (const k of Object.keys(data)) {
        const { [k]: _drop, ...rest } = data;
        ops.push({ op: "encode", message: msg, data: rest });
      }
    }
    const got = await plugin.run(ops);
    const problems: string[] = [];
    ops.forEach((o, i) => {
      const r = ref.encode(o.message!, o.data!);
      const p = got[i]!;
      const tag = `${o.message} ${JSON.stringify(o.data)}`;
      if (r.ok !== p.ok) return problems.push(`${tag}: ok ${r.ok} vs ${p.ok} ${p.codes ?? ""} ${r.ok ? "" : r.errors.map((e) => e.code)}`);
      if (r.ok) {
        const hex = Array.from(r.bytes, (x) => x.toString(16).padStart(2, "0")).join("");
        if (hex !== p.hex) problems.push(`${tag}: bytes ${hex} vs ${p.hex}`);
        if ((r.port ?? undefined) !== p.port) problems.push(`${tag}: port ${r.port} vs ${p.port}`);
      } else if (JSON.stringify(r.errors.map((e) => e.code)) !== JSON.stringify(p.codes)) {
        problems.push(`${tag}: codes ${r.errors.map((e) => e.code)} vs ${p.codes}`);
      }
    });
    expect(problems.slice(0, 15)).toEqual([]);
  });
});
