import type { OtaCampaign, RolloutWave } from "@hash8/sdk-ts";
import { cn, fmt } from "@/lib/utils";

export function campaignTotals(c: OtaCampaign) {
  let targeted = 0, succeeded = 0, failed = 0;
  for (const w of c.waves) {
    targeted += w.targeted;
    succeeded += w.succeeded;
    failed += w.failed;
  }
  return { targeted, succeeded, failed, failureRate: succeeded + failed ? failed / (succeeded + failed) : 0 };
}

/** Compact wave strip for list rows. */
export function WaveStrip({ waves, className }: { waves: RolloutWave[]; className?: string }) {
  return (
    <div className={cn("flex w-full gap-1", className)} aria-label="Rollout waves">
      {waves.map((w) => {
        const done = w.succeeded + w.failed;
        const ok = w.targeted ? w.succeeded / w.targeted : 0;
        const bad = w.targeted ? w.failed / w.targeted : 0;
        return (
          <div key={w.name} className="flex min-w-0 flex-1 flex-col gap-1" title={`${w.name}: ${w.succeeded} ok, ${w.failed} failed of ${w.targeted}`}>
            <div className={cn("flex h-1.5 overflow-hidden rounded-full bg-hover", w.status === "running" && "ring-1 ring-signal/40")}>
              <div className="bg-ion" style={{ width: `${ok * 100}%` }} />
              <div className="bg-danger" style={{ width: `${bad * 100}%` }} />
            </div>
            <span className={cn("truncate text-[10.5px] tabular", w.status === "pending" ? "text-subtle" : "text-muted")}>
              {w.name}
              {done && w.status !== "pending" ? "" : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const STATUS_TEXT: Record<RolloutWave["status"], string> = { pending: "Waiting", running: "Rolling out", passed: "Passed", failed: "Gate tripped" };

/** Large wave visualisation: canary → 10% → 50% → 100%. */
export function WaveBoard({ c }: { c: OtaCampaign }) {
  const maxTargeted = Math.max(1, ...c.waves.map((w) => w.targeted));
  return (
    <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="Rollout waves">
      {c.waves.map((w, i) => {
        const done = w.succeeded + w.failed;
        const progress = w.targeted ? done / w.targeted : 0;
        const fr = done ? w.failed / done : 0;
        const tripped = fr > c.healthGate.maxFailureRate;
        return (
          <li
            key={w.name}
            className={cn(
              "relative flex flex-col gap-4 overflow-hidden rounded-card border p-5",
              w.status === "running" ? "border-signal/40 bg-signal/[0.04]" : w.status === "failed" ? "border-danger/40 bg-danger/[0.04]" : "border-line bg-raised/40",
            )}
          >
            {w.status === "running" ? <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-signature" /> : null}
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-subtle tabular">Wave {i + 1}</span>
              <span
                className={cn(
                  "text-xs font-medium",
                  w.status === "running" && "text-signal",
                  w.status === "passed" && "text-ion",
                  w.status === "failed" && "text-danger",
                  w.status === "pending" && "text-subtle",
                )}
              >
                {STATUS_TEXT[w.status]}
              </span>
            </div>
            <div>
              <p className="text-[28px] leading-none font-semibold tracking-[-0.03em]">{w.name}</p>
              <p className="mt-1.5 text-[13px] text-muted tabular">
                {fmt.number(w.targeted)} devices{w.percent ? `, ${w.percent}% of cohort` : ""}
              </p>
            </div>
            {/* Bar height encodes wave size; fill encodes outcome. */}
            <div className="flex h-24 items-end">
              <div
                className="relative w-full overflow-hidden rounded-[10px] bg-hover"
                style={{ height: `${Math.max(14, (w.targeted / maxTargeted) * 100)}%` }}
              >
                <div className="absolute inset-x-0 bottom-0 flex h-full flex-col-reverse">
                  <div className="bg-ion/80 transition-[height] duration-700 ease-out-soft" style={{ height: `${(w.succeeded / Math.max(1, w.targeted)) * 100}%` }} />
                  <div className="bg-danger/85 transition-[height] duration-700 ease-out-soft" style={{ height: `${(w.failed / Math.max(1, w.targeted)) * 100}%` }} />
                </div>
              </div>
            </div>
            <dl className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <dt className="text-subtle">Done</dt>
                <dd className="font-medium tabular">{fmt.pct(progress)}</dd>
              </div>
              <div>
                <dt className="text-subtle">Succeeded</dt>
                <dd className="font-medium text-ion tabular">{fmt.number(w.succeeded)}</dd>
              </div>
              <div>
                <dt className="text-subtle">Failed</dt>
                <dd className={cn("font-medium tabular", w.failed ? "text-danger" : "text-muted")}>{fmt.number(w.failed)}</dd>
              </div>
            </dl>
            {done ? (
              <p className={cn("text-xs", tripped ? "text-danger" : "text-subtle")}>
                Failure rate {fmt.pct(fr)} {tripped ? "is above" : "within"} the {fmt.pct(c.healthGate.maxFailureRate)} gate
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
