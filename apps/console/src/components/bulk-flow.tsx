"use client";

import * as React from "react";
import { CheckCircle2, Download, Lock, ShieldAlert, XCircle } from "lucide-react";
import type { BulkJob, BulkOp, BulkPreview, DeviceQuery, LifecycleState } from "@hash8/sdk-ts";
import { LIFECYCLE_LABELS } from "@hash8/sdk-ts";
import { Button, Spinner } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldHint, Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Callout } from "@/components/ui/empty";
import { LIFECYCLE_ORDER } from "@/components/status";
import { errorMessage, useConfigTemplates, useFirmware, useTenants } from "@/lib/api";
import { useAssets, useBulkJob, useBulkPreview, useBulkRun } from "@/lib/api-v11";
import { cn, fmt } from "@/lib/utils";

export const BULK_META: Partial<Record<BulkOp, { title: string; verb: string; critical: boolean; description: string }>> = {
  assign: { title: "Assign to asset", verb: "Assign", critical: false, description: "Link devices to an asset. Devices already on another asset are reassigned." },
  apply_config: { title: "Apply configuration", verb: "Apply", critical: true, description: "Push a configuration template as the desired state." },
  start_ota: { title: "Start OTA campaign", verb: "Start rollout", critical: true, description: "Create a staged firmware rollout for the eligible devices." },
  suspend: { title: "Suspend devices", verb: "Suspend", critical: true, description: "Pause service. Telemetry is still received; commands and billing stop." },
  reactivate: { title: "Reactivate devices", verb: "Reactivate", critical: true, description: "Return suspended devices to Activated." },
  diagnostics: { title: "Run diagnostics", verb: "Run diagnostics", critical: false, description: "Request a self-test and fresh status report from each device." },
  lifecycle: { title: "Change lifecycle", verb: "Change lifecycle", critical: true, description: "Move devices to another lifecycle state. Only valid transitions are applied." },
  transfer: { title: "Transfer ownership", verb: "Transfer", critical: true, description: "Move devices to another tenant. Codec access travels with them." },
  command: { title: "Send command", verb: "Send", critical: false, description: "Queue a downlink command on each device." },
};

type Step = "params" | "preview" | "running";

