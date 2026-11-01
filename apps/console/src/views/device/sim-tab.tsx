"use client";

import { ExternalLink, Pause, Play, SignalHigh } from "lucide-react";
import { toast } from "sonner";
import type { Device, SimInfo } from "@hash8/sdk-ts";
import { ApiError } from "@/components/query-state";
import { SimBadge } from "@/components/status";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { useDeviceSim, useSimAction } from "@/lib/api-v11";
import { cn, fmt } from "@/lib/utils";

export const SIM_MANAGEMENT_URL = process.env.NEXT_PUBLIC_SIM_URL ?? "https://hash8-webapp.vercel.app";

export function simLink(sim: Pick<SimInfo, "externalUrl" | "iccid">) {
  return sim.externalUrl ?? `${SIM_MANAGEMENT_URL}/sim/${encodeURIComponent(sim.iccid)}`;
}

export function UsageBar({ used, limit, className }: { used?: number; limit?: number; className?: string }) {
  if (used == null) return <span className="text-xs text-subtle">—</span>;
  const pct = limit ? Math.min(1, used / limit) : 0;
  return (
    <div className={cn("flex min-w-32 flex-col gap-1", className)}>
      <div className="flex justify-between text-xs tabular">
        <span>{fmt.number(used)} MB</span>
        <span className="text-subtle">{limit ? `of ${fmt.number(limit)}` : "no cap"}</span>
      </div>
      {limit ? (
        <div className="h-1 overflow-hidden rounded-full bg-hover">
          <div className={cn("h-full rounded-full", pct > 0.9 ? "bg-danger" : pct > 0.75 ? "bg-ember" : "bg-ion")} style={{ width: `${pct * 100}%` }} />
        </div>
      ) : null}
    </div>
  );
}

export function SimTab({ d }: { d: Device }) {
  const q = useDeviceSim(d.id);
  const action = useSimAction(d.id);
  const sim = q.data ?? d.sim;

  if (q.isPending && !d.sim) return <Skeleton className="h-64 rounded-panel" />;
  if (!sim)
    return (
      <Panel>
        {q.error && !String(q.error).includes("404") ? (
          <ApiError error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <Empty icon={SignalHigh} title="No SIM on record">
            Link a SIM in #8 SIM Management and it shows here with live status and usage.
          </Empty>
        )}
      </Panel>
    );

  const run = (a: "activate" | "suspend") =>
    action.mutate(a, {
      onSuccess: () => toast.success(a === "activate" ? "SIM activation requested" : "SIM suspension requested"),
      onError: (e) => toast.error("SIM action failed", { description: errorMessage(e) }),
    });

  const rows: [string, React.ReactNode, boolean?][] = [
    ["ICCID", sim.iccid, true],
    ["IMSI", sim.imsi ?? "—", true],
    ["MSISDN", sim.msisdn ?? "—", true],
    ["Carrier", sim.carrier],
    ["Plan", sim.plan ?? "—"],
    ["Activated", sim.activatedAt ? fmt.dateTime(sim.activatedAt) : "—"],
  ];

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle className="flex items-center gap-2">
              SIM <SimBadge status={sim.status} />
            </PanelTitle>
            <PanelDescription>Connectivity is managed in #8 SIM Management</PanelDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {sim.status === "active" ? (
              <Button size="sm" variant="danger" disabled={action.isPending} onClick={() => run("suspend")}>
                {action.isPending ? <Spinner /> : <Pause />}
                Suspend SIM
              </Button>
            ) : sim.status !== "terminated" ? (
              <Button size="sm" variant="secondary" disabled={action.isPending} onClick={() => run("activate")}>
                {action.isPending ? <Spinner /> : <Play />}
                Activate SIM
              </Button>
            ) : null}
            <Button size="sm" variant="primary" asChild>
              <a href={simLink(sim)} target="_blank" rel="noreferrer">
                Open in #8 SIM Management
                <ExternalLink />
              </a>
            </Button>
          </div>
        </PanelHeader>
        <PanelBody>
          <dl className="grid gap-x-8 sm:grid-cols-2">
            {rows.map(([k, v, mono]) => (
              <div key={k} className="flex items-baseline justify-between gap-4 border-b border-line py-2.5">
                <dt className="text-[13px] text-muted">{k}</dt>
                <dd className={cn("truncate text-right text-[13px]", mono && "font-mono text-[12.5px]")}>{v}</dd>
              </div>
            ))}
          </dl>
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Data this month</PanelTitle>
            <PanelDescription>Usage against plan</PanelDescription>
          </div>
        </PanelHeader>
        <PanelBody className="flex flex-col gap-4">
          <p className="text-[34px] leading-none font-semibold tracking-[-0.03em] tabular">
            {sim.usageMbMonth != null ? fmt.number(sim.usageMbMonth) : "—"}
            <span className="ml-1 text-base font-normal text-subtle">MB</span>
          </p>
          <UsageBar used={sim.usageMbMonth} limit={sim.planLimitMb} />
          <p className="text-[13px] text-muted">
            Signal {d.health?.signal != null ? `${d.health.signal} dBm` : "unknown"}, last seen {fmt.ago(d.health?.lastSeenAt)}.
          </p>
        </PanelBody>
      </Panel>
    </div>
  );
}
