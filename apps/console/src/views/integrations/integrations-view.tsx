"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Cable, ClipboardList, HardHat, Plus, Radio, Send, SignalHigh, Users, Webhook, Workflow, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import type { Integration, IntegrationKind } from "@hash8/sdk-ts";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty } from "@/components/ui/empty";
import { Field, FieldHint, Input, Label, NativeSelect } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { errorMessage, useAutomations, useIntegrations, useSaveIntegration, useTestIntegration } from "@/lib/api";
import { cn, fmt } from "@/lib/utils";

const PRODUCTS: { kind: IntegrationKind; title: string; description: string; icon: LucideIcon; events: string[] }[] = [
  { kind: "hash8-crm", title: "#8 IoT CRM & Billing", description: "Customer accounts, contracts and usage-based billing from device activity.", icon: Users, events: ["device.lifecycle", "device.activated"] },
  { kind: "hash8-ticketing", title: "#8 Notifications & Ticketing", description: "Open tickets and notify on-call teams from alerts.", icon: ClipboardList, events: ["alert.*"] },
  { kind: "hash8-installation", title: "#8 Installation App", description: "Technician jobs for install, swap and maintenance, synced both ways.", icon: HardHat, events: ["device.lifecycle", "asset.association"] },
  { kind: "hash8-sim", title: "#8 SIM Management", description: "SIM activation, suspension and data usage for every device.", icon: SignalHigh, events: ["device.lifecycle", "sim.*"] },
];

const OTHER: { kind: IntegrationKind; label: string; icon: LucideIcon }[] = [
  { kind: "webhook", label: "Webhook", icon: Webhook },
  { kind: "mqtt-bridge", label: "MQTT bridge", icon: Radio },
  { kind: "kafka", label: "Kafka", icon: Cable },
];

