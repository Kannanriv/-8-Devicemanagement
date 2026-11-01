#!/usr/bin/env node
/**
 * #8 Device Management MCP server (stdio).
 *
 * Env:
 *   HASH8_API_URL   default http://localhost:4000/api/v1
 *   HASH8_TENANT_ID optional tenant header (dev auth)
 *   HASH8_ACTOR     audit actor, default "agent:mcp"
 *
 * stdout is the MCP transport — log to stderr only.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Hash8Client } from "@hash8/sdk-ts";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server";

async function main() {
  const client = new Hash8Client({
    baseUrl: process.env.HASH8_API_URL ?? "http://localhost:4000/api/v1",
    tenantId: process.env.HASH8_TENANT_ID,
    actor: process.env.HASH8_ACTOR ?? "agent:mcp",
  });
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} ${SERVER_VERSION} MCP server on stdio → ${client.baseUrl}`);
}

main().catch((e) => {
  console.error("hash8-dm MCP server failed:", e);
  process.exit(1);
});
