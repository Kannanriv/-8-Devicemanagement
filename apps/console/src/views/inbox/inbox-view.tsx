"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  BellRing,
  CheckCircle2,
  FileSpreadsheet,
  Hourglass,
  KeyRound,
  Power,
  SignalHigh,
  Rocket,
  SlidersHorizontal,
  Sparkles,
  Unplug,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { AgentName, OpsItem, Severity } from "@hash8/sdk-ts";
import { PageHeader, Stat } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { SeverityBadge } from "@/components/status";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { RunView } from "@/components/shell/copilot";
import { errorMessage, useFleetStats, useOpsInbox, useRunAgent } from "@/lib/api";
import { agentMeta } from "@/lib/agents";
import { cn, fmt } from "@/lib/utils";
import { LiveStream, TrafficChart } from "./live-panels";

const KIND_ICON: Record<OpsItem["kind"], LucideIcon> = {
  rollout: Rocket,
  unknown_payloads: Unplug,
  offline_cohort: WifiOff,
  cert_expiry: KeyRound,
  spec_review: FileSpreadsheet,
  alert: BellRing,
  config_drift: SlidersHorizontal,
  stale_telemetry: Hourglass,
  pending_activation: Power,
  sim_issue: SignalHigh,
};
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export function InboxView() {
  const inbox = useOpsInbox();
  const items = React.useMemo(
    () =>
      (inbox.data ?? []).toSorted(
        (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.count ?? 0) - (a.count ?? 0),
      ),
    [inbox.data],
  );
  const critical = items.filter((i) => i.severity === "critical").length;

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          inbox.isPending
            ? "Checking what needs your attention…"
            : inbox.error
              ? "Ranked work across your fleet, codecs and rollouts."
              : items.length === 0
                ? "Nothing needs you right now. The fleet is running on its own."
                : `${items.length} ${items.length === 1 ? "thing needs" : "things need"} your action${critical ? `, ${critical} critical` : ""}.`
        }
      />
      <KpiStrip />
      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Panel aria-labelledby="actions-title">
          <PanelHeader>
            <div>
              <PanelTitle id="actions-title">Needs action</PanelTitle>
              <PanelDescription>Ranked by severity and blast radius</PanelDescription>
            </div>
          </PanelHeader>
          <PanelBody className="px-3 pb-3 sm:px-3">
            {inbox.isPending ? (
              <div className="flex flex-col gap-2 p-3">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-[104px] rounded-card" />
                ))}
              </div>
            ) : inbox.error ? (
              <ApiError error={inbox.error} onRetry={() => void inbox.refetch()} />
            ) : items.length === 0 ? (
              <Empty icon={CheckCircle2} title="Inbox zero">
                Rollouts, codecs and devices are healthy. New issues show up here, ranked, the moment they appear.
              </Empty>
            ) : (
              <ul className="flex flex-col">
                {items.map((item) => (
                  <ActionCard key={item.id} item={item} />
                ))}
              </ul>
            )}
          </PanelBody>
        </Panel>
        <div className="flex min-w-0 flex-col gap-6">
          <TrafficChart />
          <LiveStream />
        </div>
      </div>
    </>
  );
}

