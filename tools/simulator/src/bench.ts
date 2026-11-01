/** In-process decode throughput per spec (no network) + capacity projection. */
import { createCodec } from "@hash8/codec-runtime";
import type { LoadedSpec, BenchPayload } from "./specs";
import { templatesFromVectors, vectorPayloads } from "./specs";
import { DeviceSimulator, mulberry32 } from "./generators";
import { projectCores, PEAK_FACTOR, TARGET_UTILISATION } from "./config";

export interface BenchRow {
  codec: string;
  payloads: number;
  avgBytes: number;
  decoded: number;
  failed: number;
  msgsPerSec: number;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/** Build a payload corpus: the spec's uplink vectors plus generated, codec-encoded messages. */
export function corpus(spec: LoadedSpec["spec"], codec: ReturnType<typeof createCodec>, n = 200): BenchPayload[] {
  const out = vectorPayloads(spec);
  const sim = new DeviceSimulator(spec, { rng: mulberry32(42), serial: "BENCH0001", templates: templatesFromVectors(codec) });
  let t = Date.now();
  for (let i = 0; i < n; i++) {
    const up = sim.next((t += 30_000));
    const r = codec.encode(up.message, up.data);
    if (r.ok) out.push({ bytes: r.bytes, port: r.port ?? up.port });
  }
  return out;
}

export function benchSpec(loaded: LoadedSpec, seconds: number): BenchRow {
  const codec = createCodec(loaded.spec);
  const payloads = corpus(loaded.spec, codec);
  const label = `${loaded.spec.id}@${loaded.spec.version}`;
  if (!payloads.length) return { codec: label, payloads: 0, avgBytes: 0, decoded: 0, failed: 0, msgsPerSec: 0 };
  // warm-up (JIT)
  for (let i = 0; i < 5_000; i++) {
    const p = payloads[i % payloads.length]!;
    codec.decode(p.bytes, { port: p.port, topic: p.topic });
  }
  let decoded = 0;
  let failed = 0;
  const deadline = performance.now() + seconds * 1000;
  let i = 0;
  const start = performance.now();
  let now = start;
  while (now < deadline) {
    for (let k = 0; k < 1000; k++, i++) {
      const p = payloads[i % payloads.length]!;
      if (codec.decode(p.bytes, { port: p.port, topic: p.topic }).ok) decoded++;
      else failed++;
    }
    now = performance.now();
  }
  const secs = (now - start) / 1000;
  return {
    codec: label,
    payloads: payloads.length,
    avgBytes: payloads.reduce((s, p) => s + p.bytes.length, 0) / payloads.length,
    decoded,
    failed,
    msgsPerSec: (decoded + failed) / secs,
  };
}

export function runBench(specs: LoadedSpec[], seconds: number): BenchRow[] {
  console.log(`\n#8 decode bench — single thread (= 1 core), ${seconds}s per codec, Node ${process.version}\n`);
  const rows: BenchRow[] = [];
  for (const s of specs) {
    const row = benchSpec(s, seconds);
    rows.push(row);
    console.log(
      `  ${row.codec.padEnd(34)} ${fmt(row.msgsPerSec).padStart(12)} msg/s/core   ` +
        `(${row.payloads} payloads, avg ${row.avgBytes.toFixed(1)} B, ${row.failed} failed)`,
    );
  }
  const valid = rows.filter((r) => r.msgsPerSec > 0);
  if (!valid.length) {
    console.log("\nno decodable payloads — nothing to project");
    return rows;
  }
  const worst = Math.min(...valid.map((r) => r.msgsPerSec));
  const mean = valid.reduce((s, r) => s + r.msgsPerSec, 0) / valid.length;
  console.log(`\n  worst-case ${fmt(worst)} msg/s/core · mean ${fmt(mean)} msg/s/core`);
  console.log(
    `\nCapacity projection (decoder CPU only, worst-case codec, ${TARGET_UTILISATION * 100}% target utilisation, peak = ${PEAK_FACTOR}× avg):\n`,
  );
  for (const p of projectCores(worst)) {
    console.log(
      `  ${p.scenario.padEnd(28)} avg ${fmt(p.avgMsgPerSec).padStart(7)} msg/s → ${String(p.coresAvg).padStart(3)} core(s)   ` +
        `peak ${fmt(p.peakMsgPerSec).padStart(7)} msg/s → ${String(p.coresPeak).padStart(3)} core(s)`,
    );
  }
  console.log(
    "\n  Decode is rarely the bottleneck: budget broker, Kafka and Timescale writes separately (docs/architecture.md §Sizing).\n",
  );
  return rows;
}
