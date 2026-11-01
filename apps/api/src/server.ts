import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { ZodError } from "zod";
import { OpsError } from "@hash8/ops-engine";
import { loadConfig, type AppConfig } from "./config";
import { createPlatform, type Platform } from "./platform";
import { ApiError } from "./errors";
import { seedIfEmpty } from "./seed/seed";
import { startRuntime } from "./runtime";
import opsModule from "./modules/ops";
import inventoryModule from "./modules/inventory";
import deviceOpsModule from "./modules/device-ops";
import codecsModule from "./modules/codecs";
import ingestModule from "./modules/ingest";
import firmwareOtaModule from "./modules/firmware-ota";
import rulesModule from "./modules/rules";
import fleetV11Module from "./modules/fleet-v11";

export interface BuiltServer {
  app: FastifyInstance;
  platform: Platform;
}

export async function buildServer(overrides: Partial<AppConfig> = {}, configIn?: AppConfig): Promise<BuiltServer> {
  const config = configIn ?? loadConfig(overrides);
  const app = Fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel },
    bodyLimit: 16 * 1024 * 1024,
    disableRequestLogging: config.logLevel !== "debug",
  });
  const platform = await createPlatform(config, app.log);

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "x-tenant-id", "x-actor", "authorization"],
    exposedHeaders: ["content-disposition"],
  });
  await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 1 } });
  await app.register(websocket);

  app.addContentTypeParser(["text/csv", "text/plain"], { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    if (err instanceof OpsError) return reply.status(409).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: "BAD_REQUEST", message: err.issues.map((i) => i.message).join("; ") } });
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: { code: e.code ?? "BAD_REQUEST", message: e.message } });
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "INTERNAL", message: "Internal server error" } });
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url} not found` } }));

  app.get("/healthz", async () => ({ ok: true }));

  const liveHandler = (socket: { send(d: string): void; readyState: number; on(ev: string, fn: () => void): void }, req: { headers: Record<string, unknown>; query: unknown }) => {
    const q = (req.query ?? {}) as { tenantId?: string };
    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? q.tenantId;
    const client: { send(d: string): void; readyState: number; tenantId?: string } = socket as never;
    if (tenantId) client.tenantId = tenantId;
    const off = platform.live.add(client);
    socket.on("close", () => off());
    socket.send(JSON.stringify({ type: "hello", payload: { at: new Date().toISOString() } }));
  };
  app.register(async (ws) => {
    ws.get("/live", { websocket: true }, liveHandler as never);
    ws.get("/api/v1/live", { websocket: true }, liveHandler as never);
  });

  await app.register(
    async (api) => {
      for (const m of [opsModule, inventoryModule, deviceOpsModule, codecsModule, ingestModule, firmwareOtaModule, rulesModule, fleetV11Module]) {
        await api.register(m, { p: platform });
      }
    },
    { prefix: "/api/v1" },
  );

  if (config.seed) await seedIfEmpty(platform);
  const stopRuntime = await startRuntime(platform);

  app.addHook("onClose", async () => {
    await stopRuntime();
    platform.integrations.stop();
    await platform.pipeline.drain();
    await platform.db.close();
  });

  return { app, platform };
}
