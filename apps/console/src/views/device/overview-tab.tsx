"use client";

import * as React from "react";
import { Battery, Gauge, Hourglass, Radio, Signal, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import type { Device, LifecycleState } from "@hash8/sdk-ts";
import { LIFECYCLE_TRANSITIONS } from "@hash8/sdk-ts";
import type { DeviceCodecSpec } from "@hash8/dcs-schema";
import { ConnectivityDot, HealthBadge, healthTone, LIFECYCLE_MAIN, LifecycleBadge, lifecycleLabel } from "@/components/status";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { errorMessage, useDeviceHealth, useLifecycleTransition } from "@/lib/api";
import { unitIndex, unitLabel } from "@/lib/dcs";
import { cn, flatten, fmt, formatValue } from "@/lib/utils";

export function OverviewTab({ d, spec }: { d: Device; spec?: DeviceCodecSpec }) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="flex min-w-0 flex-col gap-6">
        <ShadowPanel d={d} spec={spec} />
        <LifecyclePanel d={d} />
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <HealthPanel d={d} />
        <IdentityPanel d={d} />
      </div>
    </div>
  );
}

function ShadowPanel({ d, spec }: { d: Device; spec?: DeviceCodecSpec }) {
  const units = React.useMemo(() => unitIndex(spec), [spec]);
  const entries = Object.entries(flatten(d.shadow ?? {}));
  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>Reported state</PanelTitle>
          <PanelDescription>Latest decoded values{d.codecId ? ` via ${d.codecId}@${d.codecVersion ?? "latest"}` : ""}</PanelDescription>
        </div>
        <span className="text-xs text-subtle">Updated {fmt.ago(d.health?.lastSeenAt ?? d.updatedAt)}</span>
      </PanelHeader>
      <PanelBody>
        {entries.length === 0 ? (
          <Empty icon={Radio} title="No telemetry yet" className="py-8">
            Values appear after the first decoded uplink.
          </Empty>
        ) : (
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-card bg-line ring-1 ring-line sm:grid-cols-3 2xl:grid-cols-4">
            {entries.map(([k, v]) => {
              const unit = unitLabel(units.get(k) ?? units.get(k.split(".").pop() ?? ""));
              const numeric = typeof v === "number";
              return (
                <div key={k} className="flex min-w-0 flex-col gap-1.5 bg-panel px-4 py-3.5">
                  <dt className="truncate text-xs text-muted" title={k}>
                    {k}
                  </dt>
                  <dd className="flex items-baseline gap-1 truncate">
                    <span className={cn("tabular", numeric ? "text-xl font-semibold tracking-[-0.02em]" : "text-[15px] font-medium")}>
                      {formatValue(v)}
                    </span>
                    {unit ? <span className="text-xs text-subtle">{unit}</span> : null}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </PanelBody>
    </Panel>
  );
}

function LifecyclePanel({ d }: { d: Device }) {
  const transition = useLifecycleTransition();
  const allowed = LIFECYCLE_TRANSITIONS[d.lifecycle] ?? [];
  const idx = LIFECYCLE_MAIN.indexOf(d.lifecycle);
  const offPath = idx === -1;
  const [pending, setPending] = React.useState<LifecycleState | null>(null);
  const reached = offPath ? LIFECYCLE_MAIN.length - 1 : idx;

  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>Lifecycle</PanelTitle>
          <PanelDescription>
            {offPath
              ? `${lifecycleLabel(d.lifecycle)}, outside the activation path`
              : d.activatedAt
                ? `Activated ${fmt.ago(d.activatedAt)}`
                : d.installedAt
                  ? `Installed ${fmt.ago(d.installedAt)}`
                  : "From registration to activation"}
          </PanelDescription>
        </div>
        <span className="text-xs text-subtle">Provisioning: {fmt.label(d.provisioning ?? "unprovisioned")}</span>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-6">
        <ol className="flex items-start" aria-label="Lifecycle progress">
          {LIFECYCLE_MAIN.map((s, i) => {
            const done = i < reached || (offPath && i <= reached);
            const current = s === d.lifecycle;
            return (
              <li key={s} className="flex min-w-0 flex-1 flex-col items-start gap-2" aria-current={current ? "step" : undefined}>
                <div className="flex w-full items-center">
                  <span
                    className={cn(
                      "relative flex size-3 shrink-0 rounded-full ring-1 ring-inset",
                      current ? "bg-signature ring-transparent" : done ? "bg-fg ring-fg" : "ring-line-strong",
                    )}
                  >
                    {current ? <span className="absolute -inset-1.5 rounded-full ring-1 ring-signal/40" /> : null}
                  </span>
                  {i < LIFECYCLE_MAIN.length - 1 ? <span className={cn("mx-2 h-px flex-1", done ? "bg-fg/60" : "bg-line-strong")} /> : null}
                </div>
                <span className={cn("pr-2 text-xs leading-tight", current ? "font-medium text-fg" : done ? "text-muted" : "text-subtle")}>
                  {lifecycleLabel(s)}
                </span>
              </li>
            );
          })}
        </ol>
        {offPath ? (
          <div className="flex items-center gap-2 text-[13px] text-muted">
            Now in <LifecycleBadge state={d.lifecycle} />
          </div>
        ) : null}
        <div>
          <p className="mb-2.5 text-[13px] text-muted">
            {allowed.length ? "Allowed next steps" : "Retired devices keep their history but can’t change state."}
          </p>
          <div className="flex flex-wrap gap-2">
            {allowed.map((s) => (
              <Button
                key={s}
                size="sm"
                variant={s === "retired" || s === "suspended" ? "danger" : "secondary"}
                disabled={transition.isPending}
                onClick={() => {
                  setPending(s);
                  transition.mutate(
                    { id: d.id, to: s },
                    {
                      onSuccess: () => toast.success(`Moved to ${lifecycleLabel(s)}`),
                      onError: (e) => toast.error("Lifecycle change failed", { description: errorMessage(e) }),
                      onSettled: () => setPending(null),
                    },
                  );
                }}
              >
                {pending === s ? <Spinner /> : null}
                {lifecycleLabel(s)}
              </Button>
            ))}
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

function HealthPanel({ d }: { d: Device }) {
  const h = useDeviceHealth(d.id);
  const health = h.data ?? d.health;
  const score = Math.round(health?.score ?? 0);
  const tone = healthTone(score);
  const color = tone === "ion" ? "var(--ion)" : tone === "ember" ? "var(--ember)" : "var(--danger)";
  const C = 2 * Math.PI * 44;
  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>Health</PanelTitle>
          <PanelDescription>
            Last seen {fmt.ago(health?.lastSeenAt)}
            {health?.lastHeartbeatAt ? `, heartbeat ${fmt.ago(health.lastHeartbeatAt)}` : ""}
          </PanelDescription>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <HealthBadge level={health?.level} />
          <ConnectivityDot value={health?.connectivity ?? "never_seen"} />
        </div>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-5">
        <div className="flex items-center gap-5">
          <div className="relative size-28 shrink-0">
            <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden>
              <circle cx="50" cy="50" r="44" fill="none" stroke="var(--line)" strokeWidth="6" />
              <circle
                cx="50"
                cy="50"
                r="44"
                fill="none"
                stroke={color}
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={`${(score / 100) * C} ${C}`}
                className="transition-[stroke-dasharray] duration-700 ease-out-soft"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-3xl font-semibold tracking-[-0.03em] tabular">{score}</span>
              <span className="text-[11px] text-subtle">of 100</span>
            </div>
          </div>
          <dl className="grid flex-1 grid-cols-1 gap-3 text-sm">
            <Metric icon={Battery} label="Battery" value={health?.battery != null ? `${Math.round(health.battery)}%` : "—"} />
            <Metric icon={Signal} label="Signal" value={health?.signal != null ? `${health.signal} dBm` : "—"} />
            <Metric icon={Gauge} label="Rate" value={health?.msgRatePerHour != null ? `${fmt.number(health.msgRatePerHour)}/h` : "—"} />
            <Metric icon={Hourglass} label="Data age" value={health?.dataFreshnessSec != null ? fmtAge(health.dataFreshnessSec) : "—"} />
          </dl>
        </div>
        {health?.issues?.length ? (
          <ul className="flex flex-col gap-2">
            {health.issues.map((i) => (
              <li key={i} className="flex items-start gap-2.5 rounded-control bg-ember/[0.07] px-3.5 py-2.5 text-sm ring-1 ring-ember/20 ring-inset">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-ember" />
                {i}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No open health issues.</p>
        )}
      </PanelBody>
    </Panel>
  );
}

function fmtAge(sec: number) {
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${Math.round(sec / 3600)} h`;
  return `${Math.round(sec / 86400)} d`;
}

function Metric({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon className="size-4 text-subtle" />
      <dt className="text-muted">{label}</dt>
      <dd className="ml-auto font-medium tabular">{value}</dd>
    </div>
  );
}

function IdentityPanel({ d }: { d: Device }) {
  const rows: [string, React.ReactNode, boolean?][] = [
    ["UDI", d.udi ?? "—", true],
    ["Serial", d.serial, true],
    ["IMEI", d.imei ?? "—", true],
    ["ICCID", d.sim?.iccid ?? "—", true],
    ["Model", d.model ?? d.modelId],
    ["OEM", d.oem ?? "—"],
    ["Organization", [d.organization, d.branch].filter(Boolean).join(", ") || "—"],
    ["Firmware", d.firmwareVersion ?? "—", true],
    ["Codec", d.codecId ? `${d.codecId}@${d.codecVersion ?? "latest"}` : "—", true],
    ["Config profile", d.configProfileId ? `${d.configProfileId}${d.configVersion != null ? ` v${d.configVersion}` : ""}` : "—", true],
    ["Batch", d.batchId ?? "—", true],
    ["Installed", d.installedAt ? fmt.dateTime(d.installedAt) : "—"],
    ["Registered", fmt.dateTime(d.createdAt)],
  ];
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Identity</PanelTitle>
      </PanelHeader>
      <PanelBody>
        <dl className="flex flex-col">
          {rows.map(([k, v, mono]) => (
            <div key={k} className="flex items-baseline justify-between gap-4 border-b border-line py-2.5 last:border-0">
              <dt className="shrink-0 text-[13px] text-muted">{k}</dt>
              <dd className={cn("min-w-0 truncate text-right text-[13px]", mono && "font-mono text-[12.5px]")} title={typeof v === "string" ? v : undefined}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      </PanelBody>
    </Panel>
  );
}
