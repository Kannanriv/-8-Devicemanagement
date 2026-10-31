# REST API contract (v1)

Base: `http://localhost:4000/api/v1`. JSON everywhere. Types: `packages/sdk-ts/src/types.ts`.
Dev auth: header `x-tenant-id` (defaults to the seeded solution tenant) and optional `x-actor`.
Errors: `{ error: { code, message } }` with proper HTTP status.

| Area | Method & path | Returns |
|---|---|---|
| Ops | GET `/ops/inbox` | `OpsItem[]` |
| Ops | GET `/fleet/stats` | `FleetStats` |
| Inventory | GET `/models` · POST `/models` · GET `/models/:id` | `DeviceModel` |
| Inventory | GET `/devices?q&modelId&lifecycle&connectivity&tag&firmwareVersion&limit&cursor` | `Page<Device>` |
| Inventory | GET/PATCH `/devices/:id` · POST `/devices` · POST `/devices/import` (CSV body: serial,imei,iccid,modelId) | `Device` |
| Inventory | GET/POST `/batches` | `Batch` |
| Lifecycle | POST `/devices/:id/lifecycle` `{to, note?}` (validated via `LIFECYCLE_TRANSITIONS`) | `Device` |
| Lifecycle | POST `/devices/transfer` `{deviceIds, toTenantId}` (codec access travels with the device) | `{transferred}` |
| Health | GET `/devices/:id/health` | `DeviceHealth` |
| History | GET `/devices/:id/messages?limit` | `DeviceMessage[]` |
| History | GET `/devices/:id/timeline?limit` | `TimelineEvent[]` |
| Config | GET/PUT `/devices/:id/config` (`{desired}`) · GET/POST `/config-templates` | `DeviceConfig` |
| Commands | GET/POST `/devices/:id/commands` `{message, data}` · POST `/commands/:id/cancel` | `Command` |
| Diagnostics | POST `/diagnostics/decode` `{codecId, version?, hex, port?, topic?}` | `DecodeResult` |
| Codecs | GET `/codecs` | `CodecVersionSummary[]` |
| Codecs | GET `/codecs/:id/versions/:version` (DCS JSON) · POST `/codecs` (DCS body → draft) · POST `/codecs/:id/versions/:version/publish` | |
| Codecs | POST `/codecs/:id/versions/:version/test` | `VectorResult[]` |
| Codecs | GET `/codecs/:id/versions/:version/plugin?target=ts|ts013|python|go|java|c|all` | zip download |
| Spec import | POST `/spec-imports` (multipart Excel) · GET `/spec-imports` · GET `/spec-imports/:id` (includes draft DCS + source trace) | `SpecImportJob` |
| Ingest | POST `/ingest/http/:deviceSerial` `{hex, port?}` · MQTT `tcp://localhost:1883` topic `dev/{serial}/up[/port]` · UDP `:5684` (`serial|port|hex`) | |
| Unknown | GET `/payloads/unknown` · POST `/payloads/redecode` `{deviceId?, since?}` | |
| Firmware | GET/POST `/firmware` (multipart binary + version/modelId) | `Firmware` |
| OTA | GET/POST `/ota/campaigns` · POST `/ota/campaigns/:id/{start,pause,resume,rollback}` | `OtaCampaign` |
| Alerts | GET `/alerts` · POST `/alerts/:id/{ack,resolve}` | `Alert` |
| Automations | GET/POST `/automations` · PATCH `/automations/:id` · POST `/automations/:id/dry-run` `{deviceId}` | `Automation` |
| Integrations | GET/POST `/integrations` · PATCH `/integrations/:id` · POST `/integrations/:id/test` | `Integration` |
| Audit | GET `/audit?target&actor&limit` | `AuditEntry[]` |
| Agents | GET `/agents` · POST `/agents/:name/run` · GET `/agents/runs/:id` · POST `/agents/runs/:id/approve` | `AgentRun` |
| Live | WS `/live` — server pushes `{type: "message"|"alert"|"device"|"ota", payload}` | |
