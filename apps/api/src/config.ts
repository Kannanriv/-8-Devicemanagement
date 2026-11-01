import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
export const API_ROOT = resolve(here, "..");
export const REPO_ROOT = resolve(API_ROOT, "../..");

export interface AppConfig {
  port: number;
  host: string;
  /** "memory" → in-memory PGlite (tests); otherwise a directory for PGlite persistence. */
  db: string;
  dataDir: string;
  firmwareDir: string;
  specsDir: string;
  excelDir: string;
  mqttPort: number;
  udpPort: number;
  /** Start embedded MQTT broker / UDP listener. Disabled in tests. */
  enableTransports: boolean;
  /** Push simulated uplinks through the real pipeline. */
  simTraffic: boolean;
  simIntervalMs: number;
  /** OTA ticker interval (dev simulation of device results). */
  otaTickMs: number;
  commandSweepMs: number;
  enableTickers: boolean;
  seed: boolean;
  /** Number of seeded devices / historical messages. */
  seedDevices: number;
  seedMessages: number;
  corsOrigins: string[];
  pipelineConcurrency: number;
  anthropicApiKey?: string;
  logLevel: string;
  /** Production topology hints (optional; ignored in dev mode). */
  role: "all" | "api" | "ingest" | "decoder";
  databaseUrl?: string;
  kafkaBrokers?: string[];
  redisUrl?: string;
  s3?: { endpoint?: string; bucket?: string; region?: string };
  metricsPort?: number;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  return v === "1" || v.toLowerCase() === "true";
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = process.env;
  const dataDir = env.DATA_DIR ?? resolve(API_ROOT, "data");
  const db = env.DB ?? resolve(dataDir, "pglite");
  const base: AppConfig = {
    port: Number(env.PORT ?? 4000),
    host: env.HOST ?? "0.0.0.0",
    db,
    dataDir,
    firmwareDir: resolve(dataDir, "firmware"),
    specsDir: env.SPECS_DIR ?? resolve(REPO_ROOT, "samples/specs"),
    excelDir: env.EXCEL_DIR ?? resolve(REPO_ROOT, "samples/excel"),
    mqttPort: Number(env.MQTT_PORT ?? 1883),
    udpPort: Number(env.UDP_PORT ?? 5684),
    enableTransports: bool(env.TRANSPORTS, true),
    simTraffic: bool(env.SIM_TRAFFIC, process.argv.includes("--sim")),
    simIntervalMs: Number(env.SIM_INTERVAL_MS ?? 4000),
    otaTickMs: Number(env.OTA_TICK_MS ?? 5000),
    commandSweepMs: Number(env.COMMAND_SWEEP_MS ?? 10000),
    enableTickers: bool(env.TICKERS, true),
    seed: bool(env.SEED, true),
    seedDevices: Number(env.SEED_DEVICES ?? 500),
    seedMessages: Number(env.SEED_MESSAGES ?? 10000),
    corsOrigins: (env.CONSOLE_ORIGINS ?? "http://localhost:3000,http://localhost:3100")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    pipelineConcurrency: Number(env.PIPELINE_CONCURRENCY ?? 8),
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    logLevel: env.LOG_LEVEL ?? "info",
    role: (["api", "ingest", "decoder"].includes(env.ROLE ?? "") ? env.ROLE : "all") as AppConfig["role"],
    databaseUrl: env.DATABASE_URL || undefined,
    kafkaBrokers: env.KAFKA_BROKERS ? env.KAFKA_BROKERS.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    redisUrl: env.REDIS_URL || undefined,
    s3: env.S3_BUCKET || env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET, region: env.S3_REGION } : undefined,
    metricsPort: env.METRICS_PORT ? Number(env.METRICS_PORT) : undefined,
  };
  return { ...base, ...overrides };
}

/** Config for tests: in-memory DB, no network listeners, no tickers. */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return loadConfig({
    db: "memory",
    dataDir: join(tmpdir(), `hash8-api-test-${process.pid}`),
    firmwareDir: join(tmpdir(), `hash8-api-test-${process.pid}`, "firmware"),
    enableTransports: false,
    simTraffic: false,
    enableTickers: false,
    seedDevices: 60,
    seedMessages: 300,
    logLevel: "silent",
    ...overrides,
  });
}
