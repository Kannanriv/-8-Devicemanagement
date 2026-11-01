"use client";

import * as React from "react";
import { FlaskConical, Plus, Save, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import type { Automation, AutomationAction, LifecycleState, Severity } from "@hash8/sdk-ts";
import { LIFECYCLE_LABELS } from "@hash8/sdk-ts";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { JsonView } from "@/components/hex-inspector";
import { LIFECYCLE_ORDER } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Card, Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Field, FieldHint, Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { errorMessage, useAutomations, useCodecs, useDevices, useDryRun, useIntegrations, useSaveAutomation, type AutomationDraft } from "@/lib/api";
import { cn, fmt } from "@/lib/utils";

type Trigger = Automation["trigger"];
const EMPTY: AutomationDraft = {
  name: "",
  enabled: true,
  trigger: { type: "message" },
  condition: "",
  actions: [{ type: "alert", severity: "warning", title: "" }],
};

const CONDITION_EXAMPLES = ["data.temperature > 30", "device.health.battery < 15", "data.alarm == true && device.lifecycle == 'activated'"];

export function AutomationsView() {
  const autos = useAutomations();
  const [selected, setSelected] = React.useState<string | "new" | null>(null);

  React.useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("id")) setSelected(p.get("id"));
    else if (p.get("new")) setSelected("new");
  }, []);

  const list = autos.data ?? [];
  const current = selected === "new" ? undefined : list.find((a) => a.id === selected);
  React.useEffect(() => {
    if (selected === null && list[0]) setSelected(list[0].id);
  }, [selected, list]);

  return (
    <>
      <PageHeader
        back={{ href: "/integrations", label: "Integrations & automation" }}
        title="Automations"
        description="When something happens and a condition holds, act: alert, command, webhook, lifecycle or tag. Test against a real device before enabling."
        actions={
          <Button variant="primary" onClick={() => setSelected("new")}>
            <Plus />
            New automation
          </Button>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
        <Panel className="h-fit overflow-hidden">
          <PanelHeader className="pb-2">
            <PanelTitle>Rules</PanelTitle>
          </PanelHeader>
          {autos.isPending ? (
            <div className="flex flex-col gap-2 px-6 pb-6">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : autos.error ? (
            <ApiError error={autos.error} onRetry={() => void autos.refetch()} />
          ) : list.length === 0 ? (
            <Empty icon={Workflow} title="No automations" className="py-10">
              Create one to react to telemetry automatically.
            </Empty>
          ) : (
            <ul className="flex flex-col gap-0.5 px-3 pb-3">
              {list.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(a.id)}
                    className={cn(
                      "focus-ring flex w-full cursor-pointer items-center gap-3 rounded-[14px] px-3 py-2.5 text-left transition-colors",
                      selected === a.id ? "bg-raised ring-1 ring-line ring-inset" : "hover:bg-hover",
                    )}
                  >
                    <span className={cn("size-2 shrink-0 rounded-full", a.enabled ? "bg-ion" : "bg-subtle")} aria-label={a.enabled ? "Enabled" : "Disabled"} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{a.name}</span>
                      <span className="block truncate text-xs text-subtle">
                        {fmt.label(a.trigger.type)}, {fmt.number(a.stats.runs)} runs
                        {a.stats.failures ? `, ${a.stats.failures} failed` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {selected ? <Builder key={selected} automation={current} onSaved={(id) => setSelected(id)} /> : <div />}
      </div>
    </>
  );
}

function Builder({ automation, onSaved }: { automation?: Automation; onSaved: (id: string) => void }) {
  const [draft, setDraft] = React.useState<AutomationDraft>(() =>
    automation
      ? { name: automation.name, enabled: automation.enabled, trigger: automation.trigger, condition: automation.condition ?? "", actions: automation.actions }
      : EMPTY,
  );
  const save = useSaveAutomation();
  const set = <K extends keyof AutomationDraft>(k: K, v: AutomationDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setAction = (i: number, a: AutomationAction) => set("actions", draft.actions.map((x, j) => (j === i ? a : x)));

  const submit = () =>
    save.mutate(
      { id: automation?.id, draft: { ...draft, condition: draft.condition?.trim() || undefined } },
      {
        onSuccess: (a) => {
          toast.success(automation ? "Automation saved" : "Automation created");
          onSaved(a.id);
        },
        onError: (e) => toast.error("Couldn’t save", { description: errorMessage(e) }),
      },
    );

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Panel>
        <PanelHeader>
          <div className="min-w-0 flex-1">
            <PanelTitle>{automation ? "Edit automation" : "New automation"}</PanelTitle>
            <PanelDescription>{automation ? `Created ${fmt.ago(automation.createdAt)}` : "Trigger, condition, actions"}</PanelDescription>
          </div>
          <label className="flex items-center gap-2.5 text-sm text-muted">
            Enabled
            <Switch checked={draft.enabled} onCheckedChange={(v) => set("enabled", v)} />
          </label>
        </PanelHeader>
        <PanelBody className="flex flex-col gap-6">
          <Field>
            <Label htmlFor="au-name">Name</Label>
            <Input id="au-name" value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Cold room too warm" />
          </Field>

          <Step n={1} title="When">
            <TriggerEditor trigger={draft.trigger} onChange={(t) => set("trigger", t)} />
          </Step>
          <Step n={2} title="Only if">
            <Field>
              <Textarea
                aria-label="Condition expression"
                value={draft.condition ?? ""}
                onChange={(e) => set("condition", e.target.value)}
                placeholder="Leave empty to always act"
                className="min-h-16 font-mono text-[13px]"
                spellCheck={false}
              />
              <div className="flex flex-wrap gap-1.5">
                {CONDITION_EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => set("condition", ex)}
                    className="focus-ring cursor-pointer rounded-full px-2.5 py-1 font-mono text-[11.5px] text-muted ring-1 ring-line ring-inset hover:bg-hover hover:text-fg"
                  >
                    {ex}
                  </button>
                ))}
              </div>
              <FieldHint>A safe expression over data (decoded message) and device.</FieldHint>
            </Field>
          </Step>
          <Step n={3} title="Then">
            <div className="flex flex-col gap-3">
              {draft.actions.map((a, i) => (
                <Card key={i} className="flex flex-col gap-3 p-4">
                  <div className="flex items-center gap-2">
                    <NativeSelect
                      aria-label="Action type"
                      value={a.type}
                      onChange={(e) => setAction(i, defaultAction(e.target.value as AutomationAction["type"]))}
                      className="w-48"
                    >
                      <option value="alert">Raise alert</option>
                      <option value="command">Send command</option>
                      <option value="webhook">Call integration</option>
                      <option value="lifecycle">Change lifecycle</option>
                      <option value="tag">Tag device</option>
                    </NativeSelect>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="ml-auto"
                      aria-label="Remove action"
                      disabled={draft.actions.length === 1}
                      onClick={() => set("actions", draft.actions.filter((_, j) => j !== i))}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <ActionEditor action={a} onChange={(x) => setAction(i, x)} />
                </Card>
              ))}
              <Button size="sm" variant="ghost" className="self-start" onClick={() => set("actions", [...draft.actions, defaultAction("alert")])}>
                <Plus />
                Add action
              </Button>
            </div>
          </Step>
          <div className="flex justify-end">
            <Button variant="primary" disabled={!draft.name.trim() || save.isPending} onClick={submit}>
              {save.isPending ? <Spinner /> : <Save />}
              {automation ? "Save changes" : "Create automation"}
            </Button>
          </div>
        </PanelBody>
      </Panel>
      {automation ? <DryRun id={automation.id} /> : null}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 sm:grid-cols-[120px_minmax(0,1fr)]">
      <h3 className="flex items-center gap-2 text-sm font-medium sm:pt-2.5">
        <span className="flex size-5 items-center justify-center rounded-full bg-hover text-[11px] text-muted tabular ring-1 ring-line ring-inset">{n}</span>
        {title}
      </h3>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function TriggerEditor({ trigger, onChange }: { trigger: Trigger; onChange: (t: Trigger) => void }) {
  const codecs = useCodecs();
  const ids = [...new Set((codecs.data ?? []).map((c) => c.codecId))];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <NativeSelect
        aria-label="Trigger"
        value={trigger.type}
        onChange={(e) => {
          const t = e.target.value as Trigger["type"];
          onChange(
            t === "message"
              ? { type: "message" }
              : t === "lifecycle"
                ? { type: "lifecycle", to: "activated" }
                : t === "offline"
                  ? { type: "offline", minutes: 60 }
                  : { type: "schedule", cron: "0 * * * *" },
          );
        }}
      >
        <option value="message">A message is decoded</option>
        <option value="lifecycle">Lifecycle changes</option>
        <option value="offline">A device goes silent</option>
        <option value="schedule">On a schedule</option>
      </NativeSelect>
      {trigger.type === "message" ? (
        <div className="grid grid-cols-2 gap-2">
          <NativeSelect aria-label="Codec" value={trigger.codecId ?? ""} onChange={(e) => onChange({ ...trigger, codecId: e.target.value || undefined })}>
            <option value="">Any codec</option>
            {ids.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </NativeSelect>
          <Input aria-label="Message name" placeholder="Any message" value={trigger.message ?? ""} onChange={(e) => onChange({ ...trigger, message: e.target.value || undefined })} />
        </div>
      ) : trigger.type === "lifecycle" ? (
        <NativeSelect aria-label="To state" value={trigger.to} onChange={(e) => onChange({ type: "lifecycle", to: e.target.value as LifecycleState })}>
          {LIFECYCLE_ORDER.map((s) => (
            <option key={s} value={s}>
              Moves to {LIFECYCLE_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      ) : trigger.type === "offline" ? (
        <div className="flex items-center gap-2">
          <Input aria-label="Minutes" type="number" min={1} value={trigger.minutes} onChange={(e) => onChange({ type: "offline", minutes: Number(e.target.value) })} className="w-28" />
          <span className="text-sm text-muted">minutes without traffic</span>
        </div>
      ) : (
        <Input aria-label="Cron" className="font-mono" value={trigger.cron} onChange={(e) => onChange({ type: "schedule", cron: e.target.value })} placeholder="0 * * * *" />
      )}
    </div>
  );
}

function defaultAction(t: AutomationAction["type"]): AutomationAction {
  switch (t) {
    case "alert":
      return { type: "alert", severity: "warning", title: "" };
    case "command":
      return { type: "command", message: "", data: {} };
    case "webhook":
      return { type: "webhook", integrationId: "" };
    case "lifecycle":
      return { type: "lifecycle", to: "maintenance" };
    case "tag":
      return { type: "tag", add: [] };
  }
}

function ActionEditor({ action, onChange }: { action: AutomationAction; onChange: (a: AutomationAction) => void }) {
  const integrations = useIntegrations();
  const [raw, setRaw] = React.useState(action.type === "command" ? JSON.stringify(action.data) : "{}");
  switch (action.type) {
    case "alert":
      return (
        <div className="grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)]">
          <NativeSelect aria-label="Severity" value={action.severity} onChange={(e) => onChange({ ...action, severity: e.target.value as Severity })}>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </NativeSelect>
          <Input aria-label="Alert title" value={action.title} onChange={(e) => onChange({ ...action, title: e.target.value })} placeholder="Alert title" />
        </div>
      );
    case "command":
      return (
        <div className="grid gap-2 sm:grid-cols-[200px_minmax(0,1fr)]">
          <Input aria-label="Downlink message" value={action.message} onChange={(e) => onChange({ ...action, message: e.target.value })} placeholder="Downlink message" />
          <Input
            aria-label="Command data JSON"
            className="font-mono text-[13px]"
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              try {
                const v = JSON.parse(e.target.value) as unknown;
                if (v && typeof v === "object" && !Array.isArray(v)) onChange({ ...action, data: v as Record<string, unknown> });
              } catch {
                /* keep last valid */
              }
            }}
          />
        </div>
      );
    case "webhook":
      return (
        <NativeSelect aria-label="Integration" value={action.integrationId} onChange={(e) => onChange({ ...action, integrationId: e.target.value })}>
          <option value="">{integrations.isPending ? "Loading…" : "Choose an integration…"}</option>
          {(integrations.data ?? []).map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </NativeSelect>
      );
    case "lifecycle":
      return (
        <NativeSelect aria-label="Move to" value={action.to} onChange={(e) => onChange({ ...action, to: e.target.value as LifecycleState })}>
          {LIFECYCLE_ORDER.map((s) => (
            <option key={s} value={s}>
              Move to {LIFECYCLE_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      );
    case "tag":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <Input aria-label="Add tags" placeholder="Add tags, comma separated" value={(action.add ?? []).join(", ")} onChange={(e) => onChange({ ...action, add: splitTags(e.target.value) })} />
          <Input aria-label="Remove tags" placeholder="Remove tags" value={(action.remove ?? []).join(", ")} onChange={(e) => onChange({ ...action, remove: splitTags(e.target.value) })} />
        </div>
      );
  }
}

function splitTags(s: string) {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function DryRun({ id }: { id: string }) {
  const [q, setQ] = React.useState("");
  const [deviceId, setDeviceId] = React.useState("");
  const devices = useDevices({ q: q || undefined, limit: 8 }, { enabled: q.length >= 2 });
  const dry = useDryRun();
  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>Dry run</PanelTitle>
          <PanelDescription>Evaluate against a device’s latest data. Nothing is executed.</PanelDescription>
        </div>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a device by UDI or serial" aria-label="Find device" className="sm:max-w-sm" />
          <NativeSelect aria-label="Device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="sm:w-72">
            <option value="">{q.length < 2 ? "Type to search…" : devices.isFetching ? "Searching…" : "Choose a device…"}</option>
            {(devices.data?.items ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.udi ?? d.serial} {d.name ? `(${d.name})` : ""}
              </option>
            ))}
          </NativeSelect>
          <Button
            variant="primary"
            disabled={!deviceId || dry.isPending}
            onClick={() => dry.mutate({ id, deviceId }, { onError: (e) => toast.error("Dry run failed", { description: errorMessage(e) }) })}
          >
            {dry.isPending ? <Spinner /> : <FlaskConical />}
            Run
          </Button>
        </div>
        {dry.data ? (
          <div className="flex flex-col gap-3">
            {"matched" in dry.data || "wouldFire" in dry.data ? (
              <Badge tone={(dry.data.matched ?? dry.data.wouldFire) ? "ion" : "neutral"} className="self-start">
                {(dry.data.matched ?? dry.data.wouldFire) ? "Would fire" : "Would not fire"}
              </Badge>
            ) : null}
            <JsonView value={dry.data} className="max-h-80" />
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}
