# #8 Device Management — team conventions

Operations-driven IoT device management: OEM Excel spec → Device Codec Spec (DCS) → verified codec → auto-decoding + generated decoder plugins; plus inventory, lifecycle, config, health, commands, OTA, automations, integrations, audit, and AI agents.

**Repo path: `D:\Hash8\device-management`** (bash: `/d/Hash8/device-management`). Never work under `D:\#8\...` — Vite/Next break on `#` in paths.

## Layout & ownership
| Path | What |
|---|---|
| `packages/dcs-schema` | DCS types + zod validation + codec result contracts. **Contract — change only with lead approval.** |
| `packages/sdk-ts` | Domain types (`src/types.ts`) + REST client. **Contract.** |
| `docs/dcs-semantics.md` | Normative codec semantics. Runtime and all generated plugins must match it. |
| `docs/api-contract.md` | REST contract implemented by `apps/api`, consumed by `apps/console`. |
| `packages/codec-runtime` | Bidirectional DCS interpreter + vector runner. |
| `packages/codec-compiler` | Plugin/SDK codegen (ts, ts013, python, go, java, c) + zip bundles. |
| `packages/spec-ingest` | Excel → draft DCS with source trace. |
| `packages/agents` | AI agents (Claude) + orchestrator, with offline fallbacks. |
| `packages/ops-engine` | Pure ops logic: OTA rollout, health, automations, config drift, lifecycle, webhooks. |
| `packages/mcp-server` | MCP server over the API. |
| `apps/api` | Fastify API + ingestion (HTTP/MQTT/UDP) + decode pipeline + PGlite dev store. Port 4000. |
| `apps/console` | Next.js 15 console. Port 3000. |
| `tools/simulator` | Device fleet simulator. |
| `samples/specs`, `samples/excel` | Seed DCS specs and OEM-style Excel sheets. |

## Rules
- TypeScript strict, ESM, `moduleResolution: Bundler`, extensionless relative imports. Internal packages are consumed from source (`exports: ./src/index.ts`) — no build step.
- Tests: vitest, `test/*.test.ts` next to `src/`. Run from the package dir: `npx vitest run`. Typecheck: `npx tsc --noEmit`. TDD for logic.
- **Do not run `npm install` / add dependencies** — all deps are pre-installed. If something essential is missing, say so in your report.
- Stay inside the paths you own. Don't edit contracts; if a contract is insufficient, report the proposed change.
- No secrets in code. AI features must work without `ANTHROPIC_API_KEY` (deterministic fallback), and use Claude when it is set.
- Brand: obsidian `#05060A`, panel `#0C0E15`/`#141722`, porcelain `#F4F2EE`, signal `#5B7CFF`, ion `#5EE6C8`, ember `#FF8A4C`, gradient `linear-gradient(100deg,#5B7CFF,#5EE6C8,#FF8A4C)`, font Inter Tight, 28px panel radius, 14px control radius, pill buttons.
