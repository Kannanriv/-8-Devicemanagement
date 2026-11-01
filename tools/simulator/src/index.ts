#!/usr/bin/env node
/**
 * #8 Device Management fleet simulator.
 *
 *   npm run simulate -- --devices 500 --rate 50 --transport mqtt --duration 120
 *   npm run simulate -- --mode bench
 *
 * Values evolve realistically (see generators.ts) and are ENCODED with the codec
 * runtime, so every payload is bit-exact with the device's DCS.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCodec } from "@hash8/codec-runtime";
import type { Codec } from "@hash8/dcs-schema";
import { HELP, parseArgs, type SimConfig } from "./config";
import { DeviceSimulator, hashSeed, mulberry32 } from "./generators";
import { loadSpecs, templatesFromVectors, type LoadedSpec } from "./specs";
import { Stats } from "./stats";
import { httpPublisher, mqttPublisher, parseDownlink, udpPublisher, type Publisher } from "./transports";
import { runBench } from "./bench";

export * from "./generators";
export * from "./config";
export { Stats, percentile } from "./stats";

interface SimDevice {
  serial: string;
  codec: Codec;
  sim: DeviceSimulator;
}

interface ApiDevice {
  serial: string;
  codecId?: string;
  lifecycle?: string;
}

async function fetchApiDevices(cfg: SimConfig): Promise<ApiDevice[]> {
  try {
    const res = await fetch(`${cfg.api}/api/v1/devices?limit=${cfg.devices}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { items?: ApiDevice[] } | ApiDevice[];
    return Array.isArray(body) ? body : (body.items ?? []);
  } catch (e) {
    console.error(`! could not list devices from ${cfg.api} (${(e as Error).message}) — synthesizing serials`);
    return [];
  }
}

const serialPrefix = (s: LoadedSpec) => s.spec.device.model.toUpperCase().replace(/[^A-Z0-9]/g, "") || "DEV";

async function buildFleet(cfg: SimConfig, specs: LoadedSpec[]): Promise<SimDevice[]> {
  const codecs = new Map<string, { codec: Codec; templates: Record<string, Record<string, unknown>> }>();
  for (const s of specs) {
    const codec = createCodec(s.spec);
    codecs.set(s.spec.id, { codec, templates: templatesFromVectors(codec) });
  }
  const api = cfg.fromApi ? await fetchApiDevices(cfg) : [];
  const fleet: SimDevice[] = [];
  const make = (serial: string, spec: LoadedSpec) => {
    const c = codecs.get(spec.spec.id)!;
    fleet.push({
      serial,
      codec: c.codec,
      sim: new DeviceSimulator(spec.spec, {
        serial,
        rng: mulberry32(hashSeed(serial) ^ cfg.seed),
        templates: c.templates,
        alarmRate: cfg.alarmRate,
      }),
    });
  };
  let rr = 0;
  for (const d of api.slice(0, cfg.devices)) {
    if (d.lifecycle === "retired") continue;
    const spec = specs.find((s) => s.spec.id === d.codecId) ?? specs[rr++ % specs.length]!;
    make(d.serial, spec);
  }
  if (api.length) console.log(`  using ${fleet.length} device(s) from the API`);
  for (let i = fleet.length; i < cfg.devices; i++) {
    const spec = specs[i % specs.length]!;
    make(`${serialPrefix(spec)}-SIM-${String(i + 1).padStart(6, "0")}`, spec);
  }
  return fleet;
}

type CommandLite = { id: string; status: string; createdAt: string };

/**
 * Acknowledge a downlink the way the API understands it:
 *  1. if the codec has an uplink message whose name contains "ack" (e.g. `config_ack`),
 *     send that uplink — the pipeline acks the device's oldest open command;
 *  2. otherwise POST /commands/:id/ack for the oldest open command (HTTP fallback).
 */
