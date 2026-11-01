"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeftRight, ArrowRight, GitBranch } from "lucide-react";
import type { BulkOp, Device, LifecycleState } from "@hash8/sdk-ts";
import { LIFECYCLE_TRANSITIONS } from "@hash8/sdk-ts";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { ConnectivityDot, HealthBadge, LIFECYCLE_MAIN, LIFECYCLE_SIDE, lifecycleColor, lifecycleLabel } from "@/components/status";
import { BulkFlow } from "@/components/bulk-flow";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useDevices } from "@/lib/api";
import { useLifecycleSummary } from "@/lib/api-v11";
import { cn, fmt } from "@/lib/utils";

const STAGE_HINT: Record<LifecycleState, string> = {
  registered: "In inventory, available to deploy",
  assigned: "Linked to an asset or deployment",
  installing: "Technician workflow in progress",
  pending_activation: "Waiting on provisioning, SIM or first traffic",
  activated: "Commissioned and operational",
  maintenance: "Being serviced",
  suspended: "Service paused",
  swap: "Being replaced on its asset",
  retired: "Decommissioned, history retained",
};

export function LifecycleView() {
  const summary = useLifecycleSummary();
  const [selected, setSelected] = React.useState<Map<string, Device>>(new Map());
  const [op, setOp] = React.useState<BulkOp | null>(null);
  const toggle = (d: Device, v: boolean) =>
    setSelected((prev) => {
      const n = new Map(prev);
      if (v) n.set(d.id, d);
      else n.delete(d.id);
      return n;
    });
  const counts = summary.data ?? {};
  const mainTotal = LIFECYCLE_MAIN.reduce((a, s) => a + (counts[s] ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Lifecycle"
        description="From registration to activation, with controlled maintenance, suspension, swap and retirement. Select devices to move or transfer them."
        actions={
          selected.size ? (
            <>
              <span className="text-sm text-muted">{selected.size} selected</span>
              <Button variant="secondary" onClick={() => setOp("lifecycle")}>
                <GitBranch />
                Change state
              </Button>
              <Button variant="primary" onClick={() => setOp("transfer")}>
                <ArrowLeftRight />
                Transfer to tenant
              </Button>
            </>
          ) : null
        }
      />

      {/* Funnel: proportion of devices at each step of the activation path. */}
      <Panel className="mb-6 overflow-hidden px-6 py-5 sm:px-7">
        <div className="mb-3 flex items-baseline justify-between">
          <p className="text-sm font-medium">Activation path</p>
          {summary.error ? <ApiError error={summary.error} compact /> : <p className="text-xs text-subtle tabular">{fmt.number(mainTotal)} devices</p>}
        </div>
        <div className="flex h-2.5 gap-[3px] overflow-hidden rounded-full">
          {LIFECYCLE_MAIN.map((s) => {
            const n = counts[s] ?? 0;
            return (
              <div
                key={s}
                title={`${lifecycleLabel(s)}: ${n}`}
                className="h-full min-w-[3px] transition-[flex-grow] duration-700 ease-out-soft"
                style={{ flexGrow: mainTotal ? n : 1, background: lifecycleColor[s], opacity: summary.isPending ? 0.25 : 1 }}
              />
            );
          })}
        </div>
        <div className="mt-3 grid grid-cols-5 gap-2 text-xs">
          {LIFECYCLE_MAIN.map((s) => (
            <div key={s} className="min-w-0">
              <p className="truncate text-muted">{lifecycleLabel(s)}</p>
              <p className="text-base font-semibold tracking-[-0.02em] tabular">{summary.isPending ? "…" : fmt.number(counts[s] ?? 0)}</p>
            </div>
          ))}
        </div>
      </Panel>

      <div className="scrollbar-quiet -mx-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
        <ol className="flex min-w-max gap-3" aria-label="Lifecycle stages">
          {LIFECYCLE_MAIN.map((s, i) => (
            <React.Fragment key={s}>
              <StageColumn state={s} total={counts[s]} selected={selected} onToggle={toggle} />
              {i < LIFECYCLE_MAIN.length - 1 ? (
                <li aria-hidden className="flex w-3 items-start pt-6 text-subtle">
                  <ArrowRight className="size-3" />
                </li>
              ) : null}
            </React.Fragment>
          ))}
          <li aria-hidden className="mx-2 w-px self-stretch bg-line" />
          {LIFECYCLE_SIDE.map((s) => (
            <StageColumn key={s} state={s} total={counts[s]} selected={selected} onToggle={toggle} side />
          ))}
        </ol>
      </div>
      <BulkFlow op={op} deviceIds={[...selected.keys()]} open={!!op} onOpenChange={(v) => !v && setOp(null)} onDone={() => setSelected(new Map())} />
    </>
  );
}

function StageColumn({
  state,
  total: summaryTotal,
  selected,
  onToggle,
  side,
}: {
  state: LifecycleState;
  total?: number;
  selected: Map<string, Device>;
  onToggle: (d: Device, v: boolean) => void;
  side?: boolean;
}) {
  const q = useDevices({ lifecycle: state, limit: 12 });
  const next = LIFECYCLE_TRANSITIONS[state];
  const total = summaryTotal ?? q.data?.total;
  return (
    <li className="w-[264px] shrink-0">
      <Panel className={cn("flex h-[min(64vh,620px)] flex-col rounded-card", side && "bg-panel/60")}>
        <header className="px-5 pt-4 pb-3">
          <div className="flex items-center gap-2">
            <span aria-hidden className={cn("size-2", side ? "rotate-45 rounded-[1px]" : "rounded-full")} style={{ background: lifecycleColor[state] }} />
            <h2 className="flex-1 truncate text-sm font-semibold tracking-[-0.01em]">{lifecycleLabel(state)}</h2>
            {total == null ? (
              <Skeleton className="h-7 w-10" />
            ) : (
              <span className={cn("text-2xl font-semibold tracking-[-0.03em] tabular", state === "activated" && "text-ion")}>{fmt.compact(total)}</span>
            )}
          </div>
          <p className="mt-1 text-xs text-subtle">{STAGE_HINT[state]}</p>
          {next.length ? (
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-muted">
              <span className="text-subtle">Next: </span>
              {next.map((n) => lifecycleLabel(n)).join(", ")}
            </p>
          ) : null}
        </header>
        <div className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto border-t border-line px-2 py-2">
          {q.isPending ? (
            <div className="flex flex-col gap-1.5 p-1">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : q.error ? (
            <ApiError error={q.error} compact className="p-3" />
          ) : q.data.items.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-subtle">No devices</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {q.data.items.map((d) => (
                <li key={d.id} className="flex items-center gap-2.5 rounded-[12px] px-2.5 py-2 hover:bg-hover">
                  <Checkbox checked={selected.has(d.id)} onCheckedChange={(v) => onToggle(d, !!v)} aria-label={`Select ${d.udi ?? d.serial}`} />
                  <Link href={`/devices/${d.id}`} className="focus-ring min-w-0 flex-1 rounded">
                    <p className="truncate font-mono text-[12.5px] font-medium">{d.udi ?? d.serial}</p>
                    <p className="truncate text-[11px] text-subtle">{d.assetName ?? d.model ?? d.name ?? ""}</p>
                  </Link>
                  <span className="flex flex-col items-end gap-1">
                    <ConnectivityDot value={d.health?.connectivity ?? "never_seen"} withLabel={false} />
                    <HealthBadge level={d.health?.level} className="text-[11px] [&>svg]:size-3" />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {total != null && total > (q.data?.items.length ?? 0) ? (
          <Link href={`/inventory?lifecycle=${state}`} className="focus-ring border-t border-line px-5 py-3 text-xs text-muted hover:text-fg">
            View all {fmt.number(total)} in Inventory
          </Link>
        ) : null}
      </Panel>
    </li>
  );
}
