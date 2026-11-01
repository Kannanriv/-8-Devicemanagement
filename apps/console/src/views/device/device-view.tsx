"use client";

import * as React from "react";
import {
  Activity,
  GitBranch,
  HardDriveDownload,
  KeyRound,
  LayoutGrid,
  Link2,
  MessageSquareCode,
  ScrollText,
  Send,
  SignalHigh,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import type { Device } from "@hash8/sdk-ts";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { ConnectivityDot, HealthBadge, LifecycleBadge } from "@/components/status";
import { BulkFlow } from "@/components/bulk-flow";
import { useShell } from "@/components/shell/shell-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCodecSpec, useDevice } from "@/lib/api";
import { OverviewTab } from "./overview-tab";
import { MessagesTab } from "./messages-tab";
import { HistoryTab } from "./history-tab";
import { ConfigTab } from "./config-tab";
import { CommandsTab } from "./commands-tab";
import { FirmwareTab } from "./firmware-tab";
import { AuditTab } from "./audit-tab";
import { SimTab } from "./sim-tab";
import { AssetTab } from "./asset-tab";
import { CredentialsTab } from "./credentials-tab";

const TABS = [
  { value: "overview", label: "Overview", icon: LayoutGrid },
  { value: "messages", label: "Messages", icon: MessageSquareCode },
  { value: "history", label: "History", icon: Activity },
  { value: "config", label: "Configuration", icon: SlidersHorizontal },
  { value: "commands", label: "Commands", icon: Send },
  { value: "firmware", label: "Firmware", icon: HardDriveDownload },
  { value: "sim", label: "SIM", icon: SignalHigh },
  { value: "asset", label: "Asset", icon: Link2 },
  { value: "credentials", label: "Credentials", icon: KeyRound },
  { value: "audit", label: "Audit", icon: ScrollText },
] as const;

export function DeviceView({ id }: { id: string }) {
  const device = useDevice(id);
  const [tab, setTab] = React.useState<string>("overview");

  React.useEffect(() => {
    const h = window.location.hash.slice(1);
    if (TABS.some((t) => t.value === h)) setTab(h);
  }, []);
  const onTab = (v: string) => {
    setTab(v);
    window.history.replaceState(null, "", `#${v}`);
  };

  if (device.isPending) return <DeviceSkeleton />;
  if (device.error || !device.data)
    return (
      <>
        <PageHeader title="Device" back={{ href: "/inventory", label: "Inventory" }} />
        <Panel>
          <ApiError error={device.error} onRetry={() => void device.refetch()} />
        </Panel>
      </>
    );
  return <DeviceLoaded d={device.data} tab={tab} onTab={onTab} />;
}

function Axis({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11.5px] text-subtle">{label}</span>
      <div className="flex h-6 items-center">{children}</div>
    </div>
  );
}

function DeviceLoaded({ d, tab, onTab }: { d: Device; tab: string; onTab: (v: string) => void }) {
  const { actions } = useShell();
  const [lcOpen, setLcOpen] = React.useState(false);
  const spec = useCodecSpec(d.codecId, d.codecVersion);
  const title = d.name ?? d.udi ?? d.serial;
  return (
    <>
      <PageHeader
        back={{ href: "/inventory", label: "Inventory" }}
        title={title}
        description={
          <span>
            <span className="font-mono text-[14px] text-fg">{d.udi ?? d.serial}</span>
            <span className="text-muted">
              {" "}
              {d.model ?? d.modelId}
              {d.oem ? ` by ${d.oem}` : ""}
              {d.site?.name ? `, at ${d.site.name}` : ""}
            </span>
          </span>
        }
        meta={
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <Axis label="Lifecycle">
              <LifecycleBadge state={d.lifecycle} />
            </Axis>
            <Axis label="Connectivity">
              <ConnectivityDot value={d.health?.connectivity ?? "never_seen"} />
            </Axis>
            <Axis label="Health">
              <HealthBadge level={d.health?.level} score={d.health?.score} />
            </Axis>
            {d.tags.length ? (
              <Axis label="Tags">
                <div className="flex gap-1">
                  {d.tags.slice(0, 4).map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </div>
              </Axis>
            ) : null}
          </div>
        }
        actions={
          <>
            <Button variant="ghost" onClick={() => actions.askCopilot(`What's going on with device ${d.udi ?? d.serial}?`)}>
              <Sparkles />
              Ask Copilot
            </Button>
            <Button variant="secondary" onClick={() => setLcOpen(true)}>
              <GitBranch />
              Lifecycle
            </Button>
            <Button variant="primary" onClick={() => onTab("commands")}>
              <Send />
              Send command
            </Button>
          </>
        }
      />
      <Tabs value={tab} onValueChange={onTab}>
        <TabsList aria-label="Device sections">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <TabsTrigger key={t.value} value={t.value}>
                <Icon />
                {t.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab d={d} spec={spec.data} />
        </TabsContent>
        <TabsContent value="messages">
          <MessagesTab d={d} />
        </TabsContent>
        <TabsContent value="history">
          <HistoryTab id={d.id} />
        </TabsContent>
        <TabsContent value="config">
          <ConfigTab d={d} />
        </TabsContent>
        <TabsContent value="commands">
          <CommandsTab d={d} spec={spec.data} specLoading={spec.isPending && !!d.codecId} />
        </TabsContent>
        <TabsContent value="firmware">
          <FirmwareTab d={d} />
        </TabsContent>
        <TabsContent value="sim">
          <SimTab d={d} />
        </TabsContent>
        <TabsContent value="asset">
          <AssetTab d={d} />
        </TabsContent>
        <TabsContent value="credentials">
          <CredentialsTab d={d} />
        </TabsContent>
        <TabsContent value="audit">
          <AuditTab id={d.id} />
        </TabsContent>
      </Tabs>
      <BulkFlow op={lcOpen ? "lifecycle" : null} deviceIds={[d.id]} open={lcOpen} onOpenChange={setLcOpen} />
    </>
  );
}

function DeviceSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 pb-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-4 w-48" />
        <div className="flex gap-8">
          <Skeleton className="h-10 w-28" />
          <Skeleton className="h-10 w-24" />
          <Skeleton className="h-10 w-24" />
        </div>
      </div>
      <Skeleton className="h-11 w-full" />
      <div className="grid gap-6 lg:grid-cols-3">
        <Skeleton className="h-72 rounded-panel lg:col-span-2" />
        <Skeleton className="h-72 rounded-panel" />
      </div>
    </div>
  );
}