export function IntegrationsView() {
  const integrations = useIntegrations();
  const automations = useAutomations();
  const [creating, setCreating] = React.useState<IntegrationKind | null>(null);
  const byKind = new Map<IntegrationKind, Integration[]>();
  for (const i of integrations.data ?? []) byKind.set(i.kind, [...(byKind.get(i.kind) ?? []), i]);
  const others = (integrations.data ?? []).filter((i) => !i.kind.startsWith("hash8-"));
  const auto = automations.data ?? [];

  return (
    <>
      <PageHeader
        title="Integrations & automation"
        description="Connect the rest of the #8 suite and your own systems. Decoded telemetry and lifecycle events flow out; jobs and SIM changes flow back."
        actions={
          <Button variant="primary" onClick={() => setCreating("webhook")}>
            <Plus />
            Add integration
          </Button>
        }
      />
      {integrations.error && !integrations.data ? (
        <Panel>
          <ApiError error={integrations.error} onRetry={() => void integrations.refetch()} />
        </Panel>
      ) : (
        <div className="flex flex-col gap-6">
          <section aria-labelledby="suite">
            <h2 id="suite" className="mb-3 text-sm font-medium text-muted">
              #8 suite
            </h2>
            <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
              {PRODUCTS.map((p) => {
                const inst = byKind.get(p.kind)?.[0];
                return (
                  <li key={p.kind}>
                    {integrations.isPending ? (
                      <Skeleton className="h-56 rounded-panel" />
                    ) : (
                      <ProductCard product={p} integration={inst} onConnect={() => setCreating(p.kind)} />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Panel className="overflow-hidden">
              <PanelHeader>
                <div>
                  <PanelTitle>Webhooks and data bridges</PanelTitle>
                  <PanelDescription>Signed HTTP callbacks, MQTT and Kafka</PanelDescription>
                </div>
              </PanelHeader>
              {integrations.isPending ? (
                <div className="flex flex-col gap-2 px-7 pb-7">
                  <Skeleton className="h-16" />
                  <Skeleton className="h-16" />
                </div>
              ) : others.length === 0 ? (
                <Empty icon={Webhook} title="No webhooks or bridges">
                  Stream decoded messages to your backend, a broker or a Kafka topic.
                </Empty>
              ) : (
                <ul className="flex flex-col border-t border-line">
                  {others.map((i) => (
                    <IntegrationRow key={i.id} i={i} />
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2 border-t border-line px-6 py-4 sm:px-7">
                {OTHER.map((o) => {
                  const Icon = o.icon;
                  return (
                    <Button key={o.kind} size="sm" variant="ghost" onClick={() => setCreating(o.kind)}>
                      <Icon />
                      Add {o.label.toLowerCase()}
                    </Button>
                  );
                })}
              </div>
            </Panel>
            <Panel className="h-fit">
              <PanelHeader>
                <div>
                  <PanelTitle>Automations</PanelTitle>
                  <PanelDescription>
                    {automations.data ? `${auto.filter((a) => a.enabled).length} of ${auto.length} enabled` : "Rules that act on events"}
                  </PanelDescription>
                </div>
                <Button size="sm" variant="secondary" asChild>
                  <Link href="/automations">
                    Open builder
                    <ArrowUpRight />
                  </Link>
                </Button>
              </PanelHeader>
              <ul className="flex flex-col px-3 pb-3">
                {automations.isPending ? (
                  <Skeleton className="m-3 h-24" />
                ) : auto.length === 0 ? (
                  <Empty icon={Workflow} title="No automations" className="py-8" />
                ) : (
                  auto.slice(0, 6).map((a) => (
                    <li key={a.id}>
                      <Link href={`/automations?id=${a.id}`} className="focus-ring flex items-center gap-3 rounded-[14px] px-3 py-2.5 hover:bg-hover">
                        <span className={cn("size-2 rounded-full", a.enabled ? "bg-ion" : "bg-subtle")} />
                        <span className="min-w-0 flex-1 truncate text-sm">{a.name}</span>
                        <span className="text-xs text-subtle tabular">{fmt.number(a.stats.runs)} runs</span>
                      </Link>
                    </li>
                  ))
                )}
              </ul>
            </Panel>
          </div>
        </div>
      )}
      <CreateDialog kind={creating} onClose={() => setCreating(null)} />
    </>
  );
}

function ProductCard({
  product,
  integration,
  onConnect,
}: {
  product: (typeof PRODUCTS)[number];
  integration?: Integration;
  onConnect: () => void;
}) {
  const Icon = product.icon;
  const save = useSaveIntegration();
  const test = useTestIntegration();
  return (
    <div className="flex h-full flex-col gap-4 rounded-panel border border-line bg-panel p-6">
      <div className="flex items-start justify-between">
        <span className="flex size-11 items-center justify-center rounded-[14px] bg-raised ring-1 ring-line ring-inset">
          <Icon className="size-5" strokeWidth={1.6} />
        </span>
        {integration ? (
          <Switch
            checked={integration.enabled}
            aria-label={`${integration.enabled ? "Disable" : "Enable"} ${product.title}`}
            onCheckedChange={(v) => save.mutate({ id: integration.id, body: { enabled: v } }, { onError: (e) => toast.error("Couldn’t update", { description: errorMessage(e) }) })}
          />
        ) : null}
      </div>
      <div>
        <p className="text-[15px] font-semibold tracking-[-0.015em]">{product.title}</p>
        <p className="mt-1 text-[13px] text-muted">{product.description}</p>
      </div>
      <div className="mt-auto">
        {integration ? (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-subtle tabular">
              {fmt.compact(integration.stats.delivered)} delivered
              {integration.stats.failed ? <span className="text-danger">, {fmt.number(integration.stats.failed)} failed</span> : null}
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={test.isPending}
              onClick={() =>
                test.mutate(integration.id, {
                  onSuccess: () => toast.success("Test delivered"),
                  onError: (e) => toast.error("Test failed", { description: errorMessage(e) }),
                })
              }
            >
              {test.isPending ? <Spinner /> : <Send />}
              Test
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="primary" onClick={onConnect}>
            Connect
          </Button>
        )}
      </div>
    </div>
  );
}

function IntegrationRow({ i }: { i: Integration }) {
  const save = useSaveIntegration();
  const test = useTestIntegration();
  const Icon = OTHER.find((o) => o.kind === i.kind)?.icon ?? Webhook;
  const url = typeof i.config.url === "string" ? i.config.url : typeof i.config.topic === "string" ? i.config.topic : undefined;
  return (
    <li className="flex flex-wrap items-center gap-4 border-b border-line px-6 py-4 last:border-0 sm:px-7">
      <Switch
        checked={i.enabled}
        aria-label={`${i.enabled ? "Disable" : "Enable"} ${i.name}`}
        onCheckedChange={(v) => save.mutate({ id: i.id, body: { enabled: v } }, { onError: (e) => toast.error("Couldn’t update", { description: errorMessage(e) }) })}
      />
      <Icon className="size-4 text-subtle" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{i.name}</p>
        <p className="truncate font-mono text-xs text-subtle">{url ?? i.kind}</p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {i.events.slice(0, 4).map((e) => (
            <Badge key={e} className="font-mono text-[11px]">
              {e}
            </Badge>
          ))}
        </div>
      </div>
      <div className="text-right text-xs text-subtle tabular">
        <p>
          {fmt.compact(i.stats.delivered)} delivered{i.stats.failed ? <span className="text-danger">, {fmt.number(i.stats.failed)} failed</span> : null}
        </p>
        <p>{i.stats.lastDeliveryAt ? `Last ${fmt.ago(i.stats.lastDeliveryAt)}` : "No deliveries yet"}</p>
      </div>
      <Button
        size="sm"
        variant="secondary"
        disabled={test.isPending}
        onClick={() =>
          test.mutate(i.id, {
            onSuccess: () => toast.success("Test delivered"),
            onError: (e) => toast.error("Test delivery failed", { description: errorMessage(e) }),
          })
        }
      >
        {test.isPending ? <Spinner /> : <Send />}
        Test delivery
      </Button>
    </li>
  );
}

function CreateDialog({ kind, onClose }: { kind: IntegrationKind | null; onClose: () => void }) {
  const save = useSaveIntegration();
  const [k, setK] = React.useState<IntegrationKind>("webhook");
  const [name, setName] = React.useState("");
  const [target, setTarget] = React.useState("");
  const [events, setEvents] = React.useState("message.decoded, alert.*");
  React.useEffect(() => {
    if (!kind) return;
    setK(kind);
    const p = PRODUCTS.find((x) => x.kind === kind);
    setName(p?.title ?? "");
    setEvents(p ? p.events.join(", ") : "message.decoded, alert.*");
    setTarget("");
  }, [kind]);
  const targetLabel = k === "kafka" ? "Topic" : k === "mqtt-bridge" ? "Broker URL" : k.startsWith("hash8-") ? "Workspace URL (optional)" : "Endpoint URL";
  return (
    <Dialog open={!!kind} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add integration</DialogTitle>
          <DialogDescription>Deliveries are signed and retried with backoff.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const config: Record<string, unknown> = {};
            if (target) config[k === "kafka" ? "topic" : "url"] = target;
            save.mutate(
              {
                body: {
                  kind: k,
                  name,
                  enabled: true,
                  events: events.split(",").map((x) => x.trim()).filter(Boolean),
                  config,
                },
              },
              {
                onSuccess: () => {
                  toast.success(`${name} connected`);
                  onClose();
                },
                onError: (err) => toast.error("Couldn’t add integration", { description: errorMessage(err) }),
              },
            );
          }}
        >
          <DialogBody>
            <Field>
              <Label htmlFor="in-kind">Type</Label>
              <NativeSelect id="in-kind" value={k} onChange={(e) => setK(e.target.value as IntegrationKind)}>
                {PRODUCTS.map((p) => (
                  <option key={p.kind} value={p.kind}>
                    {p.title}
                  </option>
                ))}
                {OTHER.map((o) => (
                  <option key={o.kind} value={o.kind}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <Label htmlFor="in-name">Name</Label>
              <Input id="in-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <Field>
              <Label htmlFor="in-target">{targetLabel}</Label>
              <Input id="in-target" value={target} onChange={(e) => setTarget(e.target.value)} className="font-mono text-[13px]" required={!k.startsWith("hash8-")} />
            </Field>
            <Field>
              <Label htmlFor="in-events">Events</Label>
              <Input id="in-events" value={events} onChange={(e) => setEvents(e.target.value)} className="font-mono text-[13px]" />
              <FieldHint>Comma separated. Wildcards allowed, e.g. ota.*</FieldHint>
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name || save.isPending}>
              {save.isPending ? <Spinner /> : null}
              Add integration
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
