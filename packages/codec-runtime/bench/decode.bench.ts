/**
 * Decode throughput per sample spec vector.  Run: `npx tsx bench/decode.bench.ts`
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fromHex } from "@hash8/dcs-schema";
import { createCodec } from "../src/index";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../samples/specs");
const files = ["acme.tracker-gt200.json", "voltix.energy-em3.json", "envio.th-sense.json"];
const MS = Number(process.env.BENCH_MS ?? 400);

function bench(fn: () => void): number {
  for (let k = 0; k < 20_000; k++) fn(); // warm-up
  let n = 0;
  const t0 = performance.now();
  let t = t0;
  while (t - t0 < MS) {
    for (let k = 0; k < 1000; k++) fn();
    n += 1000;
    t = performance.now();
  }
  return (n / (t - t0)) * 1000;
}

const rows: { spec: string; vector: string; bytes: number; perSec: number }[] = [];
for (const f of files) {
  const codec = createCodec(JSON.parse(readFileSync(join(dir, f), "utf8")));
  for (const v of codec.spec.vectors) {
    if (v.direction !== "uplink") continue;
    const bytes = fromHex(v.hex);
    const ctx = { port: v.port, topic: v.topic };
    const r = codec.decode(bytes, ctx);
    if (!r.ok) throw new Error(`${f} ${v.name}: ${JSON.stringify(r.errors)}`);
    rows.push({ spec: codec.spec.id, vector: v.name, bytes: bytes.length, perSec: bench(() => codec.decode(bytes, ctx)) });
  }
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US").padStart(12);
console.log(`${"spec".padEnd(22)} ${"vector".padEnd(42)} ${"bytes".padStart(5)} ${"decodes/s".padStart(12)}`);
for (const r of rows) console.log(`${r.spec.padEnd(22)} ${r.vector.padEnd(42)} ${String(r.bytes).padStart(5)} ${fmt(r.perSec)}`);
for (const id of new Set(rows.map((r) => r.spec))) {
  const rs = rows.filter((r) => r.spec === id);
  console.log(`${id.padEnd(22)} mean ${fmt(rs.reduce((a, r) => a + r.perSec, 0) / rs.length)} decodes/s`);
}
