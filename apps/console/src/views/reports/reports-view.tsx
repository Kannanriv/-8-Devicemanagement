"use client";

import * as React from "react";
import type { EChartsCoreOption } from "echarts/core";
import { EChart, tooltipStyle } from "@/components/chart";
import { PageHeader, Stat } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Segmented } from "@/components/ui/tabs";
import { useFleetReport, useTrends } from "@/lib/api-v11";
import type { ChartPalette } from "@/lib/theme";
import { cn, fmt } from "@/lib/utils";

const PERIODS = { "7": 7, "30": 30, "90": 90 } as const;
type Period = keyof typeof PERIODS;

function axisBase(p: ChartPalette) {
  return {
    axisLine: { lineStyle: { color: p.line } },
    axisTick: { show: false },
    axisLabel: { color: p.subtle, fontSize: 11 },
    splitLine: { lineStyle: { color: p.line } },
  };
}

function barOption(entries: [string, number][], color: (p: ChartPalette) => string) {
  return (p: ChartPalette): EChartsCoreOption => ({
    grid: { left: 4, right: 24, top: 4, bottom: 4, containLabel: true },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, ...tooltipStyle(p) },
    xAxis: { type: "value", ...axisBase(p), axisLine: { show: false } },
    yAxis: {
      type: "category",
      inverse: true,
      data: entries.map(([k]) => fmt.label(k)),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: p.muted, fontSize: 12 },
    },
    series: [{ type: "bar", barWidth: 10, data: entries.map(([, v]) => v), itemStyle: { color: color(p), borderRadius: [0, 5, 5, 0] } }],
  });
}

