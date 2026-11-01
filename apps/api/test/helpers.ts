import type { FastifyInstance } from "fastify";
import { buildServer, type BuiltServer } from "../src/server";
import { testConfig, type AppConfig } from "../src/config";

let shared: Promise<BuiltServer> | undefined;

/** One seeded in-memory server per test file (PGlite boot + seed is the slow part). */
export function getServer(overrides: Partial<AppConfig> = {}): Promise<BuiltServer> {
  shared ??= buildServer({}, testConfig(overrides));
  return shared;
}

export async function json<T = any>(app: FastifyInstance, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
  const res = await app.inject({
    method: method as "GET",
    url: `/api/v1${url}`,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  let parsed: unknown = undefined;
  try {
    parsed = res.body ? JSON.parse(res.body) : undefined;
  } catch {
    parsed = res.body;
  }
  return { status: res.statusCode, body: parsed as T, headers: res.headers as Record<string, unknown> };
}
