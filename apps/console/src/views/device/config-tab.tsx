"use client";

import * as React from "react";
import { Check, FileCog, Pencil } from "lucide-react";
import { toast } from "sonner";
import type { Device } from "@hash8/sdk-ts";
import { ApiError } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Callout, Empty } from "@/components/ui/empty";
import { Field, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { errorMessage, useConfigTemplates, useDeviceConfig, usePutConfig } from "@/lib/api";
import { cn, fmt, formatValue } from "@/lib/utils";

export function ConfigTab({ d }: { d: Device }) {
  const cfg = useDeviceConfig(d.id);
  const templates = useConfigTemplates();
  const put = usePutConfig(d.id);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [templateId, setTemplateId] = React.useState("");

  if (cfg.isPending) return <Skeleton className="h-80 rounded-panel" />;
  if (cfg.error || !cfg.data)
    return (
      <Panel>
        <ApiError error={cfg.error} onRetry={() => void cfg.refetch()} />
      </Panel>
    );
  const c = cfg.data;
  const keys = [...new Set([...Object.keys(c.desired ?? {}), ...Object.keys(c.reported ?? {})])].sort();
  const drift = new Set(c.drift ?? []);
  const forModel = (templates.data ?? []).filter((t) => t.modelId === d.modelId);

  let parsed: Record<string, unknown> | null = null;
  if (editing) {
    try {
      const v = JSON.parse(draft) as unknown;
      parsed = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      parsed = null;
    }
  }

  const save = (desired: Record<string, unknown>, tid?: string) =>
    put.mutate(
      { desired, ...(tid ? { templateId: tid } : {}) },
      {
        onSuccess: () => {
          toast.success(tid ? "Template applied" : "Desired config saved", { description: "The device picks it up on its next check-in." });
          setEditing(false);
        },
        onError: (e) => toast.error("Couldn’t save config", { description: errorMessage(e) }),
      },
    );

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Panel className="min-w-0 overflow-hidden">
        <PanelHeader>
          <div>
            <PanelTitle className="flex items-center gap-2">
              Desired vs reported
              {drift.size ? <Badge tone="ember">{drift.size} drifted</Badge> : <Badge tone="ion">In sync</Badge>}
            </PanelTitle>
            <PanelDescription>Updated {fmt.ago(c.updatedAt)}</PanelDescription>
          </div>
          {!editing ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setDraft(JSON.stringify(c.desired ?? {}, null, 2));
                setEditing(true);
              }}
            >
              <Pencil />
              Edit desired
            </Button>
          ) : null}
        </PanelHeader>
        {editing ? (
          <PanelBody className="flex flex-col gap-3">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-72 font-mono text-[13px]"
              aria-label="Desired configuration JSON"
              aria-invalid={!parsed}
              spellCheck={false}
            />
            {!parsed ? <p className="text-xs text-danger">Enter a valid JSON object.</p> : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!parsed || put.isPending} onClick={() => parsed && save(parsed)}>
                {put.isPending ? <Spinner /> : <Check />}
                Save desired
              </Button>
            </div>
          </PanelBody>
        ) : keys.length === 0 ? (
          <Empty icon={FileCog} title="No configuration">
            Set desired values or apply a template to manage this device’s settings.
          </Empty>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Key</TH>
                <TH>Desired</TH>
                <TH>Reported</TH>
                <TH className="text-right">State</TH>
              </TR>
            </THead>
            <TBody>
              {keys.map((k) => {
                const isDrift = drift.has(k);
                return (
                  <TR key={k} className={cn(isDrift && "bg-ember/[0.04]")}>
                    <TD className="font-mono text-[13px]">{k}</TD>
                    <TD className="font-mono text-[13px]">{formatValue(c.desired?.[k])}</TD>
                    <TD className={cn("font-mono text-[13px]", isDrift ? "text-ember" : "text-muted")}>{formatValue(c.reported?.[k])}</TD>
                    <TD className="text-right">{isDrift ? <Badge tone="ember">Drift</Badge> : <span className="text-xs text-subtle">Synced</span>}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Panel>
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Templates</PanelTitle>
            <PanelDescription>Reusable settings for this model</PanelDescription>
          </div>
        </PanelHeader>
        <PanelBody className="flex flex-col gap-4">
          {c.templateId ? (
            <Callout tone="signal" title="Template in use">
              {(templates.data ?? []).find((t) => t.id === c.templateId)?.name ?? c.templateId}
            </Callout>
          ) : null}
          <Field>
            <Label htmlFor="tpl">Apply template</Label>
            <NativeSelect id="tpl" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">{templates.isPending ? "Loading…" : forModel.length ? "Choose…" : "No templates for this model"}</option>
              {forModel.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} v{t.version}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {templateId ? (
            <pre className="scrollbar-quiet max-h-48 overflow-auto rounded-control bg-sunken/60 p-3 font-mono text-xs text-muted ring-1 ring-line ring-inset">
              {JSON.stringify(forModel.find((t) => t.id === templateId)?.values ?? {}, null, 2)}
            </pre>
          ) : null}
          <Button
            variant="primary"
            disabled={!templateId || put.isPending}
            onClick={() => {
              const t = forModel.find((x) => x.id === templateId);
              if (t) save({ ...(c.desired ?? {}), ...t.values }, t.id);
            }}
          >
            Apply template
          </Button>
        </PanelBody>
      </Panel>
    </div>
  );
}
