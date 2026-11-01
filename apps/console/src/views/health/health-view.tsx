"use client";

import Link from "next/link";
import { ArrowUpRight, HeartPulse } from "lucide-react";
import type { DeviceQuery } from "@hash8/sdk-ts";
import { EChart, tooltipStyle } from "@/components/chart";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { ConnectivityDot, HealthBadge, LifecycleBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { useDevices } from "@/lib/api";
import { useInventoryKpis, useTrends } from "@/lib/api-v11";
import { cn, fmt } from "@/lib/utils";

export function HealthView() {
  const k = useInventoryKpis();
  const trends = useTrends(7);
  const d = k.data;
  const activated = d ? d.connected + d.stale + d.offline : 0;
  const seg = d
    ? [
        { key: "online", label: "Online", n: d.connected, color: "var(--ion)", define: "Reported within the expected interval." },
        { key: "stale", label: "Stale telemetry", n: d.stale, color: "var(--ember)", define: "Seen, but newest data is 1–3 intervals old." },
        { key: "offline", label: "Offline", n: d.offline, color: "var(--danger)", define: "Silent for more than three intervals." },
      ]
    : [];

  return (
    <>
      <PageHeader title="Health & monitoring" description="Is each activated device talking, and is it working well? Connectivity and health are scored separately." />
      {k.error && !d ? (
        <Panel>
          <ApiError error={k.error} onRetry={() => void k.refetch()} />
        </Panel>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <Panel>
            <PanelHeader>
              <div>
                <PanelTitle>Connectivity of activated devices</PanelTitle>
                <PanelDescription>{d ? `${fmt.number(activated)} activated, ${fmt.number(d.notCommissioned)} not yet commissioned` : "Loading"}</PanelDescription>
              </div>
            </PanelHeader>
            <PanelBody className="flex flex-col gap-5">
              {!d ? (
                <Skeleton className="h-24" />
              ) : (
                <>
                  <div className="flex h-3 gap-[3px] overflow-hidden rounded-full">
                    {seg.map((s) => (
                      <div key={s.key} className="h-full min-w-[3px]" style={{ flexGrow: activated ? s.n : 1, background: s.color }} title={`${s.label}: ${s.n}`} />
                    ))}
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    {seg.map((s) => (
                      <Tooltip key={s.key} content={s.define}>
                        <Link href={`/inventory?connectivity=${s.key}`} className="focus-ring group rounded-control p-1">
                          <p className="flex items-center gap-2 text-[13px] text-muted">
                            <span className="size-2 rounded-full" style={{ background: s.color }} />
                            {s.label}
                          </p>
                          <p className="mt-1 text-2xl font-semibold tracking-[-0.03em] tabular group-hover:underline">{fmt.number(s.n)}</p>
                          <p className="text-xs text-subtle">{activated ? fmt.pct(s.n / activated) : "—"}</p>
                        </Link>
                      </Tooltip>
                    ))}
                  </div>
                </>
              )}
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader>
              <div>
                <PanelTitle>Online, last 7 days</PanelTitle>
                <PanelDescription>Devices reporting per day</PanelDescription>
              </div>
            </PanelHeader>
            <PanelBody>
              {trends.isPending ? (
                <Skeleton className="h-36" />
              ) : !(trends.data ?? []).length ? (
                <p className="py-10 text-center text-sm text-subtle">No trend data yet</p>
              ) : (
                <EChart
                  label="Devices online per day"
                  className="h-36"
                  option={(p) => ({
                    grid: { left: 0, right: 0, top: 8, bottom: 0, containLabel: true },
                    tooltip: { trigger: "axis", ...tooltipStyle(p) },
                    xAxis: { type: "time", axisLine: { lineStyle: { color: p.line } }, axisTick: { show: false }, axisLabel: { color: p.subtle, fontSize: 11 }, splitLine: { show: false } },
                    yAxis: { type: "value", axisLabel: { color: p.subtle, fontSize: 11 }, splitLine: { lineStyle: { color: p.line } } },
                    series: [{ name: "Online", type: "line", smooth: 0.3, symbol: "none", data: trends.data!.map((t) => [t.at, t.online]), lineStyle: { width: 2, color: p.ion } }],
                  })}
                />
              )}
            </PanelBody>
          </Panel>
        </div>
      )}
      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <DeviceList title="Critical health" description="Failing checks or critical alerts" query={{ health: "critical" }} />
        <DeviceList title="Warning" description="Degraded battery, signal or data" query={{ health: "warning" }} />
        <DeviceList title="Stale telemetry" description="Talking, but data is old" query={{ connectivity: "stale" }} />
      </div>
    </>
  );
}

function DeviceList({ title, description, query }: { title: string; description: string; query: DeviceQuery }) {
  const q = useDevices({ ...query, limit: 8, sort: "health" });
  const href = `/inventory?${new URLSearchParams(query as Record<string, string>).toString()}`;
  return (
    <Panel className="flex flex-col overflow-hidden">
      <PanelHeader>
        <div>
          <PanelTitle className="flex items-center gap-2">
            {title}
            {q.data ? <span className="text-sm font-normal text-subtle tabular">{fmt.number(q.data.total)}</span> : null}
          </PanelTitle>
          <PanelDescription>{description}</PanelDescription>
        </div>
        <Button size="sm" variant="ghost" asChild>
          <Link href={href}>
            All
            <ArrowUpRight />
          </Link>
        </Button>
      </PanelHeader>
      <div className="flex-1 px-3 pb-3">
        {q.isPending ? (
          <div className="flex flex-col gap-2 p-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : q.error ? (
          <ApiError error={q.error} compact className="p-3" />
        ) : q.data.items.length === 0 ? (
          <Empty icon={HeartPulse} title="None" className="py-8" />
        ) : (
          <ul className={cn("flex flex-col gap-0.5")}>
            {q.data.items.map((d) => (
              <li key={d.id}>
                <Link href={`/devices/${d.id}`} className="focus-ring flex items-center gap-3 rounded-[14px] px-3 py-2.5 hover:bg-hover">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12.5px] font-medium">{d.udi ?? d.serial}</span>
                    <span className="block truncate text-xs text-subtle">{d.health?.issues?.[0] ?? `Seen ${fmt.ago(d.health?.lastSeenAt)}`}</span>
                  </span>
                  <span className="flex flex-col items-end gap-1">
                    <HealthBadge level={d.health?.level} className="text-xs" />
                    <ConnectivityDot value={d.health?.connectivity ?? "never_seen"} withLabel={false} />
                  </span>
                  <span className="hidden 2xl:block">
                    <LifecycleBadge state={d.lifecycle} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
