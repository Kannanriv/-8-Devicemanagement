# #8 Device Management: runbook

## 1. Local development (zero-infra mode)

You need Node ≥ 22. Docker is not required.

```bash
npm install
npm run dev:api        # API :4000 · embedded MQTT :1883 · UDP :5684 · PGlite in apps/api/data
npm run dev:console    # console http://localhost:3100
```

- The API seeds tenants, models, codecs from `samples/specs`, and devices. Tune it with `SEED_DEVICES` and `SEED_MESSAGES`, or turn seeding off with `SEED=false`.
- `SIM_TRAFFIC=true` pushes synthetic uplinks through the real pipeline.
- To reset, stop the API and delete `apps/api/data/`.
- AI agents use Claude when `ANTHROPIC_API_KEY` is set. Without it they fall back to deterministic offline mode.
- Useful env: `PORT`, `MQTT_PORT`, `UDP_PORT`, `TRANSPORTS=false` (no listeners), `TICKERS=false`, `LOG_LEVEL=debug`, `CONSOLE_ORIGINS`.

**Tests and typecheck**

```bash
npm test               # turbo: vitest in every workspace
npm run typecheck
cd packages/<pkg> && npx vitest run && npx tsc --noEmit
```

**MCP server** (Claude Code / Desktop)

See `packages/mcp-server/README.md`. Short version:

```bash
claude mcp add hash8-dm -- npx tsx packages/mcp-server/src/index.ts
```

**Full stack in containers**

```bash
docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml logs -f api
docker compose -f infra/docker-compose.yml exec redpanda rpk topic list
```

## 2. Simulator

```bash
npm run simulate -- --devices 200 --rate 20 --transport mqtt --duration 120
npm run simulate -- --transport http --devices 1000 --rate 200 --duration 0     # until Ctrl-C
npm run simulate -- --transport udp --no-api --devices 50 --rate 50
npm run simulate -- --mode bench                                                  # decode msgs/s/core + core projection
npm run simulate -- --help
```

**What it does**
- Loads every DCS in `samples/specs`.
- Takes devices from `GET /api/v1/devices?limit=N`, matching each by `codecId`. If the API isn't reachable, or you pass `--no-api`, it synthesizes serials such as `GT200-SIM-000001`.
- Generates evolving values: bounded random walks, GPS tracks between Indian cities, battery decay, monotonic counters and alarms at `--alarm-rate`.
- Encodes them with `@hash8/codec-runtime`, so every payload is bit-exact with the codec.

**MQTT mode**
- Subscribes to `dev/+/down`.
- Auto-acks every downlink. If the codec has an uplink message whose name contains "ack" (for example Envio `config_ack`), the simulator sends that uplink and the pipeline acks the oldest open command. Otherwise it calls `POST /api/v1/commands/:id/ack`.

**Output**
- Live, every second: sent/s, total, errors, encode errors, dropped (in-flight cap), in-flight count, and p50/p99 publish latency.
- Latency means MQTT PUBACK, HTTP response, or UDP flush, depending on transport.
- A summary prints on exit.

**Load testing HTTP ingest with k6**

```bash
k6 run infra/k6/ingest.js
k6 run -e BASE_URL=https://api.staging -e RATE=2000 -e DURATION=10m infra/k6/ingest.js
```

The k6 thresholds are: < 1 % failed requests, p95 < 100 ms, p99 < 250 ms.

## 3. Scaling (Kubernetes, `infra/helm/hash8-dm`)

| Symptom | Scale | Notes |
|---|---|---|
| `raw.v1` consumer lag rising | decoder | Enable `decoder.keda` (lag threshold 5k per replica). The ceiling is the partition count (96). |
| Edge CPU > 60 % / MQTT connect latency | ingest + broker nodes | Plan ~100k MQTT sessions per broker node. Ingest scale-in is deliberately slow. |
| API p99 > 300 ms | api | Check Timescale replica lag first. Most reads should hit continuous aggregates. |
| Timescale insert latency > 50 ms p99 | DB | Bigger batches (`PIPELINE_CONCURRENCY`), check the compression job backlog, then scale up the primary or shard by tenant. |
| Partitions saturated | new topic | Create `raw.v2` with more partitions and dual-write during cutover. Never repartition in place, because per-device ordering breaks. |

Capacity math is in `docs/architecture.md` §4. To re-measure decode CPU on new hardware, run `npm run simulate -- --mode bench`.

## 4. Incident playbooks

All playbooks start the same way: open the **Ops inbox**, or call `ops_inbox` from Claude via MCP. Every step below is audited.

### 4.1 Decode error / unknown-payload spike