async function autoAck(cfg: SimConfig, dev: SimDevice, pub: Publisher, ids: Map<string, string>, commandId?: string) {
  const ackMsg = dev.sim.spec.uplink.find((m) => /ack/i.test(m.name));
  if (ackMsg) {
    const up = dev.sim.next(Date.now(), ackMsg.name);
    const enc = dev.codec.encode(up.message, up.data);
    if (enc.ok) return pub.publish(dev.serial, enc.port ?? up.port, enc.bytes);
  }
  const base = `${cfg.api}/api/v1`;
  let cmdId = commandId;
  if (!cmdId) {
    let id = ids.get(dev.serial);
    if (!id) {
      const r = await fetch(`${base}/devices?q=${encodeURIComponent(dev.serial)}&limit=5`);
      const body = (await r.json()) as { items?: { id: string; serial: string }[] };
      id = body.items?.find((d) => d.serial === dev.serial)?.id;
      if (!id) throw new Error(`ack: device ${dev.serial} not found in API`);
      ids.set(dev.serial, id);
    }
    const r = await fetch(`${base}/devices/${encodeURIComponent(id)}/commands`);
    const body = (await r.json()) as CommandLite[] | { items?: CommandLite[] };
    const list = Array.isArray(body) ? body : (body.items ?? []);
    cmdId = list
      .filter((c) => c.status === "queued" || c.status === "sent")
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0]?.id;
    if (!cmdId) return; // already acked / timed out
  }
  const res = await fetch(`${base}/commands/${encodeURIComponent(cmdId)}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor": `device:${dev.serial}` },
    body: JSON.stringify({ success: true }),
  });
  if (!res.ok) throw new Error(`ack HTTP ${res.status}`);
}

async function makePublisher(cfg: SimConfig, stats: Stats, bySerial: Map<string, SimDevice>): Promise<Publisher> {
  if (cfg.transport === "http") return httpPublisher(cfg.api);
  if (cfg.transport === "udp") return udpPublisher(cfg.udpHost, cfg.udpPort);
  const ids = new Map<string, string>();
  const holder: { pub?: Publisher } = {};
  const pub = await mqttPublisher(cfg.mqttUrl, cfg.connections, (d) => {
    stats.downlinks++;
    const dl = parseDownlink(d.payload);
    const dev = bySerial.get(d.serial);
    if (!cfg.quiet) console.log(`  ↓ ${d.serial} ${dl.hex}${dl.commandId ? ` (cmd ${dl.commandId})` : ""}${dev ? "" : " [not simulated]"}`);
    if (!dev || !holder.pub) return;
    // small device-side processing delay before acking
    setTimeout(() => {
      autoAck(cfg, dev, holder.pub!, ids, dl.commandId)
        .then(() => stats.acks++)
        .catch((e) => stats.error(e));
    }, 200);
  });
  holder.pub = pub;
  return pub;
}

async function runFleet(cfg: SimConfig, specs: LoadedSpec[]) {
  console.log(
    `\n#8 simulator — ${cfg.devices} devices · ${cfg.rate} msg/s · ${cfg.transport} · ` +
      `${cfg.duration ? `${cfg.duration}s` : "until Ctrl-C"} · specs: ${specs.map((s) => s.spec.id).join(", ")}`,
  );
  const fleet = await buildFleet(cfg, specs);
  const bySerial = new Map(fleet.map((d) => [d.serial, d]));
  const stats = new Stats();
  const pub = await makePublisher(cfg, stats, bySerial);
  console.log(`  target: ${cfg.transport === "mqtt" ? cfg.mqttUrl : cfg.transport === "udp" ? `udp://${cfg.udpHost}:${cfg.udpPort}` : cfg.api}\n`);

  let cursor = 0;
  let tokens = 0;
  let encodeLogged = 0;
  const TICK_MS = 50;

  const sendOne = () => {
    const dev = fleet[cursor++ % fleet.length]!;
    if (stats.inflight >= cfg.maxInflight) {
      stats.dropped++;
      return;
    }
    const up = dev.sim.next();
    const enc = dev.codec.encode(up.message, up.data);
    if (!enc.ok) {
      stats.encodeErrors++;
      if (encodeLogged++ < 5) console.error(`! encode ${dev.sim.spec.id}/${up.message}: ${enc.errors.map((e) => e.message).join("; ")}`);
      return;
    }
    const t0 = performance.now();
    stats.inflight++;
    pub
      .publish(dev.serial, enc.port ?? up.port, enc.bytes)
      .then(() => stats.record(performance.now() - t0))
      .catch((e) => stats.error(e))
      .finally(() => stats.inflight--);
  };

  const scheduler = setInterval(() => {
    tokens += (cfg.rate * TICK_MS) / 1000;
    while (tokens >= 1) {
      tokens--;
      sendOne();
    }
  }, TICK_MS);

  const reporter = setInterval(() => {
    const w = stats.tick();
    if (cfg.quiet) return;
    console.log(
      `  ${new Date().toISOString().slice(11, 19)}  sent/s ${w.rate.toFixed(1).padStart(8)}  total ${String(stats.sent).padStart(8)}  ` +
        `err ${stats.errors}${stats.encodeErrors ? ` enc-err ${stats.encodeErrors}` : ""}${stats.dropped ? ` dropped ${stats.dropped}` : ""}  ` +
        `inflight ${stats.inflight}  p50 ${w.p50.toFixed(1)}ms  p99 ${w.p99.toFixed(1)}ms` +
        (cfg.transport === "mqtt" ? `  ↓ ${stats.downlinks} ack ${stats.acks}` : "") +
        (stats.lastError ? `  last: ${stats.lastError.slice(0, 60)}` : ""),
    );
  }, 1000);

  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (cfg.duration > 0) setTimeout(stop, cfg.duration * 1000);
  });
  clearInterval(scheduler);
  clearInterval(reporter);
  const drainUntil = Date.now() + 5000;
  while (stats.inflight > 0 && Date.now() < drainUntil) await new Promise((r) => setTimeout(r, 50));
  await pub.close().catch(() => undefined);

  const s = stats.summary();
  console.log(
    `\nsummary: ${s.sent} sent in ${s.seconds.toFixed(1)}s (${s.avgRate.toFixed(1)}/s) · errors ${s.errors} · encode errors ${s.encodeErrors} · ` +
      `dropped ${s.dropped} · latency p50 ${s.p50.toFixed(1)}ms p99 ${s.p99.toFixed(1)}ms max ${s.max.toFixed(1)}ms` +
      (cfg.transport === "mqtt" ? ` · downlinks ${s.downlinks} acked ${s.acks}` : ""),
  );
  if (stats.lastError) console.log(`last error: ${stats.lastError}`);
  return s;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  const cfg = parseArgs(argv);
  const specs = loadSpecs(cfg.specs);
  if (cfg.mode === "bench") {
    runBench(specs, cfg.benchSeconds);
    return;
  }
  const s = await runFleet(cfg, specs);
  process.exitCode = s.sent === 0 && (s.errors > 0 || s.encodeErrors > 0) ? 1 : 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main()
    .then(() => process.exit())
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
