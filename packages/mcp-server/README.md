# @hash8/mcp-server

A stdio MCP server that gives Claude (or any MCP client) access to #8 Device Management: the ops inbox, fleet, devices, codecs, OTA and the platform's AI agents. It calls the REST API through `Hash8Client`.

| Tool | What it does | Hints |
|---|---|---|
| `ops_inbox` | Prioritised ops items (rollouts, unknown payloads, offline cohorts, …) | read-only |
| `fleet_stats` | Fleet KPIs | read-only |
| `search_devices` | Inventory search with filters + cursor | read-only |
| `get_device` | Full device (by id, UDI **or serial**) + allowed lifecycle transitions | read-only |
| `device_messages` / `device_timeline` | Raw + decoded history, unified timeline | read-only |
| `change_lifecycle` | Lifecycle transition, checked against the lifecycle graph first | **destructive** |
| `send_command` | Queue a codec-encoded downlink | write |
| `decode_payload` | Diagnostics decode of a hex payload | read-only |
| `list_codecs` / `get_codec` | Codec catalogue; summary or full DCS | read-only |
| `list_campaigns` / `pause_campaign` | OTA campaigns; emergency brake | write (idempotent) |
| `list_alerts` | Alerts filtered by status/severity/category/device | read-only |
| `inventory_kpis` | Inventory KPI cards (connected/stale/offline, pending install, OTA in progress, …) | read-only |
| `list_assets` | Assets + device association history | read-only |
| `swap_device` | Field swap of a device on an asset (old device → `swap` state) | **destructive** |
| `bulk_preview` | Eligibility dry-run for a bulk op (no side effects) | read-only |
| `fleet_report` | Reliability, deployment, OTA, failures, connectivity, utilization | read-only |
| `revoke_credential` | Revoke a device X.509/PSK/token credential (reason audited) | **destructive** |
| `run_agent` | Run one of the 7 AI agents | write |

## Run

```bash
npm run dev:api                          # the API on :4000
npm run start -w @hash8/mcp-server       # stdio server (normally your MCP client starts it)
```

Env: `HASH8_API_URL` (default `http://localhost:4000/api/v1`), `HASH8_TENANT_ID`, `HASH8_ACTOR` (default `agent:mcp`, written to the audit log).

## Claude Code

```bash
claude mcp add hash8-dm --env HASH8_API_URL=http://localhost:4000/api/v1 \
  -- npx tsx D:/Hash8/device-management/packages/mcp-server/src/index.ts
```

Or in the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "hash8-dm": {
      "command": "npx",
      "args": ["tsx", "packages/mcp-server/src/index.ts"],
      "env": { "HASH8_API_URL": "http://localhost:4000/api/v1" }
    }
  }
}
```

## Claude Desktop

Add this to `claude_desktop_config.json` (`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS). Use absolute paths:

```json
{
  "mcpServers": {
    "hash8-dm": {
      "command": "npx",
      "args": ["-y", "tsx", "D:/Hash8/device-management/packages/mcp-server/src/index.ts"],
      "env": { "HASH8_API_URL": "http://localhost:4000/api/v1", "HASH8_ACTOR": "agent:claude-desktop" }
    }
  }
}
```

Try: *"What's on the ops inbox? Pause any rollout that's failing its health gate and show me the timeline of the worst device."*

## Test

```bash
npx vitest run && npx tsc --noEmit
```

The tests use an in-memory MCP client and a fake `ApiClient`, so they need no running API.