export function ReportsView() {
  const [period, setPeriod] = React.useState<Period>("30");
  const range = React.useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - PERIODS[period] * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }, [period]);
  const report = useFleetReport(range);
  const trends = useTrends(PERIODS[period]);
  const r = report.data;

  const sorted = (rec: Record<string, number> | undefined) => Object.entries(rec ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8);

  return (
    <>
      <PageHeader
        title="Reports & analytics"
        description="Reliability, deployment, OTA, failures and connectivity across the fleet."
        actions={<Segmented label="Period" value={period} onValueChange={setPeriod} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />}
      />
      {report.error && !r ? (
        <Panel>
          <ApiError error={report.error} onRetry={() => void report.refetch()} />
        </Panel>
      ) : (
        <div className={cn("flex flex-col gap-6", report.isFetching && r && "opacity-80 transition-opacity")}>
          <Panel>
            <PanelHeader>
              <div>
                <PanelTitle>Reliability</PanelTitle>
                <PanelDescription>Share of activated devices online, per day</PanelDescription>
              </div>
              <div className="flex gap-8">
                <Stat label="Uptime" value={r ? fmt.pct(r.reliability.uptimePct / (r.reliability.uptimePct > 1 ? 100 : 1)) : "—"} tone="ion" />
                <Stat label="MTBF" value={r?.reliability.mtbfHours != null ? `${fmt.number(r.reliability.mtbfHours)} h` : "—"} />
              </div>
            </PanelHeader>
            <PanelBody>
              {!r ? (
                <Skeleton className="h-56" />
              ) : (
                <EChart
                  label="Online percentage over time"
                  className="h-56"
                  option={(p) => {
                    const pts = r.reliability.series.map((s) => [s.at, s.onlinePct > 1 ? s.onlinePct : s.onlinePct * 100]);
                    return {
                      grid: { left: 4, right: 8, top: 12, bottom: 4, containLabel: true },
                      tooltip: { trigger: "axis", ...tooltipStyle(p), valueFormatter: (v: unknown) => `${Number(v).toFixed(1)}%` },
                      xAxis: { type: "time", ...axisBase(p), splitLine: { show: false } },
                      yAxis: { type: "value", min: (v: { min: number }) => Math.max(0, Math.floor(v.min - 5)), max: 100, ...axisBase(p), axisLabel: { color: p.subtle, formatter: "{value}%" } },
                      series: [
                        {
                          type: "line",
                          smooth: 0.3,
                          symbol: "none",
                          data: pts,
                          lineStyle: { width: 2, color: p.ion },
                          areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: `${p.ion}40` }, { offset: 1, color: `${p.ion}00` }] } },
                        },
                      ],
                    };
                  }}
                />
              )}
            </PanelBody>
          </Panel>

          <div className="grid gap-6 lg:grid-cols-3">
            <StatPanel
              title="Deployment"
              loading={!r}
              stats={r ? [["Installs", fmt.number(r.deployment.installs)], ["Success rate", fmt.pct(r.deployment.successRate)], ["Avg time to activate", `${fmt.number(r.deployment.avgActivationHours)} h`]] : []}
            />
            <StatPanel
              title="Firmware & OTA"
              loading={!r}
              stats={r ? [["Campaigns", fmt.number(r.ota.campaigns)], ["Success rate", fmt.pct(r.ota.successRate)], ["Rollbacks", fmt.number(r.ota.rollbacks)]] : []}
            />
            <StatPanel
              title="Utilization"
              loading={!r}
              stats={r ? [["Messages", fmt.compact(r.utilization.messages)], ["Decode rate", fmt.pct(r.utilization.decodeRate)], ["Devices active", fmt.pct(r.utilization.activeDevicesPct > 1 ? r.utilization.activeDevicesPct / 100 : r.utilization.activeDevicesPct)]] : []}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <ChartPanel title="Failures by cause" description="What broke" loading={!r} empty={!sorted(r?.failures.byCause).length} option={barOption(sorted(r?.failures.byCause), (p) => p.danger)} />
            <ChartPanel title="Failures by model" description="Where it broke" loading={!r} empty={!sorted(r?.failures.byModel).length} option={barOption(sorted(r?.failures.byModel), (p) => p.ember)} />
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <Panel>
              <PanelHeader>
                <div>
                  <PanelTitle>Connectivity</PanelTitle>
                  <PanelDescription>Data and signal across carriers</PanelDescription>
                </div>
                <div className="flex gap-6">
                  <Stat label="Data used" value={r ? `${fmt.compact(r.connectivity.dataUsageMb)} MB` : "—"} />
                  <Stat label="Avg signal" value={r?.connectivity.avgSignal != null ? `${Math.round(r.connectivity.avgSignal)} dBm` : "—"} />
                </div>
              </PanelHeader>
              <PanelBody>
                {!r ? (
                  <Skeleton className="h-44" />
                ) : sorted(r.connectivity.byCarrier).length ? (
                  <EChart label="Devices by carrier" className="h-44" option={barOption(sorted(r.connectivity.byCarrier), (p) => p.signal)} />
                ) : (
                  <p className="py-10 text-center text-sm text-subtle">No carrier data</p>
                )}
              </PanelBody>
            </Panel>
            <Panel>
              <PanelHeader>
                <div>
                  <PanelTitle>Activity trend</PanelTitle>
                  <PanelDescription>Messages and alerts per day</PanelDescription>
                </div>
              </PanelHeader>
              <PanelBody>
                {trends.isPending ? (
                  <Skeleton className="h-44" />
                ) : trends.error ? (
                  <ApiError error={trends.error} compact />
                ) : !(trends.data ?? []).length ? (
                  <p className="py-10 text-center text-sm text-subtle">No trend data yet</p>
                ) : (
                  <EChart
                    label="Messages and alerts per day"
                    className="h-44"
                    option={(p) => ({
                      grid: { left: 4, right: 4, top: 12, bottom: 4, containLabel: true },
                      tooltip: { trigger: "axis", ...tooltipStyle(p) },
                      xAxis: { type: "time", ...axisBase(p), splitLine: { show: false } },
                      yAxis: [
                        { type: "value", ...axisBase(p) },
                        { type: "value", ...axisBase(p), splitLine: { show: false } },
                      ],
                      series: [
                        { name: "Messages", type: "bar", barMaxWidth: 10, data: trends.data!.map((t) => [t.at, t.messages]), itemStyle: { color: `${p.signal}aa`, borderRadius: [3, 3, 0, 0] } },
                        { name: "Alerts", type: "line", yAxisIndex: 1, smooth: 0.3, symbol: "none", data: trends.data!.map((t) => [t.at, t.alerts]), lineStyle: { color: p.ember, width: 2 } },
                      ],
                    })}
                  />
                )}
              </PanelBody>
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}

function StatPanel({ title, stats, loading }: { title: string; stats: [string, string][]; loading: boolean }) {
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{title}</PanelTitle>
      </PanelHeader>
      <PanelBody className="grid grid-cols-3 gap-4">
        {loading
          ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-12" />)
          : stats.map(([label, value]) => <Stat key={label} label={label} value={value} />)}
      </PanelBody>
    </Panel>
  );
}

function ChartPanel({
  title,
  description,
  option,
  loading,
  empty,
}: {
  title: string;
  description: string;
  option: (p: ChartPalette) => EChartsCoreOption;
  loading: boolean;
  empty: boolean;
}) {
  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>{title}</PanelTitle>
          <PanelDescription>{description}</PanelDescription>
        </div>
      </PanelHeader>
      <PanelBody>
        {loading ? <Skeleton className="h-52" /> : empty ? <p className="py-12 text-center text-sm text-subtle">No failures in this period</p> : <EChart label={title} className="h-52" option={option} />}
      </PanelBody>
    </Panel>
  );
}
