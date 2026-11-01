/**
 * `npm run seed:reset -w @hash8/api` — wipe the dev PGlite database and re-seed demo data.
 * PGlite is single-process: stop the dev server first, or call POST /api/v1/admin/demo/reset instead.
 */
import pino from "pino";
import type { FastifyBaseLogger } from "fastify";
import { loadConfig } from "../config";
import { createPlatform } from "../platform";
import { resetDemo } from "./seed";

async function main() {
  const config = loadConfig({ enableTransports: false, enableTickers: false, simTraffic: false });
  const log = pino({ level: "info" }) as unknown as FastifyBaseLogger;
  const t0 = Date.now();
  const p = await createPlatform(config, log);
  const stats = await resetDemo(p);
  await p.db.close();
  console.log(`Demo data reset in ${Date.now() - t0}ms (${config.db}):`, stats);
}

main().catch((err) => {
  console.error(err instanceof Error && /lock|already/i.test(err.message) ? `${err.message}\nIs the API running? Stop it or use POST /api/v1/admin/demo/reset.` : err);
  process.exit(1);
});
