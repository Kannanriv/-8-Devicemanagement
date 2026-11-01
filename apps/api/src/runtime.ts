import { createServer, type Server } from "node:net";
import { createSocket, type Socket } from "node:dgram";
import Aedes from "aedes";
import type { Device } from "@hash8/sdk-ts";
import type { Platform } from "./platform";
import { PayloadGenerator, rng } from "./seed/generator";

/** Parse `dev/{serial}/up[/{port}]`. */
export function parseUplinkTopic(topic: string): { serial: string; port?: number } | undefined {
  const m = /^dev\/([^/]+)\/up(?:\/(\d{1,5}))?$/.exec(topic);
  if (!m) return undefined;
  const out: { serial: string; port?: number } = { serial: decodeURIComponent(m[1]!) };
  if (m[2] !== undefined) out.port = Number(m[2]);
  return out;
}

/** Parse a UDP datagram `serial|port|hex` (port may be empty). */
export function parseUdpDatagram(text: string): { serial: string; port?: number; hex: string } | undefined {
  const parts = text.trim().split("|");
  if (parts.length !== 3) return undefined;
  const [serial, port, hex] = parts as [string, string, string];
  if (!serial || !hex) return undefined;
  const out: { serial: string; port?: number; hex: string } = { serial, hex };
  if (port !== "") {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 0 || n > 65535) return undefined;
    out.port = n;
  }
  return out;
}

/** Starts transports (MQTT/UDP) and dev tickers according to config. Returns a stopper. */
export async function startRuntime(p: Platform): Promise<() => Promise<void>> {
  const { config, core } = p;
  const log = core.log;
  const stops: (() => Promise<void> | void)[] = [];

  if (config.enableTransports) {
    // ── Embedded MQTT broker (aedes) ──
    const broker = new Aedes();
    const server: Server = createServer(broker.handle as never);
    broker.on("publish", (packet, client) => {
      if (!client) return; // our own downlinks
      const t = parseUplinkTopic(packet.topic);
      if (!t) return;
      const hex = Buffer.isBuffer(packet.payload) ? packet.payload.toString("hex") : Buffer.from(String(packet.payload)).toString("hex");
      const u: Parameters<typeof p.pipeline.push>[0] = { serial: t.serial, transport: "mqtt", payloadHex: hex, topic: packet.topic };
      if (t.port !== undefined) u.port = t.port;
      p.pipeline.push(u);
    });
    p.commands.addSender((device: Device, bytes: Uint8Array, port?: number) => {
      broker.publish(
        { cmd: "publish", topic: `dev/${device.serial}/down`, payload: Buffer.from(bytes), qos: 1, retain: false, dup: false, ...(port !== undefined ? { properties: { userProperties: { port: String(port) } } } : {}) } as never,
        () => {},
      );
      return true;
    });
    await new Promise<void>((resolve) => {
      server.once("error", (err) => {
        log.warn({ err }, `MQTT broker could not listen on :${config.mqttPort}`);
        resolve();
      });
      server.listen(config.mqttPort, () => {
        log.info(`MQTT broker listening on tcp://localhost:${config.mqttPort} (dev/{serial}/up[/port])`);
        resolve();
      });
    });
    stops.push(
      () =>
        new Promise<void>((r) => {
          broker.close(() => server.close(() => r()));
          setTimeout(r, 1000).unref();
        }),
    );

    // ── UDP adapter ──
    const udp: Socket = createSocket("udp4");
    udp.on("message", (msg) => {
      const d = parseUdpDatagram(msg.toString("utf8"));
      if (!d) return;
      const u: Parameters<typeof p.pipeline.push>[0] = { serial: d.serial, transport: "udp", payloadHex: d.hex };
      if (d.port !== undefined) u.port = d.port;
      p.pipeline.push(u);
    });
    udp.on("error", (err) => log.warn({ err }, `UDP listener error on :${config.udpPort}`));
    udp.bind(config.udpPort, () => log.info(`UDP ingest listening on :${config.udpPort} (serial|port|hex)`));
    stops.push(() => new Promise<void>((r) => udp.close(() => r())));
  }

  if (config.enableTickers) {
    const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
      let busy = false;
      const t = setInterval(() => {
        if (busy) return;
        busy = true;
        fn()
          .catch((err) => log.warn({ err }, `${name} ticker failed`))
          .finally(() => (busy = false));
      }, ms);
      t.unref();
      stops.push(() => clearInterval(t));
    };
    every(30_000, "health", async () => {
      await p.devices.sweepHealth();
      await p.automations.sweepOffline();
    });
    every(config.commandSweepMs, "commands", () => p.commands.sweep());
    every(config.otaTickMs, "ota", () => p.ota.tick());
    every(60_000, "usage", () => p.integrations.flushUsage());
  }

  if (config.simTraffic) {
    const stop = await startSimTraffic(p);
    stops.push(stop);
  }

  return async () => {
    for (const s of stops.reverse()) await s();
  };
}

/** Dev traffic: encodes realistic uplinks for a rotating subset of active devices and pushes them through the real pipeline. */
export async function startSimTraffic(p: Platform): Promise<() => void> {
  const rand = rng(Date.now() & 0xffff);
  const generators = new Map<string, PayloadGenerator | null>();
  const gen = async (d: Device) => {
    const r = await p.codecs.resolveForDevice(d);
    if (!r) return undefined;
    const key = `${r.codecId}@${r.version}`;
    if (!generators.has(key)) {
      try {
        const { codec } = await p.codecs.get(r.codecId, r.version);
        const g = new PayloadGenerator(codec.spec, codec);
        generators.set(key, g.usable ? g : null);
      } catch {
        generators.set(key, null);
      }
    }
    return generators.get(key) ?? undefined;
  };
  let pool: Device[] = [];
  const refresh = async () => {
    const page = await p.repos.devices.list(undefined, { lifecycle: "activated", limit: 500 });
    pool = page.items.filter((_, i) => i % 3 === 0).slice(0, 60);
  };
  await refresh();
  let ticks = 0;
  const t = setInterval(() => {
    void (async () => {
      if (++ticks % 30 === 0) await refresh();
      const n = Math.min(pool.length, 4 + Math.floor(rand() * 6));
      for (let i = 0; i < n; i++) {
        const d = pool[Math.floor(rand() * pool.length)]!;
        const g = await gen(d);
        if (!g) continue;
        const up = g.next({ serial: d.serial, ...(d.site?.lat !== undefined ? { lat: d.site.lat } : {}), ...(d.site?.lng !== undefined ? { lng: d.site.lng } : {}), phase: (Date.now() / 86_400_000) % 1, anomaly: rand() < 0.03 }, rand);
        const u: Parameters<typeof p.pipeline.push>[0] = { serial: d.serial, transport: "sim", payloadHex: up.hex };
        if (up.port !== undefined) u.port = up.port;
        if (up.topic !== undefined) u.topic = up.topic;
        p.pipeline.push(u);
      }
      // occasional garbage payload → exercises the unknown-payload path
      if (rand() < 0.05 && pool.length) p.pipeline.push({ serial: pool[0]!.serial, transport: "sim", payloadHex: "ff" + Math.floor(rand() * 0xffffff).toString(16).padStart(6, "0"), port: 99 });
    })().catch((err) => p.core.log.warn({ err }, "sim traffic failed"));
  }, p.config.simIntervalMs);
  t.unref();
  p.core.log.info(`Simulated traffic on: ${pool.length} devices every ${p.config.simIntervalMs}ms`);
  return () => clearInterval(t);
}