**Signals**
- `decodeRate` in `fleet_stats` drops.
- An `unknown_payloads` inbox item appears.
- The decode success ratio for one `codecId@version` drops.

**1. Scope it**
- Is it one model or codec, one firmware version, or one tenant?
- Use `search_devices --firmwareVersion` and `device_messages status=unknown`.
- If everything is failing, suspect the pipeline, not a codec.

**2. Find the cause.** The usual suspects:
- **New firmware changed the payload layout.** Check the timeline for `ota` events just before the spike.
- **A codec version was just published.** Check the codec list.
- **A transport adapter changed port or topic mapping.**

**3. Triage**
- Run the **payload-triage** agent (`run_agent payload-triage`). It clusters unknown payloads and proposes a DCS patch with test vectors.
- Verify the patch with `decode_payload` on sample hex.

**4. Mitigate**
- If a new codec version caused it, roll the affected devices back to the previous `codecVersion` (pointer move).
- If firmware caused it, `pause_campaign` the OTA campaign.

**5. Fix**
- Publish the patched codec. `codec-verifier` must pass every vector, including the round-trip check.
- Then `POST /payloads/redecode {since}` to re-decode the backlog. Nothing is lost while you do this: raw data is kept for 7 days in Kafka and indefinitely in the S3 archive.

**6. Close out.** Add the offending payloads as test vectors so the regression is caught by conformance CI.

### 4.2 OTA rollout failure

**Signals**
- A `rollout` inbox item appears.
- The wave's `failed / targeted` exceeds `healthGate.maxFailureRate`.
- Devices drop off after updating.

**1. Brake**
- The health gate auto-pauses the campaign. If it hasn't, run `pause_campaign {campaignId, reason}`. Pausing is safe and idempotent.
- Devices that are mid-download finish their current transfer.

**2. Inspect**
- `list_campaigns status=paused` shows the wave stats.
- `device_timeline kind=ota` on 3–5 failed devices.
- Classify each failure:
  - **Download failure:** CDN or presigned URL expiry, or connectivity.
  - **Signature rejection:** wrong signing key or corrupted artifact. Re-verify the `sha256` and signature.
  - **Boot loop or rollback:** the device came back on the old version.
  - **Bricked:** offline after the update.

**3. Get a second opinion.** Run the **rollout-guardian** agent. It compares the canary cohort's health against a control cohort.

**4. Decide**
- If the cause is infrastructure (CDN, URLs), fix it and resume.
- If the cause is firmware, `rollback`. That re-targets the previous signed image to updated devices that are still online.
- Offline devices go to an `offline_cohort` for field service. Move them to the `maintenance` lifecycle state.

**5. Codec coupling.** If the firmware requires a newer codec, confirm that rolled-back devices had their `codecVersion` pointer reverted.

### 4.3 MQTT broker overload / reconnect storm

**Signals**
- Connection count oscillating.
- CONNECT latency > 1 s.
- Edge CPU pegged.
- Many devices `offline`, then mass reconnects.

**1. Stop the bleeding**
- Turn on connection-rate limiting at the LB and broker (CONNACK `0x97` quota exceeded). Rejected clients back off.
- Don't restart brokers in bulk: each restart re-triggers the storm.

**2. Add capacity**
- Scale broker and ingest nodes. Watch session distribution; new nodes only pick up *new* connections.
- Check TLS handshake CPU. Session resumption should be on.

**3. Find the trigger**
- Network blip, or a cloud LB health-check flap?
- Firmware with a too-short keepalive or no jitter? Correlate by firmware version.
- One tenant's fleet power-cycling at the same time, for example after a mains outage?
- A runaway device publishing in a tight loop? Look for a hot partition.

**4. Contain bad actors**
- Per-device token buckets drop excess traffic.
- Move repeat offenders to the `suspended` lifecycle state. The broker kicks the session and the ACL denies reconnects.

**5. Downstream check.** `raw.v1` lag will spike after recovery as buffered uplinks drain. If needed, let KEDA scale the decoders before declaring the incident resolved.

**6. Follow up**
- File a firmware ticket for keepalive and backoff jitter.
- Add an automation: offline-cohort detection, then a ticket via the `hash8-ticketing` integration.

### 4.4 Decoder lag growing (no error spike)

1. Is Timescale slow? Check insert latency, locks and the compression job. If it is, decoders are backpressuring, which is correct behaviour.
2. Is one partition lagging? Then it's a hot device. Find the top talkers by key.
3. If lag is uniform and CPU is high, scale the decoders (KEDA). The ceiling is the partition count.
4. Watch Kafka retention headroom: 7 days on `raw.v1`. Page if projected catch-up time is more than 24 h.
