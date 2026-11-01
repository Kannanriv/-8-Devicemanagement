/** CLI argument parsing and capacity math (pure, unit-tested). */

export type Transport = "mqtt" | "http" | "udp";
export type Mode = "run" | "bench";

export interface SimConfig {
  mode: Mode;
  devices: number;
  /** Total messages/sec across the fleet. */
  rate: number;
  transport: Transport;
  /** Seconds; 0 = until Ctrl-C. */
  duration: number;
  api: string;
  mqttUrl: string;
  udpHost: string;
  udpPort: number;
  specs: string;
  connections: number;
  maxInflight: number;
  alarmRate: number;
  seed: number;
  /** Bench: seconds per spec. */
  benchSeconds: number;
  fromApi: boolean;
  quiet: boolean;
}

export const HELP = `#8 Device Management — fleet simulator

Usage: npm run simulate -- [options]

  --devices N          simulated devices (default 100)
  --rate R             total uplinks/sec across the fleet (default 10)
  --transport T        mqtt | http | udp (default http)
  --duration S         seconds to run, 0 = until Ctrl-C (default 60)
  --api URL            API origin (default http://localhost:4000)
  --mqtt URL           broker (default mqtt://<api host>:1883)
  --udp HOST:PORT      UDP ingest (default <api host>:5684)
  --specs DIR          DCS spec directory (default ../../samples/specs)
  --connections K      MQTT client connections to spread devices over (default min(devices,8))
  --max-inflight N     cap on concurrent publishes; excess is counted as dropped (default 2000)
  --alarm-rate P       per-message alarm probability (default 0.01)
  --seed N             RNG seed (default 8)
  --no-api             don't fetch devices from the API; synthesize serials
  --mode bench         in-process decode throughput per spec (no network)
  --bench-seconds S    seconds per spec in bench mode (default 2)
  --quiet              summary only
`;

function num(name: string, v: string | undefined, min = 0): number {
  const n = Number(v);
  if (v === undefined || !Number.isFinite(n) || n < min) throw new Error(`--${name} expects a number >= ${min}, got "${v}"`);
  return n;
}

export function parseArgs(argv: string[]): SimConfig {
  const raw: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument "${a}"`);
    const [k, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
    if (inline !== undefined) raw[k] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) raw[k] = argv[++i]!;
    else raw[k] = true;
  }
  const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
  const known = new Set([
    "devices", "rate", "transport", "duration", "api", "mqtt", "udp", "specs", "connections",
    "max-inflight", "alarm-rate", "seed", "no-api", "mode", "bench-seconds", "quiet", "help",
  ]);
  for (const k of Object.keys(raw)) if (!known.has(k)) throw new Error(`unknown option --${k}`);

  const api = (s("api") ?? "http://localhost:4000").replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  const host = new URL(api).hostname;
  const transport = (s("transport") ?? "http") as Transport;
  if (!["mqtt", "http", "udp"].includes(transport)) throw new Error(`--transport must be mqtt|http|udp`);
  const mode = (s("mode") ?? "run") as Mode;
  if (!["run", "bench"].includes(mode)) throw new Error(`--mode must be run|bench`);
  const udp = s("udp") ?? `${host}:5684`;
  const [udpHost, udpPortStr] = udp.split(":");
  const devices = s("devices") ? num("devices", s("devices"), 1) : 100;

  return {
    mode,
    devices: Math.floor(devices),
    rate: s("rate") ? num("rate", s("rate")) : 10,
    transport,
    duration: s("duration") ? num("duration", s("duration")) : 60,
    api,
    mqttUrl: s("mqtt") ?? `mqtt://${host}:1883`,
    udpHost: udpHost || host,
    udpPort: udpPortStr ? num("udp port", udpPortStr, 1) : 5684,
    specs: s("specs") ?? "../../samples/specs",
    connections: s("connections") ? Math.floor(num("connections", s("connections"), 1)) : Math.min(devices, 8),
    maxInflight: s("max-inflight") ? Math.floor(num("max-inflight", s("max-inflight"), 1)) : 2000,
    alarmRate: s("alarm-rate") ? num("alarm-rate", s("alarm-rate")) : 0.01,
    seed: s("seed") ? num("seed", s("seed")) : 8,
    benchSeconds: s("bench-seconds") ? num("bench-seconds", s("bench-seconds")) : 2,
    fromApi: raw["no-api"] === undefined,
    quiet: raw.quiet !== undefined,
  };
}

// ── Capacity projection ─────────────────────────────────────────────────────
export const SECONDS_PER_DAY = 86_400;
export const PEAK_FACTOR = 5;
/** Plan decoders at 60% CPU so a pod loss or burst doesn't tip the group over. */
export const TARGET_UTILISATION = 0.6;

export interface Scenario {
  name: string;
  avgMsgPerSec: number;
}

export const SCENARIOS: Scenario[] = [
  { name: "1M devices @ 1 msg / 5 min", avgMsgPerSec: 1_000_000 / 300 },
  { name: "1B msgs / day", avgMsgPerSec: 1_000_000_000 / SECONDS_PER_DAY },
];

export interface Projection {
  scenario: string;
  avgMsgPerSec: number;
  peakMsgPerSec: number;
  coresAvg: number;
  coresPeak: number;
}

export function projectCores(msgsPerSecPerCore: number, scenarios = SCENARIOS): Projection[] {
  if (!(msgsPerSecPerCore > 0)) throw new Error("throughput must be > 0");
  return scenarios.map((s) => {
    const peak = s.avgMsgPerSec * PEAK_FACTOR;
    return {
      scenario: s.name,
      avgMsgPerSec: s.avgMsgPerSec,
      peakMsgPerSec: peak,
      coresAvg: Math.max(1, Math.ceil(s.avgMsgPerSec / (msgsPerSecPerCore * TARGET_UTILISATION))),
      coresPeak: Math.max(1, Math.ceil(peak / (msgsPerSecPerCore * TARGET_UTILISATION))),
    };
  });
}