export function BulkFlow({
  op,
  deviceIds,
  query,
  open,
  onOpenChange,
  onDone,
}: {
  op: BulkOp | null;
  deviceIds: string[];
  query?: DeviceQuery;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone?: () => void;
}) {
  const [step, setStep] = React.useState<Step>("params");
  const [params, setParams] = React.useState<Record<string, unknown>>({});
  const [preview, setPreview] = React.useState<BulkPreview | null>(null);
  const [jobId, setJobId] = React.useState<string>();
  const previewM = useBulkPreview();
  const run = useBulkRun();
  const job = useBulkJob(jobId);

  React.useEffect(() => {
    if (open) {
      setStep("params");
      setParams({});
      setPreview(null);
      setJobId(undefined);
      previewM.reset();
      run.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, op]);

  if (!op) return null;
  const meta = BULK_META[op] ?? { title: fmt.label(op), verb: "Run", critical: false, description: "" };
  const paramsValid = validParams(op, params);

  const check = () =>
    previewM.mutate(
      { op, deviceIds: deviceIds.length ? deviceIds : undefined, query: deviceIds.length ? undefined : query, params },
      {
        onSuccess: (p) => {
          setPreview(p);
          setStep("preview");
        },
      },
    );
  const confirm = () => {
    if (!preview) return;
    run.mutate(
      { op, deviceIds: preview.eligible, params },
      {
        onSuccess: (j) => {
          setJobId(j.id);
          setStep("running");
        },
      },
    );
  };

  const steps: { key: Step; label: string }[] = [
    { key: "params", label: "Details" },
    { key: "preview", label: "Eligibility" },
    { key: "running", label: "Progress" },
  ];
  const stepIdx = steps.findIndex((s) => s.key === step);
  const j = job.data;

  return (
    <Dialog open={open} onOpenChange={(v) => (step === "running" && j?.status === "running" ? undefined : onOpenChange(v))}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{meta.title}</DialogTitle>
          <DialogDescription>
            {deviceIds.length ? `${fmt.number(deviceIds.length)} selected ${deviceIds.length === 1 ? "device" : "devices"}.` : "All devices matching the current filters."}{" "}
            {meta.description}
          </DialogDescription>
          <ol className="mt-4 flex items-center gap-2" aria-label="Progress">
            {steps.map((s, i) => (
              <li key={s.key} className="flex flex-1 items-center gap-2" aria-current={i === stepIdx ? "step" : undefined}>
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular",
                    i < stepIdx ? "bg-fg text-bg" : i === stepIdx ? "bg-signal text-white" : "bg-hover text-subtle ring-1 ring-line ring-inset",
                  )}
                >
                  {i + 1}
                </span>
                <span className={cn("text-xs", i === stepIdx ? "text-fg" : "text-subtle")}>{s.label}</span>
                {i < steps.length - 1 ? <span className="h-px flex-1 bg-line" /> : null}
              </li>
            ))}
          </ol>
        </DialogHeader>

        {step === "params" ? (
          <>
            <DialogBody>
              <OpParams op={op} params={params} setParams={setParams} />
              {meta.critical ? (
                <Callout tone="signal" icon={Lock} title="Checked before anything changes">
                  Your permission and each device’s eligibility are verified first. Nothing is applied until you confirm.
                </Callout>
              ) : null}
              {previewM.error ? <Callout tone="danger" icon={ShieldAlert} title="Eligibility check failed">{errorMessage(previewM.error)}</Callout> : null}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!paramsValid || previewM.isPending} onClick={check}>
                {previewM.isPending ? <Spinner /> : null}
                Check eligibility
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {step === "preview" && preview ? (
          <>
            <DialogBody>
              <div className="grid grid-cols-2 gap-px overflow-hidden rounded-card bg-line ring-1 ring-line">
                <div className="bg-panel px-5 py-4">
                  <p className="text-xs text-muted">Eligible</p>
                  <p className="text-2xl font-semibold tracking-[-0.03em] text-ion tabular">{fmt.number(preview.eligible.length)}</p>
                </div>
                <div className="bg-panel px-5 py-4">
                  <p className="text-xs text-muted">Not eligible</p>
                  <p className={cn("text-2xl font-semibold tracking-[-0.03em] tabular", preview.ineligible.length && "text-ember")}>
                    {fmt.number(preview.ineligible.length)}
                  </p>
                </div>
              </div>
              {preview.requiresPermission ? (
                <p className="flex items-center gap-2 text-[13px] text-muted">
                  <Lock className="size-3.5" /> Requires <code className="font-mono text-fg">{preview.requiresPermission}</code>. You have it.
                </p>
              ) : null}
              {preview.warnings.map((w) => (
                <Callout key={w} tone="ember">
                  {w}
                </Callout>
              ))}
              {preview.ineligible.length ? (
                <div>
                  <p className="mb-2 text-[13px] font-medium">Skipped, with reasons</p>
                  <ul className="scrollbar-quiet max-h-48 overflow-y-auto rounded-control ring-1 ring-line ring-inset">
                    {preview.ineligible.map((x) => (
                      <li key={x.deviceId} className="flex gap-3 border-b border-line px-3.5 py-2 text-[13px] last:border-0">
                        <span className="w-32 shrink-0 truncate font-mono text-xs text-muted">{x.deviceId}</span>
                        <span className="text-muted">{x.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {run.error ? <Callout tone="danger" title="Couldn’t start">{errorMessage(run.error)}</Callout> : null}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setStep("params")}>
                Back
              </Button>
              <Button variant={op === "suspend" ? "danger" : "primary"} disabled={!preview.eligible.length || run.isPending} onClick={confirm}>
                {run.isPending ? <Spinner /> : null}
                {meta.verb} {fmt.number(preview.eligible.length)} {preview.eligible.length === 1 ? "device" : "devices"}
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {step === "running" ? (
          <>
            <DialogBody>
              <JobProgress job={j} />
            </DialogBody>
            <DialogFooter>
              {j && j.failed > 0 ? (
                <Button variant="secondary" onClick={() => downloadFailures(j)}>
                  <Download />
                  Failure report
                </Button>
              ) : null}
              <Button
                variant="primary"
                disabled={!j || j.status === "running"}
                onClick={() => {
                  onOpenChange(false);
                  onDone?.();
                }}
              >
                {!j || j.status === "running" ? <Spinner /> : null}
                Done
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function JobProgress({ job }: { job: BulkJob | undefined }) {
  if (!job)
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted">
        <Spinner /> Starting…
      </div>
    );
  const done = job.succeeded + job.failed;
  const pct = job.total ? done / job.total : 0;
  const failures = job.results.filter((r) => !r.ok);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium">
          {job.status === "running" ? "Applying…" : job.status === "completed" ? "Completed" : job.status === "completed_with_errors" ? "Completed with errors" : "Failed"}
        </p>
        <p className="text-sm text-muted tabular">
          {fmt.number(done)} of {fmt.number(job.total)}
        </p>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-hover" role="progressbar" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="bg-ion transition-[width] duration-500 ease-out-soft" style={{ width: `${(job.succeeded / Math.max(1, job.total)) * 100}%` }} />
        <div className="bg-danger transition-[width] duration-500 ease-out-soft" style={{ width: `${(job.failed / Math.max(1, job.total)) * 100}%` }} />
      </div>
      <div className="flex gap-5 text-[13px]">
        <span className="flex items-center gap-1.5 text-ion">
          <CheckCircle2 className="size-3.5" /> {fmt.number(job.succeeded)} succeeded
        </span>
        <span className={cn("flex items-center gap-1.5", job.failed ? "text-danger" : "text-subtle")}>
          <XCircle className="size-3.5" /> {fmt.number(job.failed)} failed
        </span>
      </div>
      {failures.length ? (
        <ul className="scrollbar-quiet max-h-48 overflow-y-auto rounded-control ring-1 ring-line ring-inset">
          {failures.map((f) => (
            <li key={f.deviceId} className="flex gap-3 border-b border-line px-3.5 py-2 text-[13px] last:border-0">
              <span className="w-32 shrink-0 truncate font-mono text-xs text-muted">{f.deviceId}</span>
              <span className="text-danger">{f.error ?? "Failed"}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function downloadFailures(job: BulkJob) {
  const rows = [["deviceId", "error"], ...job.results.filter((r) => !r.ok).map((r) => [r.deviceId, (r.error ?? "").replace(/"/g, '""')])];
  const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `bulk-${job.op}-${job.id}-failures.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function validParams(op: BulkOp, p: Record<string, unknown>) {
  switch (op) {
    case "assign":
      return !!p.assetId;
    case "apply_config":
      return !!p.templateId;
    case "start_ota":
      return !!p.firmwareId && !!p.name;
    case "lifecycle":
      return !!p.to;
    case "transfer":
      return !!p.toTenantId;
    case "command":
      return !!p.message && p.data !== null;
    default:
      return true;
  }
}

function OpParams({ op, params, setParams }: { op: BulkOp; params: Record<string, unknown>; setParams: (p: Record<string, unknown>) => void }) {
  const set = (k: string, v: unknown) => setParams({ ...params, [k]: v });
  switch (op) {
    case "assign":
      return <AssignParams params={params} set={set} />;
    case "apply_config":
      return <ConfigParams params={params} set={set} />;
    case "start_ota":
      return <OtaParams params={params} set={set} />;
    case "lifecycle":
      return (
        <Field>
          <Label htmlFor="b-to">Move to</Label>
          <NativeSelect id="b-to" value={String(params.to ?? "")} onChange={(e) => set("to", e.target.value || undefined)}>
            <option value="">Choose a state…</option>
            {LIFECYCLE_ORDER.map((s) => (
              <option key={s} value={s}>
                {LIFECYCLE_LABELS[s as LifecycleState]}
              </option>
            ))}
          </NativeSelect>
          <FieldHint>Devices where this transition isn’t allowed are listed as not eligible.</FieldHint>
        </Field>
      );
    case "transfer":
      return <TransferParams params={params} set={set} />;
    case "command":
      return <CommandParams params={params} set={set} />;
    case "suspend":
    case "reactivate":
      return (
        <Field>
          <Label htmlFor="b-note">Reason (recorded in audit)</Label>
          <Input id="b-note" value={String(params.note ?? "")} onChange={(e) => set("note", e.target.value)} placeholder="e.g. Customer non-payment" />
        </Field>
      );
    default:
      return null;
  }
}

type SetFn = (k: string, v: unknown) => void;

function AssignParams({ params, set }: { params: Record<string, unknown>; set: SetFn }) {
  const assets = useAssets();
  return (
    <>
      <Field>
        <Label htmlFor="b-asset">Asset</Label>
        <NativeSelect id="b-asset" value={String(params.assetId ?? "")} onChange={(e) => set("assetId", e.target.value || undefined)}>
          <option value="">{assets.isPending ? "Loading…" : "Choose an asset…"}</option>
          {(assets.data ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.type})
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <Label htmlFor="b-role">Role</Label>
        <NativeSelect id="b-role" value={String(params.role ?? "primary")} onChange={(e) => set("role", e.target.value)}>
          <option value="primary">Primary</option>
          <option value="secondary">Secondary</option>
        </NativeSelect>
      </Field>
    </>
  );
}

function ConfigParams({ params, set }: { params: Record<string, unknown>; set: SetFn }) {
  const t = useConfigTemplates();
  return (
    <Field>
      <Label htmlFor="b-tpl">Configuration template</Label>
      <NativeSelect id="b-tpl" value={String(params.templateId ?? "")} onChange={(e) => set("templateId", e.target.value || undefined)}>
        <option value="">{t.isPending ? "Loading…" : "Choose a template…"}</option>
        {(t.data ?? []).map((x) => (
          <option key={x.id} value={x.id}>
            {x.name} v{x.version} ({x.modelId})
          </option>
        ))}
      </NativeSelect>
      <FieldHint>Devices of a different model are skipped.</FieldHint>
    </Field>
  );
}

function OtaParams({ params, set }: { params: Record<string, unknown>; set: SetFn }) {
  const fw = useFirmware();
  return (
    <>
      <Field>
        <Label htmlFor="b-name">Campaign name</Label>
        <Input id="b-name" value={String(params.name ?? "")} onChange={(e) => set("name", e.target.value)} placeholder="Tracker 2.4.1 rollout" />
      </Field>
      <Field>
        <Label htmlFor="b-fw">Firmware</Label>
        <NativeSelect id="b-fw" value={String(params.firmwareId ?? "")} onChange={(e) => set("firmwareId", e.target.value || undefined)}>
          <option value="">{fw.isPending ? "Loading…" : "Choose firmware…"}</option>
          {(fw.data ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.version} ({f.modelId})
            </option>
          ))}
        </NativeSelect>
        <FieldHint>Rolls out canary, 10%, 50%, then everyone, pausing if the health gate trips.</FieldHint>
      </Field>
    </>
  );
}

function TransferParams({ params, set }: { params: Record<string, unknown>; set: SetFn }) {
  const tenants = useTenants();
  return (
    <Field>
      <Label htmlFor="b-tenant">Receiving tenant</Label>
      {tenants.data?.length ? (
        <NativeSelect id="b-tenant" value={String(params.toTenantId ?? "")} onChange={(e) => set("toTenantId", e.target.value || undefined)}>
          <option value="">Choose a tenant…</option>
          {tenants.data.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({fmt.label(t.kind)})
            </option>
          ))}
        </NativeSelect>
      ) : (
        <Input id="b-tenant" value={String(params.toTenantId ?? "")} onChange={(e) => set("toTenantId", e.target.value)} placeholder="tenant id" />
      )}
    </Field>
  );
}

function CommandParams({ params, set }: { params: Record<string, unknown>; set: SetFn }) {
  const [raw, setRaw] = React.useState("{}");
  return (
    <>
      <Field>
        <Label htmlFor="b-msg">Downlink message</Label>
        <Input id="b-msg" value={String(params.message ?? "")} onChange={(e) => set("message", e.target.value)} placeholder="e.g. set_interval" />
      </Field>
      <Field>
        <Label htmlFor="b-data">Data (JSON)</Label>
        <Textarea
          id="b-data"
          value={raw}
          className="font-mono text-[13px]"
          onChange={(e) => {
            setRaw(e.target.value);
            try {
              const v = JSON.parse(e.target.value) as unknown;
              set("data", v && typeof v === "object" && !Array.isArray(v) ? v : null);
            } catch {
              set("data", null);
            }
          }}
        />
      </Field>
    </>
  );
}
