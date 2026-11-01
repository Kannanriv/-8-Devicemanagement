# Event bus

`EventBus` (`bus.ts`) decouples ingestion, decoding and fan-out. Dev mode uses
`InMemoryBus`; production swaps in a Kafka/Redpanda implementation with the same
topic names and keys. All topics are keyed by **device id** so per-device ordering
is preserved within a partition.

| Topic | Producer | Value | Consumers |
|---|---|---|---|
| `raw.v1` | ingest adapters (HTTP, MQTT `dev/{serial}/up[/port]`, UDP `serial\|port\|hex`) | `RawEnvelope` (`@hash8/dcs-schema`) | decode pipeline |
| `decoded.v1` | decode pipeline | `DecodedEnvelope` + device snapshot | automations, integrations/webhooks, analytics sinks, WS `/live` |
| `unknown.v1` | decode pipeline | raw envelope + codec errors | payload-triage agent, ops inbox |
| `events.v1` | API (lifecycle, alerts, OTA, commands) | `{type, payload}` | integrations, WS `/live` |

## Production notes
- Partitions: `raw.v1` ≥ 64 partitions for millions of devices; decode workers scale
  horizontally as a consumer group (`dm-decoder`). Compiled codecs are cached per
  worker by `codecId@version`.
- `decoded.v1` is compacted-free (retention 7d); long-term storage goes to the
  `messages` hypertable (Timescale) via a sink consumer with batched inserts.
- `unknown.v1` retention 30d so payloads can be re-decoded after a codec fix
  (`POST /api/v1/payloads/redecode`).
- Delivery semantics: at-least-once; consumers are idempotent on envelope `id`.
