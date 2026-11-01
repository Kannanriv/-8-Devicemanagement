import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config";
import { buildServer } from "./server";

export { buildServer } from "./server";
export { loadConfig, testConfig } from "./config";

async function main() {
  const config = loadConfig();
  const { app, platform } = await buildServer({}, config);
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `#8 Device Management API on http://localhost:${config.port}/api/v1 (db=${config.db === "memory" ? "memory" : "pglite"}, sim=${config.simTraffic ? "on" : "off"}, llm=${platform.agents.llmEnabled ? "claude" : "fallback"})`,
  );
  const shutdown = async (sig: string) => {
    app.log.info(`${sig} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 8000);
    force.unref();
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

const isMain = !!process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
