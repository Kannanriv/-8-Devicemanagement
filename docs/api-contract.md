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

## v1.1 additions — 14 device-management modules (user spec, 2026-11-01)
Lifecycle, connectivity and health are **separate axes** (see `LifecycleState`, `Connectivity`, `HealthLevel` in types.ts).
Lifecycle: registered → assigned → installing → pending_activation → activated, with maintenance / suspended / swap, and retired (history retained).

| Module | Method & path | Returns |
|---|---|---|
| 01 Overview | GET `/fleet/stats` (existing) + GET `/reports/trends?days=30` | `{at, online, messages, alerts}[]` |
| 02 Inventory | GET `/inventory/kpis` | `InventoryKpis` |
| 02 Inventory | GET `/devices` supports all `DeviceQuery` filters (organization, branch, oem, modelId, lifecycle, connectivity, health, firmwareVersion, assetId, installedFrom/To, lastSeenBefore/After, sort) | `Page<Device>` |
| 02 Inventory | GET `/devices/export?<same filters>` | CSV |
| 02 Bulk | POST `/devices/bulk/preview` `{op, deviceIds?, query?, params}` (permission + eligibility per device) | `BulkPreview` |
| 02 Bulk | POST `/devices/bulk` `{op, deviceIds, params}` · GET `/bulk-jobs/:id` · GET `/bulk-jobs` | `BulkJob` (per-device results) |
| 03 Lifecycle | POST `/devices/:id/lifecycle` `{to, note?}` — new states; GET `/lifecycle/summary` | counts per state |
| 04 Assets | GET/POST `/assets` · GET/PATCH `/assets/:id` · POST `/assets/:id/devices` `{deviceId, role}` · DELETE `/assets/:id/devices/:deviceId` · POST `/assets/:id/swap` `{oldDeviceId, newDeviceId}` · GET `/assets/:id/associations` | `Asset`, `AssetAssociation[]` |
| 07 SIM | GET `/devices/:id/sim` · POST `/devices/:id/sim/{activate,suspend}` · GET `/sims?status&carrier` | `SimInfo` |
| 10 Alerts | GET `/alerts?status&severity&category&deviceId` · POST `/alerts/:id/{ack,resolve}` `{resolution?}` · GET/POST `/alert-rules` (= automations with alert actions) | `Alert` |
| 11 History | GET `/devices/:id/timeline?kinds=lifecycle,config,ownership,technician,command,association` | `TimelineEvent[]` |
| 12 Security | GET `/devices/:id/credentials` · POST `/devices/:id/credentials` (issue X.509 from dev CA) · POST `/credentials/:id/revoke` `{reason}` · GET `/security/overview` (expiring/expired/revoked counts, tenant isolation checks) | `DeviceCredential` |
| 13 Reports | GET `/reports/fleet?from&to` | `FleetReport` |

## v1.2 — Device Ecosystem
| Method & path | Returns |
|---|---|
| GET `/ecosystem/overview` | `EcosystemOverview` |
| GET `/ecosystem/partners?kind&tier&q` · GET `/ecosystem/partners/:id` | `EcosystemPartner` (+ models) |
| GET `/ecosystem/catalog?q&category&protocol&connectivity&level&partnerId` · GET `/ecosystem/catalog/:id` | `CatalogModel` |
| POST `/ecosystem/catalog` (OEM lists a model; optional codecId) | `CatalogModel` |
| POST `/ecosystem/catalog/:id/certify` `{targetLevel}` → runs real checks | `CertificationRun` |
| GET `/ecosystem/certifications?status` · GET `/ecosystem/certifications/:id` | `CertificationRun` |
| POST `/ecosystem/catalog/:id/adopt` (solution company adds model to its fleet models + subscribes to codec) | `{modelId, subscription}` |
| GET `/ecosystem/releases?codecId` | `CodecRelease[]` |
| GET/POST `/ecosystem/subscriptions` · DELETE `/ecosystem/subscriptions/:id` | `CodecSubscription` |
| GET `/ecosystem/compatibility?modelId` | `CompatibilityEntry[]` matrix |
| GET `/ecosystem/graph` | `EcosystemGraph` |
