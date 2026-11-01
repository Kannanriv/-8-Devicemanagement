#!/usr/bin/env bash
# Create the #8 event-bus topics (idempotent). Partition counts are dev-sized;
# production sizing lives in docs/architecture.md (§Sizing) and the Helm values.
set -euo pipefail
B="${RPK_BROKERS:-redpanda:9092}"
create() { # name partitions retention.ms cleanup
  rpk topic create "$1" -X brokers="$B" -p "$2" -r 1 \
    -c retention.ms="$3" -c cleanup.policy="$4" -c compression.type=zstd 2>&1 | grep -v "TOPIC_ALREADY_EXISTS" || true
}
create raw.v1      12 604800000   delete   # raw uplinks, key = deviceId, 7d (replay / re-decode)
create decoded.v1  12 259200000   delete   # decoded envelopes, key = deviceId, 3d
create unknown.v1   3 1209600000  delete   # undecodable payloads for triage, 14d
create commands.v1  6 604800000   delete   # downlink commands + acks, key = deviceId
create ota.v1       3 2592000000  delete   # OTA campaign / device update events, 30d
create shadow.v1   12 -1          compact  # latest reported state per device (compacted)
create dlq.v1       3 1209600000  delete   # poison messages from any consumer
rpk topic list -X brokers="$B"
