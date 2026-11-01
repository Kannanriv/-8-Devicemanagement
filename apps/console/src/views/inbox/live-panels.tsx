"use client";

import * as React from "react";
import Link from "next/link";
import { Radio } from "lucide-react";
import { EChart, tooltipStyle } from "@/components/chart";
import { Badge, Dot } from "@/components/ui/badge";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { useLiveMessages, useLiveSeries, useLiveStatus, type LiveMessage } from "@/lib/live";
import { cn, fmt, formatValue } from "@/lib/utils";

/** Message volume (area) + decode rate (line) over the last five minutes of live traffic. */
export function TrafficChart() {
  const series = useLiveSeries();
  const status = useLiveStatus();
  const total = series.reduce((a, p) => a + p.n, 0);
  const ok = series.reduce((a, p) => a + p.ok, 0);
  const hasData = total > 0;

  return (
    <Panel>
      <PanelHeader className="pb-1">
        <div>
          <PanelTitle>Traffic</PanelTitle>
          <PanelDescription>Live, last 5 minutes</PanelDescription>
        </div>
        <div className="flex gap-6 text-right">
          <div>
            <p className="text-xl font-semibold tracking-[-0.02em] tabular">{fmt.compact(total)}</p>
            <p className="text-xs text-subtle">messages</p>
          </div>
          <div>
            <p className={cn("text-xl font-semibold tracking-[-0.02em] tabular", hasData && ok / total < 0.95 && "text-ember")}>
              {hasData ? fmt.pct(ok / total) : "—"}
            </p>
            <p className="text-xs text-subtle">decoded</p>
          </div>
        </div>
      </PanelHeader>
      <PanelBody className="pb-4">
        {hasData ? (
          <EChart
            label={`Message volume and decode rate, ${total} messages in the last five minutes`}
            className="h-36"
            option={(p) => ({
              grid: { left: 0, right: 0, top: 12, bottom: 0, containLabel: false },
              tooltip: {
                trigger: "axis",
                ...tooltipStyle(p),
                axisPointer: { type: "line", lineStyle: { color: p.line } },
                valueFormatter: (v: unknown) => String(v),
              },
              xAxis: { type: "time", show: false },
              yAxis: [
                { type: "value", show: false, min: 0 },
                { type: "value", show: false, min: 0, max: 100 },
              ],
              series: [
                {
                  name: "Messages",
                  type: "line",
                  smooth: 0.35,
                  symbol: "none",
                  data: series.map((d) => [d.t, d.n]),
                  lineStyle: { width: 1.5, color: p.signal },
                  areaStyle: {
                    color: {
                      type: "linear",
                      x: 0,
                      y: 0,
                      x2: 0,
                      y2: 1,
                      colorStops: [
                        { offset: 0, color: `${p.signal}55` },
                        { offset: 1, color: `${p.signal}00` },
                      ],
                    },
                  },
                },
                {
                  name: "Decoded %",
                  type: "line",
                  yAxisIndex: 1,
                  smooth: 0.35,
                  symbol: "none",
                  data: series.map((d) => [d.t, d.n ? Math.round((d.ok / d.n) * 100) : null]),
                  lineStyle: { width: 1.5, color: p.ion, type: [4, 4] },
                  connectNulls: true,
                },
              ],
            })}
          />
        ) : (
          <div className="flex h-36 items-center justify-center rounded-card border border-dashed border-line text-sm text-subtle">
            {status === "open" ? "Waiting for the first message…" : "Live stream offline"}
          </div>
        )}
        <div className="mt-3 flex gap-4 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded-full bg-signal" /> Volume
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded-full border-t border-dashed border-ion" /> Decode rate
          </span>
        </div>
      </PanelBody>
    </Panel>
  );
}

export function LiveStream({ limit = 14, className }: { limit?: number; className?: string }) {
  const messages = useLiveMessages();
  const status = useLiveStatus();
  const shown = messages.slice(0, limit);
  return (
    <Panel className={cn("flex min-h-0 flex-col", className)}>
      <PanelHeader className="pb-2">
        <div>
          <PanelTitle>Decoded stream</PanelTitle>
          <PanelDescription>Every uplink, as it lands</PanelDescription>
        </div>
        <Badge tone={status === "open" ? "ion" : status === "connecting" ? "neutral" : "ember"}>
          <Dot tone={status === "open" ? "ion" : status === "connecting" ? "neutral" : "ember"} live={status === "open"} className="size-1.5 [&>span]:size-1.5" />
          {status === "open" ? "Live" : status === "connecting" ? "Connecting" : "Offline"}
        </Badge>
      </PanelHeader>
      <div className="min-h-0 flex-1 px-3 pb-3" aria-live="off">
        {shown.length === 0 ? (
          <Empty icon={Radio} title={status === "open" ? "Listening" : "Stream offline"} className="py-10">
            {status === "open"
              ? "Decoded messages appear here in real time. Run the simulator with npm run simulate."
              : "Start the API with npm run dev:api. The stream reconnects on its own."}
          </Empty>
        ) : (
          <ul className="flex flex-col">
            {shown.map((m) => (
              <StreamRow key={m.id} m={m} />
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

const StreamRow = React.memo(function StreamRow({ m }: { m: LiveMessage }) {
  const fields = m.data ? Object.entries(m.data).filter(([, v]) => typeof v !== "object" || v === null).slice(0, 3) : [];
  const decoded = m.status ? m.status === "decoded" : !!m.message;
  const label = m.deviceSerial ?? (m.deviceId ? m.deviceId.slice(0, 10) : "device");
  const body = (
    <>
      <div className="flex items-center gap-2">
        <Dot tone={decoded ? "ion" : m.status === "error" ? "danger" : "ember"} />
        <span className="truncate font-mono text-[12.5px] text-fg">{label}</span>
        <span className="truncate text-[13px] text-muted">{decoded ? m.message : m.status === "error" ? "decode error" : "unknown payload"}</span>
        <span className="ml-auto shrink-0 text-xs text-subtle tabular">{fmt.time(m.receivedAt)}</span>
      </div>
      <p className="mt-1 truncate pl-4 text-[12.5px] text-subtle">
        {fields.length ? (
          fields.map(([k, v], i) => (
            <span key={k}>
              {i > 0 ? <span className="px-1.5 text-line-strong">/</span> : null}
              {k} <span className="text-muted tabular">{formatValue(v)}</span>
            </span>
          ))
        ) : (
          <span className="font-mono">{m.payloadHex ?? ""}</span>
        )}
      </p>
    </>
  );
  return (
    <li className="animate-row-in rounded-[14px]">
      {m.deviceId ? (
        <Link href={`/devices/${m.deviceId}`} className="focus-ring block rounded-[14px] px-3 py-2.5 transition-colors hover:bg-hover">
          {body}
        </Link>
      ) : (
        <div className="px-3 py-2.5">{body}</div>
      )}
    </li>
  );
});
