"use client";

import * as React from "react";
import Link from "next/link";
import { ExternalLink, SignalHigh } from "lucide-react";
import type { SimStatus } from "@hash8/sdk-ts";
import { EChart, tooltipStyle } from "@/components/chart";
import { PageHeader, Stat } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { SimBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { NativeSelect } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useSims } from "@/lib/api-v11";
import { cn, fmt } from "@/lib/utils";
import { SIM_MANAGEMENT_URL, simLink, UsageBar } from "@/views/device/sim-tab";

const STATUSES: SimStatus[] = ["active", "inactive", "suspended", "terminated", "unknown"];

export function ConnectivityView() {
  const [status, setStatus] = React.useState("");
  const [carrier, setCarrier] = React.useState("");
  const all = useSims();
  const sims = useSims({ status: status || undefined, carrier: carrier || undefined });
  const base = all.data ?? [];
  const carriers = React.useMemo(() => [...new Set(base.map((s) => s.carrier))].sort(), [base]);

  const summary = React.useMemo(() => {
    const byStatus: Record<string, number> = {};
    const byCarrier = new Map<string, { n: number; used: number; limit: number }>();
    let near = 0;
    for (const s of base) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
      const c = byCarrier.get(s.carrier) ?? { n: 0, used: 0, limit: 0 };
      c.n++;
      c.used += s.usageMbMonth ?? 0;
      c.limit += s.planLimitMb ?? 0;
      byCarrier.set(s.carrier, c);
      if (s.planLimitMb && (s.usageMbMonth ?? 0) / s.planLimitMb > 0.9) near++;
    }
    return { byStatus, byCarrier: [...byCarrier.entries()].sort((a, b) => b[1].n - a[1].n), near };
  }, [base]);

  const list = sims.data ?? [];

  return (
    <>
      <PageHeader
        title="Connectivity & SIM"
        description="Every SIM by carrier, status and data use. SIM lifecycle is managed in #8 SIM Management."
        actions={
          <Button variant="secondary" asChild>
            <a href={SIM_MANAGEMENT_URL} target="_blank" rel="noreferrer">
              Open #8 SIM Management
              <ExternalLink />
            </a>
          </Button>
        }
      />
      {all.error && !all.data ? (
        <Panel>
          <ApiError error={all.error} onRetry={() => void all.refetch()} />
        </Panel>
      ) : (
        <>
          <Panel className="overflow-hidden">
            <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 xl:grid-cols-5">
              {[
                { label: "SIMs", value: base.length },
                { label: "Active", value: summary.byStatus.active ?? 0, tone: "ion" as const },
                { label: "Suspended", value: summary.byStatus.suspended ?? 0, tone: "ember" as const },
                { label: "Inactive", value: summary.byStatus.inactive ?? 0 },
                { label: "Above 90% of plan", value: summary.near, tone: summary.near ? ("danger" as const) : undefined },
              ].map((c) => (
                <div key={c.label} className="bg-panel px-6 py-5">
                  {all.isPending ? <Skeleton className="h-12 w-24" /> : <Stat label={c.label} value={fmt.number(c.value)} tone={c.value ? c.tone : undefined} />}
                </div>
              ))}
            </dl>
          </Panel>
          <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
            <Panel className="min-w-0 overflow-hidden">
              <PanelHeader>
                <div>
                  <PanelTitle>SIMs</PanelTitle>
                  <PanelDescription>{sims.data ? `${fmt.number(list.length)} shown` : "Loading"}</PanelDescription>
                </div>
                <div className="flex gap-2">
                  <NativeSelect aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
                    <option value="">Any status</option>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {fmt.label(s)}
                      </option>
                    ))}
                  </NativeSelect>
                  <NativeSelect aria-label="Carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} className="w-40">
                    <option value="">All carriers</option>
                    {carriers.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </PanelHeader>
              {sims.isPending ? (
                <div className="flex flex-col gap-2 px-7 pb-7">
                  {Array.from({ length: 6 }, (_, i) => (
                    <Skeleton key={i} className="h-12" />
                  ))}
                </div>
              ) : list.length === 0 ? (
                <Empty icon={SignalHigh} title="No SIMs here">
                  SIMs appear once devices report an ICCID or are linked in #8 SIM Management.
                </Empty>
              ) : (
                <Table className={cn(sims.isFetching && "opacity-75")}>
                  <THead>
                    <TR>
                      <TH>ICCID</TH>
                      <TH className="hidden md:table-cell">Device</TH>
                      <TH>Carrier</TH>
                      <TH>Status</TH>
                      <TH className="hidden lg:table-cell">Usage this month</TH>
                      <TH className="w-12" />
                    </TR>
                  </THead>
                  <TBody>
                    {list.map((s) => (
                      <TR key={s.iccid}>
                        <TD>
                          <p className="font-mono text-[12.5px]">{s.iccid}</p>
                          {s.plan ? <p className="text-xs text-subtle">{s.plan}</p> : null}
                        </TD>
                        <TD className="hidden md:table-cell">
                          {s.deviceId ? (
                            <Link href={`/devices/${s.deviceId}#sim`} className="focus-ring rounded font-mono text-[12.5px] hover:underline">
                              {s.deviceUdi ?? s.deviceName ?? s.deviceId}
                            </Link>
                          ) : (
                            <span className="text-xs text-subtle">Unassigned</span>
                          )}
                        </TD>
                        <TD className="text-[13px]">{s.carrier}</TD>
                        <TD>
                          <SimBadge status={s.status} />
                        </TD>
                        <TD className="hidden lg:table-cell">
                          <UsageBar used={s.usageMbMonth} limit={s.planLimitMb} className="max-w-48" />
                        </TD>
                        <TD>
                          <Button size="icon-sm" variant="ghost" asChild>
                            <a href={simLink(s)} target="_blank" rel="noreferrer" aria-label={`Open ${s.iccid} in #8 SIM Management`}>
                              <ExternalLink />
                            </a>
                          </Button>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </Panel>
            <Panel className="h-fit">
              <PanelHeader>
                <div>
                  <PanelTitle>By carrier</PanelTitle>
                  <PanelDescription>SIM count and data used against plan</PanelDescription>
                </div>
              </PanelHeader>
              <PanelBody>
                {all.isPending ? (
                  <Skeleton className="h-56" />
                ) : summary.byCarrier.length === 0 ? (
                  <p className="py-10 text-center text-sm text-subtle">No carriers yet</p>
                ) : (
                  <>
                    <EChart
                      label="SIMs per carrier"
                      className="h-56"
                      option={(p) => ({
                        grid: { left: 4, right: 16, top: 4, bottom: 4, containLabel: true },
                        tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, ...tooltipStyle(p) },
                        xAxis: { type: "value", splitLine: { lineStyle: { color: p.line } }, axisLabel: { color: p.subtle } },
                        yAxis: {
                          type: "category",
                          inverse: true,
                          data: summary.byCarrier.map(([c]) => c),
                          axisLine: { show: false },
                          axisTick: { show: false },
                          axisLabel: { color: p.muted },
                        },
                        series: [
                          {
                            name: "SIMs",
                            type: "bar",
                            barWidth: 12,
                            data: summary.byCarrier.map(([, v]) => v.n),
                            itemStyle: { color: p.signal, borderRadius: [0, 6, 6, 0] },
                          },
                        ],
                      })}
                    />
                    <ul className="mt-4 flex flex-col gap-3">
                      {summary.byCarrier.map(([c, v]) => (
                        <li key={c} className="flex items-center gap-3 text-[13px]">
                          <span className="w-28 truncate">{c}</span>
                          <UsageBar used={Math.round(v.used)} limit={v.limit || undefined} className="flex-1" />
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </PanelBody>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
