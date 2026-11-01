// k6 load test for HTTP ingest: POST /api/v1/ingest/http/:serial {hex, port}
//
//   k6 run infra/k6/ingest.js
//   k6 run -e BASE_URL=https://api.dm.example.com -e RATE=2000 -e DURATION=10m infra/k6/ingest.js
//   k6 run -e PAYLOADS='[{"hex":"01a2...","port":1}]' -e SERIAL_PREFIX=GT200-SIM- infra/k6/ingest.js
//
// Env:
//   BASE_URL       API origin (default http://localhost:4000)
//   RATE           target requests/sec at plateau (default 200)
//   DURATION       plateau duration (default 2m)
//   DEVICES        distinct serials to spread load over (default 1000)
//   SERIAL_PREFIX  serial prefix (default SIM-); serial = prefix + zero-padded index
//   PAYLOADS       JSON array of {hex, port}; defaults to a small mixed set. Payloads the
//                  codec can't decode still exercise ingest (they land on unknown.v1).
//   TENANT_ID      optional x-tenant-id header
import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:4000").replace(/\/+$/, "");
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || "2m";
const DEVICES = Number(__ENV.DEVICES || 1000);
const PREFIX = __ENV.SERIAL_PREFIX || "SIM-";
const PAYLOADS = __ENV.PAYLOADS
  ? JSON.parse(__ENV.PAYLOADS)
  : [
      { hex: "01", port: 1 },
      { hex: "0100fa0bb8a3000c", port: 1 },
      { hex: "02010203040506070809", port: 2 },
      { hex: "a1b2c3d4e5f60718293a4b5c", port: 10 },
    ];

const accepted = new Counter("ingest_accepted");
const rejected = new Counter("ingest_rejected");
const ingestLatency = new Trend("ingest_latency", true);

export const options = {
  discardResponseBodies: true,
  scenarios: {
    ingest: {
      executor: "ramping-arrival-rate",
      startRate: Math.max(1, Math.floor(RATE / 10)),
      timeUnit: "1s",
      preAllocatedVUs: Math.min(2000, Math.max(20, Math.ceil(RATE / 5))),
      maxVUs: Math.min(5000, Math.max(100, RATE * 2)),
      stages: [
        { target: RATE, duration: "30s" }, // ramp
        { target: RATE, duration: DURATION }, // plateau
        { target: RATE * 2, duration: "30s" }, // burst ×2
        { target: RATE * 2, duration: "30s" },
        { target: 0, duration: "15s" }, // drain
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{scenario:ingest}": ["p(95)<100", "p(99)<250"],
    dropped_iterations: ["count<100"],
  },
};

const headers = { "content-type": "application/json" };
if (__ENV.TENANT_ID) headers["x-tenant-id"] = __ENV.TENANT_ID;

function serialFor(i) {
  return PREFIX + String((i % DEVICES) + 1).padStart(6, "0");
}

export default function () {
  // spread across devices; __ITER is per-VU, so mix in the VU id
  const serial = serialFor(__VU * 7919 + __ITER);
  const p = PAYLOADS[Math.floor(Math.random() * PAYLOADS.length)];
  const res = http.post(`${BASE_URL}/api/v1/ingest/http/${encodeURIComponent(serial)}`, JSON.stringify(p), {
    headers,
    tags: { name: "ingest_http" },
  });
  ingestLatency.add(res.timings.duration);
  const ok = check(res, { "2xx": (r) => r.status >= 200 && r.status < 300 });
  if (ok) accepted.add(1);
  else rejected.add(1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const reqs = m.http_reqs ? m.http_reqs.values.count : 0;
  const rate = m.http_reqs ? m.http_reqs.values.rate : 0;
  const p99 = m.http_req_duration ? m.http_req_duration.values["p(99)"] : 0;
  const failed = m.http_req_failed ? m.http_req_failed.values.rate : 0;
  const line =
    `\n#8 ingest: ${reqs} requests · ${rate.toFixed(1)} req/s · p99 ${p99.toFixed(1)} ms · ` +
    `failed ${(failed * 100).toFixed(2)}%\n` +
    `  → 1B msgs/day needs ~11.6k msg/s avg (~58k peak); scale the ingest tier linearly from this per-pod rate.\n`;
  return { stdout: line, "k6-ingest-summary.json": JSON.stringify(data, null, 2) };
}
