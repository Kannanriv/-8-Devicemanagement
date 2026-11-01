import type { FastifyInstance } from "fastify";
import type { Platform } from "../platform";
import { reqCtx } from "../http";

export default async function opsModule(app: FastifyInstance, { p }: { p: Platform }) {
  app.get("/ops/inbox", async (req) => p.stats.inbox((await reqCtx(p, req)).tenantId));
  app.get("/fleet/stats", async (req) => p.stats.fleetStats((await reqCtx(p, req)).tenantId));
  app.get("/tenants", async () => p.core.tenants());
  app.get("/system", async () => ({
    pipeline: { processed: p.pipeline.processed, failed: p.pipeline.failed, queueDepth: p.pipeline.queueDepth },
    deliveries: p.integrations.queueStats(),
    liveClients: p.live.size,
    llm: p.agents.llmEnabled ? "claude" : "deterministic-fallback",
  }));
}