function KpiStrip() {
  const stats = useFleetStats();
  const s = stats.data;
  if (stats.error && !s) {
    return (
      <Panel>
        <ApiError error={stats.error} onRetry={() => void stats.refetch()} />
      </Panel>
    );
  }
  const cells: { label: string; value: React.ReactNode; hint?: string; tone?: "ion" | "ember" | "danger" | "signal" }[] = s
    ? [
        { label: "Devices", value: fmt.number(s.devices), hint: `${fmt.number(s.offline)} offline` },
        { label: "Online", value: fmt.pct(s.devices ? s.online / s.devices : 0), hint: `${fmt.number(s.online)} reporting` },
        {
          label: "Decode rate",
          value: fmt.pct(s.decodeRate),
          hint: "Last 24 hours",
          tone: s.decodeRate < 0.95 ? "ember" : undefined,
        },
        { label: "Messages", value: fmt.compact(s.messages24h), hint: "Last 24 hours" },
        { label: "Avg health", value: fmt.number(Math.round(s.avgHealth)), hint: "Out of 100", tone: s.avgHealth < 60 ? "ember" : undefined },
        {
          label: "Open alerts",
          value: fmt.number(s.openAlerts),
          hint: `${fmt.number(s.activeCampaigns)} rollouts running`,
          tone: s.openAlerts > 0 ? "danger" : undefined,
        },
      ]
    : [];
  return (
    <Panel className="overflow-hidden" aria-label="Fleet summary">
      <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 xl:grid-cols-6">
        {s
          ? cells.map((c) => (
              <div key={c.label} className="bg-panel px-6 py-5">
                <Stat label={c.label} value={c.value} hint={c.hint} tone={c.tone} />
              </div>
            ))
          : Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex flex-col gap-2 bg-panel px-6 py-5">
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="h-7 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
      </dl>
    </Panel>
  );
}

function ActionCard({ item }: { item: OpsItem }) {
  const Icon = KIND_ICON[item.kind] ?? BellRing;
  const runAgent = useRunAgent();
  const [runId, setRunId] = React.useState<string>();
  const agent = item.suggestedAction?.agent as AgentName | undefined;

  const act = () => {
    if (!agent) return;
    runAgent.mutate(
      { agent, input: { opsItemId: item.id, kind: item.kind, href: item.href, title: item.title } },
      {
        onSuccess: (r) => setRunId(r.id),
        onError: (e) => toast.error(`${agentMeta(agent).title} didn’t start`, { description: errorMessage(e) }),
      },
    );
  };

  return (
    <li className="group rounded-card px-4 py-4 transition-colors hover:bg-hover sm:px-5">
      <div className="flex gap-4">
        <span
          className={cn(
            "mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-[14px] ring-1 ring-inset",
            item.severity === "critical" && "bg-danger/10 text-danger ring-danger/25",
            item.severity === "warning" && "bg-ember/10 text-ember ring-ember/25",
            item.severity === "info" && "bg-signal/10 text-signal ring-signal/25",
          )}
        >
          <Icon className="size-[18px]" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link href={item.href} className="focus-ring rounded text-[15px] font-semibold tracking-[-0.015em] hover:underline hover:underline-offset-4">
              {item.title}
            </Link>
            <SeverityBadge severity={item.severity} />
          </div>
          <p className="mt-1 text-sm text-muted">{item.summary}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {item.suggestedAction ? (
              agent ? (
                <Button size="sm" variant="primary" onClick={act} disabled={runAgent.isPending || !!runId}>
                  {runAgent.isPending ? <Spinner /> : <Sparkles />}
                  {item.suggestedAction.label}
                </Button>
              ) : (
                <Button size="sm" variant="primary" asChild>
                  <Link href={item.href}>{item.suggestedAction.label}</Link>
                </Button>
              )
            ) : null}
            <Button size="sm" variant="ghost" asChild>
              <Link href={item.href}>
                Open
                <ArrowUpRight />
              </Link>
            </Button>
            <span className="ml-auto text-xs text-subtle">{fmt.ago(item.createdAt)}</span>
          </div>
        </div>
        {item.count != null ? (
          <div className="hidden shrink-0 flex-col items-end sm:flex">
            <span className="text-[28px] leading-none font-semibold tracking-[-0.03em] tabular">{fmt.compact(item.count)}</span>
            <span className="mt-1 text-xs text-subtle">affected</span>
          </div>
        ) : null}
      </div>
      {runId ? (
        <div className="mt-4 ml-14 rounded-card border border-line bg-sunken/50 p-4">
          <RunView runId={runId} />
        </div>
      ) : null}
    </li>
  );
}
