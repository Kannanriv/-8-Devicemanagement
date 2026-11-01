# #8 Device Management

**Operations-driven IoT device management, from OEM spreadsheet to millions of devices.**

Most IoT platforms give you a device list and a pile of dashboards. #8 is built around what operators actually *do*. The first screen is an **ops inbox** of prioritised, actionable work:
- stalled rollouts
- unknown payloads
- offline cohorts
- expiring certs
- config drift

Each item comes with a suggested fix, often an AI agent ready to run.

### Excel spec → codec → plugins

Every device vendor ships a "message spec" spreadsheet, and every integrator hand-writes a decoder from it. #8 automates that pipeline:

1. **Spec ingest.** Upload the OEM Excel sheet. The spec-extractor agent produces a draft **Device Codec Spec (DCS)** in which every field carries a link back to its source cell.
2. **Verified codec.** The DCS is a declarative, bidirectional layout covering bits, endianness, scale, enums, switches, repeats and checksums. The codec-verifier agent proves it against test vectors, including an encode∘decode round-trip.
3. **Auto-decoding.** Published codecs decode every uplink and encode every downlink across MQTT, HTTP, UDP, CoAP/LwM2M and LoRaWAN.
4. **Generated plugins.** Dependency-free decoders for **TypeScript, TTN/TS013, Python, Go, Java and C**, conformance-tested against the same vectors.

Around the codec pipeline, #8 covers **14 modules**: Overview · Inventory · Lifecycle · Device & Asset Association · Configuration · Health & Monitoring · Connectivity & SIM · Firmware & OTA · Diagnostics & Commands · Incidents & Alerts · Audit & History · Security & Access · Reports & Analytics · Integrations & Automation.

Lifecycle (registered → assigned → installing → pending activation → activated → retired), connectivity (online/stale/offline) and health (normal/warning/critical) are tracked as separate axes. See [architecture](docs/architecture.md#the-14-modules).

### The 7 AI agents

| Agent | Job |
|---|---|
| **spec-extractor** | OEM Excel/PDF → draft DCS with source trace and confidence |
| **codec-verifier** | Runs vectors and round-trips, explains failures, proposes fixes |
| **payload-triage** | Clusters unknown payloads and proposes codec patches and new vectors |
| **rollout-guardian** | Watches OTA waves against health gates and pauses or rolls back |
| **fleet-copilot** | Answers natural-language fleet questions grounded in live data |
| **anomaly-sentinel** | Flags telemetry and behaviour anomalies before they become tickets |
| **integration-builder** | Builds webhook, CRM and ticketing mappings from examples |

The agents use Claude when `ANTHROPIC_API_KEY` is set, and deterministic offline fallbacks otherwise. Any agent run that changes state waits for human approval.

The same operations are exposed to any MCP client via **`packages/mcp-server`**, so you can ask Claude: *"pause any rollout failing its gate and show me the worst device's timeline."*

---

## Quick start

You need Node ≥ 22. Nothing else: dev mode is zero-infra, with embedded Postgres (PGlite), an MQTT broker and a UDP listener.

```bash
npm install
npm run dev:api        # http://localhost:4000/api/v1 · MQTT :1883 · UDP :5684
npm run dev:console    # http://localhost:3100
npm run simulate       # a realistic fleet sending codec-encoded uplinks
```

More simulator runs:

```bash
npm run simulate -- --devices 500 --rate 50 --transport mqtt --duration 120
npm run simulate -- --mode bench        # decode msgs/s/core → cores for 1M devices / 1B msgs/day
```

Full container stack (Timescale, Redpanda, Redis, MinIO, API, console):

```bash
docker compose -f infra/docker-compose.yml up -d --build
```

Checks:

```bash
npm test && npm run typecheck
```

## Monorepo map

| Path | What |
|---|---|
| `packages/dcs-schema` | DCS types, zod validation, codec result contracts |
| `packages/codec-runtime` | Bidirectional DCS interpreter + test-vector runner |
| `packages/codec-compiler` | Plugin/SDK codegen (ts, ts013, python, go, java, c) + zip bundles |
| `packages/spec-ingest` | Excel → draft DCS with source trace |
| `packages/agents` | The 7 AI agents + orchestrator (Claude, with offline fallbacks) |
| `packages/ops-engine` | OTA rollout, health, automations, config drift, lifecycle, webhooks |
| `packages/sdk-ts` | Domain types + typed REST client |
| `packages/mcp-server` | MCP server: ops/fleet/codec/OTA tools for Claude |
| `apps/api` | Fastify API, ingestion (HTTP/MQTT/UDP), decode pipeline, dev store |
| `apps/console` | Next.js operations console |
| `tools/simulator` | Fleet simulator, load generator, decode benchmark |
| `samples/specs`, `samples/excel` | Seed codecs and OEM-style spreadsheets |
| `infra/` | Dockerfiles, docker-compose, Helm chart, k6 load test |

## Docs

- [Architecture](docs/architecture.md): the production design (protocol edge → Kafka → decoders → Timescale/Redis), multi-tenancy, device identity, OTA signing, sizing for 1M devices and 1B msgs/day, failure modes, observability.
- [Runbook](docs/runbook.md): local dev, simulator, scaling, incident playbooks.
- [API contract](docs/api-contract.md): REST endpoints.
- [DCS semantics](docs/dcs-semantics.md): normative codec semantics that every runtime and plugin must match.
- [MCP server](packages/mcp-server/README.md): Claude Code / Claude Desktop setup.

License: Apache-2.0.
