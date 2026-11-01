"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { MapPinOff } from "lucide-react";
import type { Device, DeviceQuery } from "@hash8/sdk-ts";
import { EChart, tooltipStyle } from "@/components/chart";
import { ApiError } from "@/components/query-state";
import { Panel, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useDevices } from "@/lib/api";
import { fmt } from "@/lib/utils";

/** Stylised geo scatter on lat/lng — no tiles, just the fleet’s own shape. */
export function GeoView({ query }: { query: DeviceQuery }) {
  const router = useRouter();
  const devices = useDevices({ ...query, limit: 1000 });
  const located = React.useMemo(
    () => (devices.data?.items ?? []).filter((d) => typeof d.site?.lat === "number" && typeof d.site?.lng === "number"),
    [devices.data],
  );
  const bounds = React.useMemo(() => {
    if (!located.length) return null;
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (const d of located) {
      const lat = d.site!.lat!, lng = d.site!.lng!;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
    const padLat = Math.max(0.5, (maxLat - minLat) * 0.12);
    const padLng = Math.max(0.5, (maxLng - minLng) * 0.12);
    return { minLat: minLat - padLat, maxLat: maxLat + padLat, minLng: minLng - padLng, maxLng: maxLng + padLng };
  }, [located]);

  const groups = React.useMemo(() => {
    const g = { online: [] as Device[], stale: [] as Device[], offline: [] as Device[], never_seen: [] as Device[] };
    for (const d of located) (g[d.health?.connectivity ?? "never_seen"] ?? g.never_seen).push(d);
    return g;
  }, [located]);

  return (
    <Panel className="mt-3 overflow-hidden">
      <PanelHeader>
        <div>
          <PanelTitle>Geography</PanelTitle>
          <PanelDescription>
            {devices.data ? `${fmt.number(located.length)} of ${fmt.number(devices.data.items.length)} devices have a site location` : "Device sites by coordinates"}
          </PanelDescription>
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-muted">
          <Legend color="var(--ion)" label={`Online ${groups.online.length}`} />
          <Legend color="var(--ember)" label={`Stale ${groups.stale.length}`} />
          <Legend color="var(--danger)" label={`Offline ${groups.offline.length}`} />
          <Legend color="var(--subtle)" label={`Not commissioned ${groups.never_seen.length}`} />
        </div>
      </PanelHeader>
      {devices.isPending ? (
        <div className="px-7 pb-7">
          <Skeleton className="h-[520px] rounded-card" />
        </div>
      ) : devices.error ? (
        <ApiError error={devices.error} onRetry={() => void devices.refetch()} />
      ) : !bounds ? (
        <Empty icon={MapPinOff} title="No locations yet">
          Devices appear here once their site has latitude and longitude.
        </Empty>
      ) : (
        <div className="relative px-4 pb-4">
          <div aria-hidden className="pointer-events-none absolute inset-x-4 inset-y-0 rounded-card bg-[radial-gradient(circle_at_center,var(--hover)_1px,transparent_1.2px)] [background-size:22px_22px] opacity-80" />
          <EChart
            label={`Map of ${located.length} devices`}
            className="h-[min(62vh,560px)]"
            onClick={(p) => {
              const id = (p.data as { id?: string } | undefined)?.id;
              if (id) router.push(`/devices/${id}`);
            }}
            option={(p) => {
              const series = (name: string, list: Device[], color: string, glow: boolean) => ({
                name,
                type: "scatter",
                symbolSize: (v: number[]) => 7 + Math.min(6, (v[2] ?? 0) / 25),
                data: list.map((d) => ({
                  id: d.id,
                  name: d.udi ?? d.name ?? d.serial,
                  value: [d.site!.lng, d.site!.lat, d.health?.score ?? 0],
                  site: d.site?.name,
                })),
                itemStyle: {
                  color,
                  opacity: 0.9,
                  borderColor: p.panel,
                  borderWidth: 1,
                  shadowBlur: glow ? 12 : 0,
                  shadowColor: color,
                },
                emphasis: { scale: 1.6 },
              });
              return {
                grid: { left: 16, right: 16, top: 16, bottom: 16 },
                tooltip: {
                  ...tooltipStyle(p),
                  formatter: (x: { data: { name: string; site?: string; value: number[] } }) =>
                    `<div style="font-weight:600">${x.data.name}</div><div style="opacity:.7">${x.data.site ?? ""}</div><div style="opacity:.7">Health ${Math.round(x.data.value[2] ?? 0)}</div>`,
                },
                xAxis: { type: "value", min: bounds.minLng, max: bounds.maxLng, show: false },
                yAxis: { type: "value", min: bounds.minLat, max: bounds.maxLat, show: false },
                series: [
                  series("Not commissioned", groups.never_seen, p.subtle, false),
                  series("Stale", groups.stale, p.ember, false),
                  series("Offline", groups.offline, p.danger, false),
                  series("Online", groups.online, p.ion, true),
                ],
              };
            }}
          />
        </div>
      )}
    </Panel>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 tabular">
      <span className="size-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
