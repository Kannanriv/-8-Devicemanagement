"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight, FileCog, Plus } from "lucide-react";
import { toast } from "sonner";
import type { ConfigTemplate } from "@hash8/sdk-ts";

import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Callout, Empty } from "@/components/ui/empty";
import { Field, Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { client, errorMessage, qk, useConfigTemplates, useInvalidateTenant, useModels, useOpsInbox } from "@/lib/api";
import { useTenant } from "@/lib/tenant";
import { cn, fmt } from "@/lib/utils";

export function ConfigurationView() {
  const templates = useConfigTemplates();
  const models = useModels();
  const inbox = useOpsInbox();
  const [selected, setSelected] = React.useState<string>();
  const [open, setOpen] = React.useState(false);
  const modelName = new Map((models.data ?? []).map((m) => [m.id, `${m.vendor} ${m.name}`]));
  const list = (templates.data ?? []).toSorted((a, b) => a.modelId.localeCompare(b.modelId) || b.version - a.version);
  const sel = list.find((t) => t.id === selected) ?? list[0];
  const drift = (inbox.data ?? []).find((i) => i.kind === "config_drift");

  return (
    <>
      <PageHeader
        title="Configuration"
        description="Versioned templates per model. Apply them to cohorts from Inventory; drift between desired and reported state is tracked per device."
        actions={
          <>
            <Button variant="secondary" asChild>
              <Link href="/inventory?drift=1">
                Devices with drift
                <ArrowUpRight />
              </Link>
            </Button>
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus />
              New template
            </Button>
          </>
        }
      />
      {drift ? (
        <Callout tone="ember" title={drift.title} className="mb-6">
          {drift.summary}{" "}
          <Link href={drift.href} className="text-fg underline underline-offset-4">
            Review
          </Link>
        </Callout>
      ) : null}
      {templates.error ? (
        <Panel>
          <ApiError error={templates.error} onRetry={() => void templates.refetch()} />
        </Panel>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
          <Panel className="h-fit overflow-hidden">
            <PanelHeader className="pb-2">
              <PanelTitle>Templates</PanelTitle>
            </PanelHeader>
            {templates.isPending ? (
              <div className="flex flex-col gap-2 px-6 pb-6">
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
              </div>
            ) : list.length === 0 ? (
              <Empty icon={FileCog} title="No templates" className="py-10">
                Create a template to standardise settings across a model.
              </Empty>
            ) : (
              <ul className="flex flex-col gap-0.5 px-3 pb-3">
                {list.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(t.id)}
                      className={cn(
                        "focus-ring flex w-full cursor-pointer items-center gap-3 rounded-[14px] px-3 py-2.5 text-left",
                        sel?.id === t.id ? "bg-raised ring-1 ring-line ring-inset" : "hover:bg-hover",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{t.name}</span>
                        <span className="block truncate text-xs text-subtle">{modelName.get(t.modelId) ?? t.modelId}</span>
                      </span>
                      <Badge>v{t.version}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {sel ? <TemplateDetail t={sel} model={modelName.get(sel.modelId)} /> : <div />}
        </div>
      )}
      <CreateTemplate open={open} onOpenChange={setOpen} onCreated={setSelected} />
    </>
  );
}

function TemplateDetail({ t, model }: { t: ConfigTemplate; model?: string }) {
  return (
    <Panel className="min-w-0">
      <PanelHeader>
        <div>
          <PanelTitle>
            {t.name} <span className="font-normal text-subtle">v{t.version}</span>
          </PanelTitle>
          <PanelDescription>
            {model ?? t.modelId}, created {fmt.ago(t.createdAt)}
          </PanelDescription>
        </div>
        <Button size="sm" variant="secondary" asChild>
          <Link href={`/inventory?modelId=${encodeURIComponent(t.modelId)}`}>
            Apply to devices
            <ArrowUpRight />
          </Link>
        </Button>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-4">
        <dl className="grid gap-px overflow-hidden rounded-card bg-line ring-1 ring-line sm:grid-cols-2">
          {Object.entries(t.values).map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-4 bg-panel px-4 py-3">
              <dt className="font-mono text-[12.5px] text-muted">{k}</dt>
              <dd className="font-mono text-[13px]">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-subtle">Select devices in Inventory, then choose Apply config. Ineligible devices (other models) are listed before anything changes.</p>
      </PanelBody>
    </Panel>
  );
}

function CreateTemplate({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (id: string) => void }) {
  const models = useModels();
  const t = useTenant();
  const inv = useInvalidateTenant();
  const [name, setName] = React.useState("");
  const [modelId, setModelId] = React.useState("");
  const [raw, setRaw] = React.useState('{\n  "reportIntervalSec": 300\n}');
  const create = useMutation({
    mutationFn: (body: { name: string; modelId: string; values: Record<string, unknown> }) => client(t).post<ConfigTemplate>("/config-templates", body),
    onSuccess: () => inv(qk.templates(t)),
  });
  let values: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(raw) as unknown;
    values = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    values = null;
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New configuration template</DialogTitle>
          <DialogDescription>Saving a template with an existing name creates a new version.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field>
            <Label htmlFor="ct-name">Name</Label>
            <Input id="ct-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Standard reporting" />
          </Field>
          <Field>
            <Label htmlFor="ct-model">Model</Label>
            <NativeSelect id="ct-model" value={modelId} onChange={(e) => setModelId(e.target.value)}>
              <option value="">Choose a model…</option>
              {(models.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.vendor} {m.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <Label htmlFor="ct-values">Values (JSON)</Label>
            <Textarea id="ct-values" value={raw} onChange={(e) => setRaw(e.target.value)} className="min-h-40 font-mono text-[13px]" aria-invalid={!values} spellCheck={false} />
          </Field>

        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name || !modelId || !values || create.isPending}
            onClick={() =>
              values &&
              create.mutate(
                { name, modelId, values },
                {
                  onSuccess: (tpl) => {
                    toast.success("Template saved");
                    onOpenChange(false);
                    onCreated(tpl.id);
                  },
                  onError: (e) => toast.error("Couldn’t save template", { description: errorMessage(e) }),
                },
              )
            }
          >
            {create.isPending ? <Spinner /> : null}
            Save template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
