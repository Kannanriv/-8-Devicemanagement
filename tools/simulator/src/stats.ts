/** Rolling publish statistics: throughput, errors and latency percentiles. */

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export class Stats {
  sent = 0;
  errors = 0;
  encodeErrors = 0;
  downlinks = 0;
  acks = 0;
  dropped = 0;
  inflight = 0;
  private windowSent = 0;
  private windowLat: number[] = [];
  private allLat: number[] = [];
  private windowStart = Date.now();
  readonly startedAt = Date.now();
  lastError?: string;

  record(latencyMs: number) {
    this.sent++;
    this.windowSent++;
    this.windowLat.push(latencyMs);
    // reservoir-ish cap to bound memory on long runs
    if (this.allLat.length < 200_000) this.allLat.push(latencyMs);
    else this.allLat[Math.floor(Math.random() * this.allLat.length)] = latencyMs;
  }

  error(e: unknown) {
    this.errors++;
    this.lastError = e instanceof Error ? e.message : String(e);
  }

  /** Snapshot and reset the per-interval window. */
  tick(now = Date.now()) {
    const secs = Math.max(0.001, (now - this.windowStart) / 1000);
    const lat = [...this.windowLat].sort((a, b) => a - b);
    const snap = {
      rate: this.windowSent / secs,
      p50: percentile(lat, 50),
      p99: percentile(lat, 99),
    };
    this.windowSent = 0;
    this.windowLat = [];
    this.windowStart = now;
    return snap;
  }

  summary(now = Date.now()) {
    const lat = [...this.allLat].sort((a, b) => a - b);
    const secs = Math.max(0.001, (now - this.startedAt) / 1000);
    return {
      seconds: secs,
      sent: this.sent,
      avgRate: this.sent / secs,
      errors: this.errors,
      encodeErrors: this.encodeErrors,
      dropped: this.dropped,
      downlinks: this.downlinks,
      acks: this.acks,
      p50: percentile(lat, 50),
      p99: percentile(lat, 99),
      max: lat.at(-1) ?? 0,
    };
  }
}
