"use client";

import * as React from "react";
import Link from "next/link";
import { BellOff, Check, CheckCheck, Plus, Workflow } from "lucide-react";
import { toast } from "sonner";
import type { Alert, Severity } from "@hash8/sdk-ts";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { SeverityBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Panel } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { Field, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorMessage, useSaveAutomation } from "@/lib/api";
import { useAlertRules, useAlertsFiltered, useResolveAlert } from "@/lib/api-v11";
import { cn, fmt } from "@/lib/utils";
import { ActorLabel } from "@/views/audit/audit-table";

export const ALERT_CATEGORY: Record<Alert["category"], string> = {
  device_failure: "Device failure",
  abnormal_telemetry: "Abnormal telemetry",
  communication_loss: "Communication loss",
  security: "Security",
  ota: "OTA",
  other: "Other",
};

export function AlertsView() {
  return (
    <>
      <PageHeader title="Incidents & alerts" description="What broke, who is on it, and how it was resolved." />
      <Tabs defaultValue="alerts">
        <TabsList aria-label="Alerts sections">
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="rules">Alert rules</TabsTrigger>
        </TabsList>
        <TabsContent value="alerts">
          <AlertList />
        </TabsContent>
        <TabsContent value="rules">
          <RuleList />
        </TabsContent>
      </Tabs>
    </>
  );
}

