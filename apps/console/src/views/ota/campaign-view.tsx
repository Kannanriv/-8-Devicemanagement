"use client";

import * as React from "react";
import { Pause, Play, Radar, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import type { OtaCampaign } from "@hash8/sdk-ts";
import { PageHeader, Stat } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { CampaignStatusBadge } from "@/components/status";
import { RunView } from "@/components/shell/copilot";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, useCampaignAction, useFirmware, useRunAgent, type CampaignAction } from "@/lib/api";
import { useCampaign } from "@/lib/api-v11";
import { cn, fmt } from "@/lib/utils";
import { campaignTotals, WaveBoard } from "./waves";

export function CampaignView({ id }: { id: string }) {
  const q = useCampaign(id);
  if (q.isPending)
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-24 w-96" />
        <div className="grid gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-72 rounded-card" />
          ))}
        </div>
      </div>
    );
  if (q.error || !q.data)
    return (
      <>
        <PageHeader title="Campaign" back={{ href: "/ota", label: "Firmware & OTA" }} />
        <Panel>
          <ApiError error={q.error} onRetry={() => void q.refetch()} />
        </Panel>
      </>
    );
  return <Loaded c={q.data} />;
}

function Loaded({ c }: { c: OtaCampaign }) {
  const action = useCampaignAction();
  const firmware = useFirmware();
  const runAgent = useRunAgent();
  const [runId, setRunId] = React.useState<string>();
  const fw = firmware.data?.find((f) => f.id === c.firmwareId);
  const t = campaignTotals(c);
  const gateTripped = t.failureRate > c.healthGate.maxFailureRate;

  const act = (a: CampaignAction, label: string) =>
    action.mutate(
      { id: c.id, action: a },
      {
        onSuccess: () => toast.success(label),
        onError: (e) => toast.error(`Couldn’t ${a} the campaign`, { description: errorMessage(e) }),
      },
    );

  const pending = action.isPending ? action.variables?.action : undefined;

  return (
    <>
      <PageHeader
        back={{ href: "/ota", label: "Firmware & OTA" }}
        title={c.name}
        description={
          <>
            Firmware <span className="font-mono text-fg">{fw?.version ?? c.firmwareId}</span>
            {c.fromVersions.length ? <> replacing {c.fromVersions.join(", ")}</> : null}, created {fmt.ago(c.createdAt)}
          </>
        }
        meta={
          <>
            <CampaignStatusBadge status={c.status} />
            {Object.entries(c.cohort ?? {})
              .filter(([k, v]) => v != null && k !== "limit" && k !== "cursor")
              .map(([k, v]) => (
                <Badge key={k}>
                  {fmt.label(k)}: {String(v)}
                </Badge>
              ))}
          </>
        }
        actions={
          <>
            <Button
              variant="ghost"
              disabled={runAgent.isPending}
              onClick={() =>
                runAgent.mutate(
                  { agent: "rollout-guardian", input: { campaignId: c.id } },
                  { onSuccess: (r) => setRunId(r.id), onError: (e) => toast.error("Rollout Guardian didn’t start", { description: errorMessage(e) }) },
                )
              }
            >
              {runAgent.isPending ? <Spinner /> : <Radar />}
              Ask Rollout Guardian
            </Button>
            {c.status === "draft" ? (
              <Button variant="accent" disabled={!!pending} onClick={() => act("start", "Rollout started")}>
                {pending === "start" ? <Spinner /> : <Play />}
                Start rollout
              </Button>
            ) : null}
            {c.status === "running" ? (
              <Button variant="secondary" disabled={!!pending} onClick={() => act("pause", "Rollout paused")}>
                {pending === "pause" ? <Spinner /> : <Pause />}
                Pause
              </Button>
            ) : null}
            {c.status === "paused" ? (
              <Button variant="primary" disabled={!!pending} onClick={() => act("resume", "Rollout resumed")}>
                {pending === "resume" ? <Spinner /> : <Play />}
                Resume
              </Button>
            ) : null}
            {c.status === "running" || c.status === "paused" || c.status === "failed" ? (
              <Button
                variant="danger"
                disabled={!!pending}
                onClick={() => {
                  if (window.confirm("Roll back every updated device to its previous firmware?")) act("rollback", "Rollback started");
                }}
              >
                {pending === "rollback" ? <Spinner /> : <RotateCcw />}
                Roll back
              </Button>
            ) : null}
          </>
        }
      />

      <div className="flex flex-col gap-6">
        <WaveBoard c={c} />
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Panel>
            <PanelHeader>
              <div>
                <PanelTitle>Health gate</PanelTitle>
                <PanelDescription>A wave only advances when both conditions hold</PanelDescription>
              </div>
              <Badge tone={gateTripped ? "danger" : "ion"}>{gateTripped ? "Tripped" : "Holding"}</Badge>
            </PanelHeader>
            <PanelBody className="flex flex-col gap-5">
              <GateMeter label="Failure rate" value={t.failureRate} limit={c.healthGate.maxFailureRate} format={fmt.pct} direction="max" />
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-muted">Minimum health score to proceed</span>
                <span className="font-semibold tabular">{c.healthGate.minHealthScore}</span>
              </div>
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader>
              <PanelTitle>Totals</PanelTitle>
            </PanelHeader>
            <PanelBody className="grid grid-cols-3 gap-4">
              <Stat label="Targeted" value={fmt.number(t.targeted)} />
              <Stat label="Updated" value={fmt.number(t.succeeded)} tone="ion" />
              <Stat label="Failed" value={fmt.number(t.failed)} tone={t.failed ? "danger" : undefined} />
            </PanelBody>
          </Panel>
        </div>
        {runId ? (
          <Panel>
            <PanelHeader>
              <PanelTitle>Rollout Guardian</PanelTitle>
            </PanelHeader>
            <PanelBody>
              <RunView runId={runId} />
            </PanelBody>
          </Panel>
        ) : null}
      </div>
    </>
  );
}

function GateMeter({
  label,
  value,
  limit,
  format,
}: {
  label: string;
  value: number;
  limit: number;
  format: (n: number) => string;
  direction: "max";
}) {
  const scale = Math.max(limit * 2, value * 1.1, 0.01);
  const over = value > limit;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between text-sm">
        <span className="text-muted">{label}</span>
        <span className={cn("font-semibold tabular", over ? "text-danger" : "text-fg")}>
          {format(value)} <span className="font-normal text-subtle">/ {format(limit)} max</span>
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-hover">
        <div className={cn("h-full rounded-full transition-[width] duration-700 ease-out-soft", over ? "bg-danger" : "bg-ion")} style={{ width: `${Math.min(1, value / scale) * 100}%` }} />
        <span aria-hidden className="absolute -top-1 -bottom-1 w-px bg-fg" style={{ left: `${(limit / scale) * 100}%` }} />
      </div>
    </div>
  );
}