function AlertList() {
  const [status, setStatus] = React.useState<"open" | "acknowledged" | "resolved" | "all">("open");
  const [severity, setSeverity] = React.useState<Severity | "">("");
  const [category, setCategory] = React.useState("");
  const alerts = useAlertsFiltered({
    status: status === "all" ? undefined : status,
    severity: severity || undefined,
    category: category || undefined,
  });
  const act = useResolveAlert();
  const [resolving, setResolving] = React.useState<Alert | null>(null);
  const sevRank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  const list = (alerts.data ?? []).toSorted((a, b) => sevRank[a.severity] - sevRank[b.severity] || b.createdAt.localeCompare(a.createdAt));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Status"
          value={status}
          onValueChange={setStatus}
          options={[
            { value: "open", label: "Open" },
            { value: "acknowledged", label: "Acknowledged" },
            { value: "resolved", label: "Resolved" },
            { value: "all", label: "All" },
          ]}
        />
        <NativeSelect aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value as Severity | "")} className="w-40">
          <option value="">Any severity</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
          <option value="info">Info</option>
        </NativeSelect>
        <NativeSelect aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className="w-52">
          <option value="">Any category</option>
          {Object.entries(ALERT_CATEGORY).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </NativeSelect>
      </div>
      <Panel className="overflow-hidden">
        {alerts.isPending ? (
          <div className="flex flex-col gap-2 p-7">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : alerts.error && !alerts.data ? (
          <ApiError error={alerts.error} onRetry={() => void alerts.refetch()} />
        ) : list.length === 0 ? (
          <Empty icon={BellOff} title={status === "open" ? "No open alerts" : "Nothing here"}>
            {status === "open" ? "Everything is quiet. New incidents appear here the moment a rule fires." : "Try another status or category."}
          </Empty>
        ) : (
          <ul className={cn("flex flex-col", alerts.isFetching && "opacity-75")}>
            {list.map((a) => (
              <li key={a.id} className="flex flex-col gap-3 border-b border-line px-6 py-4 last:border-0 sm:flex-row sm:items-center sm:px-7">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={a.severity} />
                    <p className="text-sm font-medium">{a.title}</p>
                    <Badge>{ALERT_CATEGORY[a.category] ?? fmt.label(a.category ?? "other")}</Badge>
                  </div>
                  {a.detail ? <p className="mt-1 text-[13px] text-muted">{a.detail}</p> : null}
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
                    {a.deviceId ? (
                      <Link href={`/devices/${a.deviceId}`} className="focus-ring rounded font-mono text-muted hover:text-fg hover:underline">
                        {a.deviceId}
                      </Link>
                    ) : null}
                    {a.assetId ? (
                      <Link href={`/assets/${a.assetId}`} className="focus-ring rounded text-muted hover:text-fg hover:underline">
                        Asset {a.assetId}
                      </Link>
                    ) : null}
                    <span>From {a.source}</span>
                    <span>{fmt.ago(a.createdAt)}</span>
                    {a.acknowledgedBy ? <span>Acknowledged by {a.acknowledgedBy.replace(/^user:/, "")}</span> : null}
                  </p>
                  {a.status === "resolved" ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted">
                      <CheckCheck className="size-3.5 text-ion" />
                      {a.resolution ?? "Resolved"}
                      {a.resolvedBy ? <ActorLabel actor={a.resolvedBy} /> : null}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  {a.status === "open" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={act.isPending}
                      onClick={() =>
                        act.mutate(
                          { id: a.id, action: "ack" },
                          { onSuccess: () => toast.success("Acknowledged"), onError: (e) => toast.error("Couldn’t acknowledge", { description: errorMessage(e) }) },
                        )
                      }
                    >
                      <Check />
                      Acknowledge
                    </Button>
                  ) : null}
                  {a.status !== "resolved" ? (
                    <Button size="sm" variant="primary" onClick={() => setResolving(a)}>
                      <CheckCheck />
                      Resolve
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <ResolveDialog alert={resolving} onClose={() => setResolving(null)} />
    </div>
  );
}

function ResolveDialog({ alert, onClose }: { alert: Alert | null; onClose: () => void }) {
  const [note, setNote] = React.useState("");
  const act = useResolveAlert();
  React.useEffect(() => setNote(""), [alert]);
  return (
    <Dialog open={!!alert} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve alert</DialogTitle>
          <DialogDescription>{alert?.title}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field>
            <Label htmlFor="res-note">Resolution</Label>
            <Textarea
              id="res-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What was wrong and what fixed it. Kept in the device history."
              className="min-h-24"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!note.trim() || act.isPending}
            onClick={() =>
              alert &&
              act.mutate(
                { id: alert.id, action: "resolve", resolution: note.trim() },
                {
                  onSuccess: () => {
                    toast.success("Alert resolved");
                    onClose();
                  },
                  onError: (e) => toast.error("Couldn’t resolve", { description: errorMessage(e) }),
                },
              )
            }
          >
            {act.isPending ? <Spinner /> : <CheckCheck />}
            Resolve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RuleList() {
  const rules = useAlertRules();
  const save = useSaveAutomation();
  return (
    <Panel className="overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 sm:px-7">
        <p className="text-sm text-muted">Rules are automations that raise alerts.</p>
        <Button size="sm" variant="primary" asChild>
          <Link href="/automations?new=alert">
            <Plus />
            New rule
          </Link>
        </Button>
      </div>
      {rules.isPending ? (
        <div className="flex flex-col gap-2 px-7 pb-7">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : rules.error ? (
        <ApiError error={rules.error} onRetry={() => void rules.refetch()} />
      ) : (rules.data ?? []).length === 0 ? (
        <Empty icon={Workflow} title="No alert rules">
          Create a rule to raise alerts from telemetry, lifecycle changes or silence.
        </Empty>
      ) : (
        <ul className="flex flex-col border-t border-line">
          {(rules.data ?? []).map((r) => (
            <li key={r.id} className="flex items-center gap-4 border-b border-line px-6 py-4 last:border-0 sm:px-7">
              <Switch
                checked={r.enabled}
                aria-label={`${r.enabled ? "Disable" : "Enable"} ${r.name}`}
                onCheckedChange={(v) =>
                  save.mutate(
                    { id: r.id, draft: { enabled: v } },
                    { onError: (e) => toast.error("Couldn’t update rule", { description: errorMessage(e) }), onSettled: () => void rules.refetch() },
                  )
                }
              />
              <div className="min-w-0 flex-1">
                <Link href={`/automations?id=${r.id}`} className="focus-ring rounded text-sm font-medium hover:underline">
                  {r.name}
                </Link>
                <p className="truncate font-mono text-xs text-subtle">{r.condition ?? fmt.label(r.trigger.type)}</p>
              </div>
              <div className="hidden text-right text-xs text-subtle sm:block">
                <p className="tabular">{fmt.number(r.stats.runs)} runs</p>
                <p>{r.stats.lastRunAt ? `Last ${fmt.ago(r.stats.lastRunAt)}` : "Never fired"}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
