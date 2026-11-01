"use client";

import * as React from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Download,
  Factory,
  FileSpreadsheet,
  Rocket,
  UploadCloud,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { Batch, Device, DeviceModel, Firmware } from "@hash8/sdk-ts";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/empty";
import { Field, FieldHint, Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/tabs";
import { client, errorMessage, useFirmware, useModels } from "@/lib/api";
import { useAssets } from "@/lib/api-v11";
import {
  csvTemplate,
  findExistingSerials,
  iccidError,
  imeiError,
  parseCsv,
  serialError,
  serialRange,
  toCsv,
  validateRows,
  type DraftDevice,
  type RowCheck,
} from "@/lib/onboarding";
import { getTenant, useTenant } from "@/lib/tenant";
import { cn, fmt } from "@/lib/utils";
import { CodecBadge, ModelPicker, useCodecIndex } from "./model-picker";
import { ConnectPanel } from "./connect-panel";

type Method = "single" | "csv" | "batch";
type Step = "method" | "details" | "review" | "done";
const STEPS: { key: Step; label: string }[] = [
  { key: "method", label: "Method" },
  { key: "details", label: "Details" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
];

interface Options {
  issueCredentials: boolean;
  assetId: string;
  role: "primary" | "secondary";
  lifecycle: "registered" | "assigned";
}

interface BatchSpec {
  modelId: string;
  firmwareId: string;
  name: string;
  quantity: number;
  prefix: string;
  start: number;
  pad: number;
}

export interface Outcome {
  serial: string;
  modelId: string;
  ok: boolean;
  device?: Device;
  error?: string;
  notes: string[];
}

export function OnboardView() {
  const models = useModels();
  const firmware = useFirmware();
  const [step, setStep] = React.useState<Step>("method");
  const [method, setMethod] = React.useState<Method>("single");
  const [single, setSingle] = React.useState<DraftDevice>({ serial: "", modelId: "", tags: [] });
  const [csvRows, setCsvRows] = React.useState<RowCheck[] | null>(null);
  const [batch, setBatch] = React.useState<BatchSpec>({ modelId: "", firmwareId: "", name: "", quantity: 10, prefix: "SN-", start: 1, pad: 5 });
  const [options, setOptions] = React.useState<Options>({ issueCredentials: true, assetId: "", role: "primary", lifecycle: "registered" });
  const [outcomes, setOutcomes] = React.useState<Outcome[]>([]);
  const [progress, setProgress] = React.useState<{ done: number; total: number; phase: string } | null>(null);
  const qc = useQueryClient();
  const tenant = useTenant();

  const modelList = models.data ?? [];
  const fwList = firmware.data ?? [];

  const drafts: DraftDevice[] = React.useMemo(() => {
    if (method === "single") return single.serial && single.modelId ? [single] : [];
    if (method === "csv") return (csvRows ?? []).filter((r) => r.errors.length === 0).map((r) => r.draft);
    const fw = fwList.find((f) => f.id === batch.firmwareId);
    if (!batch.modelId || batch.quantity < 1) return [];
    return serialRange(batch.prefix, batch.start, Math.min(batch.quantity, 1000), batch.pad).map((serial) => ({
      serial,
      modelId: batch.modelId,
      firmwareVersion: fw?.version,
      tags: [],
    }));
  }, [method, single, csvRows, batch, fwList]);

  const singleValid =
    !serialError(single.serial) && !!single.modelId && !imeiError(single.imei) && !iccidError(single.iccid);
  const canContinue =
    method === "single" ? singleValid : method === "csv" ? drafts.length > 0 : !!batch.modelId && batch.quantity >= 1 && batch.quantity <= 1000 && !!batch.prefix;

  const run = async () => {
    setStep("done");
    setOutcomes([]);
    const results: Outcome[] = [];
    const c = client(getTenant());
    try {
      // 1 — create
      setProgress({ done: 0, total: drafts.length, phase: "Registering devices" });
      if (method === "csv") {
        try {
          const res = await c.post<{ imported: number; items: Device[]; errors: { line: number; error: string }[] }>("/devices/import", {
            csv: toCsv(drafts),
          });
          const bySerial = new Map(res.items.map((d) => [d.serial, d]));
          const errByIdx = new Map(res.errors.map((e) => [e.line - 1, e.error]));
          drafts.forEach((d, i) => {
            const dev = bySerial.get(d.serial);
            results.push(dev ? { serial: d.serial, modelId: d.modelId, ok: true, device: dev, notes: [] } : { serial: d.serial, modelId: d.modelId, ok: false, error: errByIdx.get(i) ?? "Not imported", notes: [] });
          });
        } catch (e) {
          for (const d of drafts) results.push({ serial: d.serial, modelId: d.modelId, ok: false, error: errorMessage(e), notes: [] });
        }
        setProgress({ done: drafts.length, total: drafts.length, phase: "Registering devices" });
      } else {
        let batchId: string | undefined;
        if (method === "batch") {
          try {
            const b = await c.post<Batch>("/batches", {
              modelId: batch.modelId,
              name: batch.name || `${batch.prefix}${String(batch.start).padStart(batch.pad, "0")} ×${batch.quantity}`,
              quantity: drafts.length,
              firmwareId: batch.firmwareId || undefined,
            });
            batchId = b.id;
          } catch (e) {
            for (const d of drafts) results.push({ serial: d.serial, modelId: d.modelId, ok: false, error: `Batch not created: ${errorMessage(e)}`, notes: [] });
            setOutcomes(results);
            return;
          }
        }
        let done = 0;
        await pool(drafts, 4, async (d) => {
          const body: Record<string, unknown> = { ...d, tags: d.tags ?? [] };
          if (batchId) body.batchId = batchId;
          for (const k of Object.keys(body)) if (body[k] === "" || body[k] === undefined) delete body[k];
          try {
            const dev = await c.post<Device>("/devices", body);
            results.push({ serial: d.serial, modelId: d.modelId, ok: true, device: dev, notes: [] });
          } catch (e) {
            results.push({ serial: d.serial, modelId: d.modelId, ok: false, error: errorMessage(e), notes: [] });
          }
          setProgress({ done: ++done, total: drafts.length, phase: "Registering devices" });
        });
      }

      // 2 — follow-ups per created device
      const created = results.filter((r) => r.ok && r.device);
      const hasFollowUps = options.issueCredentials || !!options.assetId || options.lifecycle === "assigned";
      if (created.length && hasFollowUps) {
        let done = 0;
        setProgress({ done: 0, total: created.length, phase: "Applying options" });
        await pool(created, 4, async (r) => {
          const id = r.device!.id;
          if (options.assetId) {
            try {
              await c.post(`/assets/${encodeURIComponent(options.assetId)}/devices`, { deviceId: id, role: options.role });
              r.notes.push("Assigned to asset");
            } catch (e) {
              r.notes.push(`Asset not assigned: ${errorMessage(e)}`);
            }
          }
          if (options.lifecycle === "assigned") {
            try {
              const cur = await c.get<Device>(`/devices/${encodeURIComponent(id)}`);
              if (cur.lifecycle === "registered") await c.post(`/devices/${encodeURIComponent(id)}/lifecycle`, { to: "assigned" });
              r.notes.push("Lifecycle: Assigned");
            } catch (e) {
              r.notes.push(`Lifecycle unchanged: ${errorMessage(e)}`);
            }
          }
          if (options.issueCredentials) {
            try {
              await c.post(`/devices/${encodeURIComponent(id)}/credentials`);
              r.notes.push("X.509 certificate issued");
            } catch (e) {
              r.notes.push(`No certificate: ${errorMessage(e)}`);
            }
          }
          setProgress({ done: ++done, total: created.length, phase: "Applying options" });
        });
      }
    } finally {
      const order = new Map(drafts.map((d, i) => [d.serial, i]));
      setOutcomes(results.toSorted((a, b) => (order.get(a.serial) ?? 0) - (order.get(b.serial) ?? 0)));
      setProgress(null);
      void qc.invalidateQueries({ queryKey: [tenant ?? "default"] });
    }
  };

  const restart = () => {
    setStep("method");
    setSingle({ serial: "", modelId: "", tags: [] });
    setCsvRows(null);
    setOutcomes([]);
  };

  const stepIdx = STEPS.findIndex((s) => s.key === step);

  return (
    <>
      <PageHeader back={{ href: "/inventory", label: "Inventory" }} title="Add devices" description="Register devices one at a time, from a spreadsheet, or as a factory batch. Each one comes out ready to connect." />
      <ol className="mb-8 flex items-center gap-3" aria-label="Onboarding steps">
        {STEPS.map((s, i) => (
          <li key={s.key} className="flex flex-1 items-center gap-3" aria-current={i === stepIdx ? "step" : undefined}>
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular transition-colors",
                i < stepIdx ? "bg-fg text-bg" : i === stepIdx ? "bg-signature text-[#05060A]" : "text-subtle ring-1 ring-line-strong ring-inset",
              )}
            >
              {i < stepIdx ? <CheckCircle2 className="size-4" /> : i + 1}
            </span>
            <span className={cn("text-sm whitespace-nowrap", i === stepIdx ? "font-medium text-fg" : "text-muted")}>{s.label}</span>
            {i < STEPS.length - 1 ? <span className={cn("h-px flex-1", i < stepIdx ? "bg-fg/50" : "bg-line")} /> : null}
          </li>
        ))}
      </ol>

      {models.error && !models.data ? (
        <Panel>
          <ApiError error={models.error} onRetry={() => void models.refetch()} />
        </Panel>
      ) : step === "method" ? (
        <MethodStep
          method={method}
          onPick={(m) => {
            setMethod(m);
            setStep("details");
          }}
        />
      ) : step === "details" ? (
        <>
          {method === "single" ? (
            <SingleForm value={single} onChange={setSingle} models={modelList} loading={models.isPending} options={options} setOptions={setOptions} />
          ) : method === "csv" ? (
            <CsvStep models={modelList} rows={csvRows} onRows={setCsvRows} />
          ) : (
            <BatchForm value={batch} onChange={setBatch} models={modelList} loading={models.isPending} firmware={fwList} preview={drafts.map((d) => d.serial)} />
          )}
          <Nav back={() => setStep("method")} next={() => setStep("review")} nextLabel="Review" disabled={!canContinue} />
        </>
      ) : step === "review" ? (
        <>
          <ReviewStep drafts={drafts} models={modelList} options={options} setOptions={setOptions} method={method} />
          <Nav back={() => setStep("details")} next={() => void run()} nextLabel={`Register ${fmt.number(drafts.length)} ${drafts.length === 1 ? "device" : "devices"}`} disabled={!drafts.length} primary />
        </>
      ) : (
        <DoneStep outcomes={outcomes} progress={progress} models={modelList} onRestart={restart} />
      )}
    </>
  );
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

function Nav({ back, next, nextLabel, disabled, primary }: { back: () => void; next: () => void; nextLabel: string; disabled?: boolean; primary?: boolean }) {
  return (
    <div className="mt-6 flex items-center justify-between">
      <Button variant="ghost" onClick={back}>
        <ArrowLeft />
        Back
      </Button>
      <Button variant={primary ? "accent" : "primary"} size="lg" onClick={next} disabled={disabled}>
        {nextLabel}
        <ArrowRight />
      </Button>
    </div>
  );
}

// ── Step 1: method ───────────────────────────────────────────────────────────
const METHODS: { key: Method; title: string; body: string; icon: LucideIcon; hint: string }[] = [
  { key: "single", title: "Single device", body: "Type in one device’s identity and attach it to an asset.", icon: Cpu, hint: "Best for replacements and field adds" },
  { key: "csv", title: "Bulk from CSV", body: "Upload or paste a spreadsheet. Every row is checked before anything is imported.", icon: FileSpreadsheet, hint: "Hundreds of devices in one go" },
  { key: "batch", title: "Factory batch", body: "Generate a serial range for a production run of one model and firmware.", icon: Factory, hint: "For OEM manufacturing lines" },
];

function MethodStep({ method, onPick }: { method: Method; onPick: (m: Method) => void }) {
  return (
    <div role="radiogroup" aria-label="Onboarding method" className="grid gap-4 md:grid-cols-3">
      {METHODS.map((m) => {
        const Icon = m.icon;
        return (
          <button
            key={m.key}
            type="button"
            role="radio"
            aria-checked={method === m.key}
            onClick={() => onPick(m.key)}
            className="focus-ring group flex cursor-pointer flex-col gap-5 rounded-panel border border-line bg-panel p-7 text-left transition-colors hover:border-line-strong hover:bg-raised/50"
          >
            <span className="flex size-12 items-center justify-center rounded-2xl bg-raised ring-1 ring-line ring-inset transition-colors group-hover:ring-signal/40">
              <Icon className="size-5" strokeWidth={1.6} />
            </span>
            <span>
              <span className="block text-lg font-semibold tracking-[-0.02em]">{m.title}</span>
              <span className="mt-1.5 block text-sm text-muted">{m.body}</span>
            </span>
            <span className="mt-auto flex items-center justify-between text-xs text-subtle">
              {m.hint}
              <ArrowRight className="size-4 text-muted transition-transform group-hover:translate-x-0.5" />
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Step 2a: single ──────────────────────────────────────────────────────────
function SingleForm({
  value,
  onChange,
  models,
  loading,
  options,
  setOptions,
}: {
  value: DraftDevice;
  onChange: (d: DraftDevice) => void;
  models: DeviceModel[];
  loading: boolean;
  options: Options;
  setOptions: (o: Options) => void;
}) {
  const assets = useAssets();
  const set = (k: keyof DraftDevice, v: unknown) => onChange({ ...value, [k]: v });
  const [exists, setExists] = React.useState<boolean | null>(null);
  const [touched, setTouched] = React.useState<Record<string, boolean>>({});
  const tenant = useTenant();

  React.useEffect(() => {
    setExists(null);
    if (serialError(value.serial)) return;
    const t = setTimeout(() => {
      void findExistingSerials([value.serial], tenant).then((s) => setExists(s.has(value.serial)));
    }, 400);
    return () => clearTimeout(t);
  }, [value.serial, tenant]);

  const err = {
    serial: touched.serial ? (serialError(value.serial) ?? (exists ? "Serial already registered" : null)) : null,
    imei: touched.imei ? imeiError(value.imei) : null,
    iccid: touched.iccid ? iccidError(value.iccid) : null,
  };
  const blur = (k: string) => () => setTouched((x) => ({ ...x, [k]: true }));

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Model</PanelTitle>
            <PanelDescription>The codec badge shows which decoder will read its messages</PanelDescription>
          </div>
        </PanelHeader>
        <PanelBody>
          <ModelPicker models={models} loading={loading} value={value.modelId} onChange={(id) => set("modelId", id)} />
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader>
          <PanelTitle>Identity</PanelTitle>
        </PanelHeader>
        <PanelBody className="flex flex-col gap-4">
          <Field>
            <Label htmlFor="ob-serial">Serial or UDI</Label>
            <Input id="ob-serial" value={value.serial} onChange={(e) => set("serial", e.target.value.trim())} onBlur={blur("serial")} aria-invalid={!!err.serial} className="font-mono" placeholder="SN-000123" autoFocus />
            {err.serial ? <p className="text-xs text-danger">{err.serial}</p> : exists === false ? <FieldHint>Available</FieldHint> : null}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <Label htmlFor="ob-imei">IMEI</Label>
              <Input id="ob-imei" inputMode="numeric" value={value.imei ?? ""} onChange={(e) => set("imei", e.target.value.replace(/\s/g, "") || undefined)} onBlur={blur("imei")} aria-invalid={!!err.imei} className="font-mono" placeholder="15 digits" />
              {err.imei ? <p className="text-xs text-danger">{err.imei}</p> : null}
            </Field>
            <Field>
              <Label htmlFor="ob-iccid">ICCID</Label>
              <Input id="ob-iccid" inputMode="numeric" value={value.iccid ?? ""} onChange={(e) => set("iccid", e.target.value.replace(/\s/g, "") || undefined)} onBlur={blur("iccid")} aria-invalid={!!err.iccid} className="font-mono" placeholder="19–20 digits" />
              {err.iccid ? <p className="text-xs text-danger">{err.iccid}</p> : null}
            </Field>
          </div>
          <Field>
            <Label htmlFor="ob-name">Name (optional)</Label>
            <Input id="ob-name" value={value.name ?? ""} onChange={(e) => set("name", e.target.value || undefined)} placeholder="Truck 14 tracker" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <Label htmlFor="ob-org">Organization</Label>
              <Input id="ob-org" value={value.organization ?? ""} onChange={(e) => set("organization", e.target.value || undefined)} />
            </Field>
            <Field>
              <Label htmlFor="ob-branch">Branch</Label>
              <Input id="ob-branch" value={value.branch ?? ""} onChange={(e) => set("branch", e.target.value || undefined)} />
            </Field>
          </div>
          <Field>
            <Label htmlFor="ob-tags">Tags</Label>
            <Input
              id="ob-tags"
              value={(value.tags ?? []).join(", ")}
              onChange={(e) => set("tags", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
              placeholder="cold-chain, pilot"
            />
          </Field>
          <Field>
            <Label htmlFor="ob-asset">Assign to asset (optional)</Label>
            <NativeSelect id="ob-asset" value={options.assetId} onChange={(e) => setOptions({ ...options, assetId: e.target.value, lifecycle: e.target.value ? "assigned" : options.lifecycle })}>
              <option value="">No asset</option>
              {(assets.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.type})
                </option>
              ))}
            </NativeSelect>
          </Field>
        </PanelBody>
      </Panel>
    </div>
  );
}

// ── Step 2b: CSV ─────────────────────────────────────────────────────────────
function CsvStep({ models, rows, onRows }: { models: DeviceModel[]; rows: RowCheck[] | null; onRows: (r: RowCheck[] | null) => void }) {
  const [mode, setMode] = React.useState<"upload" | "paste">("upload");
  const [text, setText] = React.useState("");
  const [checking, setChecking] = React.useState(false);
  const [over, setOver] = React.useState(false);
  const [fileName, setFileName] = React.useState<string>();
  const tenant = useTenant();
  const input = React.useRef<HTMLInputElement>(null);

  const check = async (csv: string) => {
    const parsed = parseCsv(csv);
    if (!parsed.length) {
      onRows([]);
      return;
    }
    setChecking(true);
    const existing = await findExistingSerials(parsed.map((p) => p.draft.serial), tenant);
    onRows(validateRows(parsed, models, existing));
    setChecking(false);
  };

  const loadFile = async (f: File | undefined) => {
    if (!f) return;
    setFileName(f.name);
    const t = await f.text();
    setText(t);
    void check(t);
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([csvTemplate(models)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "device-import-template.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const valid = rows?.filter((r) => r.errors.length === 0).length ?? 0;
  const invalid = (rows?.length ?? 0) - valid;
  const [showValid, setShowValid] = React.useState(false);
  const shown = (rows ?? []).filter((r) => showValid || r.errors.length > 0).slice(0, 300);

  return (
    <div className="flex flex-col gap-6">
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Spreadsheet</PanelTitle>
            <PanelDescription>
              Columns <code className="font-mono text-fg">serial, imei, iccid, modelId</code>. Optional: name, organization, branch.
            </PanelDescription>
          </div>
          <div className="flex items-center gap-2">
            <Segmented label="Input" value={mode} onValueChange={setMode} options={[{ value: "upload", label: "Upload" }, { value: "paste", label: "Paste" }]} />
            <Button size="sm" variant="secondary" onClick={downloadTemplate}>
              <Download />
              Template
            </Button>
          </div>
        </PanelHeader>
        <PanelBody>
          {mode === "upload" ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                void loadFile(e.dataTransfer.files[0]);
              }}
              className={cn("relative rounded-card border border-dashed transition-colors", over ? "border-signal bg-signal/[0.05]" : "border-line-strong")}
            >
              <button type="button" onClick={() => input.current?.click()} className="focus-ring flex w-full cursor-pointer flex-col items-center gap-2 rounded-card px-6 py-10 text-center">
                {checking ? <Spinner className="size-5" /> : <UploadCloud className="size-6 text-muted" strokeWidth={1.5} />}
                <span className="text-[15px] font-medium">{fileName ?? "Drop a CSV here, or click to choose"}</span>
                <span className="text-xs text-subtle">{checking ? "Checking every row against your inventory…" : ".csv, comma or semicolon separated"}</span>
              </button>
              <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" tabIndex={-1} onChange={(e) => void loadFile(e.target.files?.[0])} />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-48 font-mono text-[12.5px]" placeholder={csvTemplate(models)} spellCheck={false} aria-label="CSV text" />
              <Button variant="primary" className="self-start" disabled={!text.trim() || checking} onClick={() => void check(text)}>
                {checking ? <Spinner /> : null}
                Check rows
              </Button>
            </div>
          )}
        </PanelBody>
      </Panel>

      {rows ? (
        <Panel className="overflow-hidden">
          <PanelHeader>
            <div>
              <PanelTitle className="flex flex-wrap items-center gap-2">
                Preview
                <Badge tone="ion">{fmt.number(valid)} ready</Badge>
                {invalid ? <Badge tone="danger">{fmt.number(invalid)} with problems</Badge> : null}
              </PanelTitle>
              <PanelDescription>{invalid ? "Rows with problems are skipped. Fix them in the file and re-upload to include them." : "Every row passed."}</PanelDescription>
            </div>
            <label className="flex items-center gap-2 text-sm text-muted">
              Show valid rows
              <Switch checked={showValid} onCheckedChange={setShowValid} />
            </label>
          </PanelHeader>
          {rows.length === 0 ? (
            <p className="px-7 pb-7 text-sm text-muted">No rows found.</p>
          ) : shown.length === 0 ? (
            <p className="px-7 pb-7 text-sm text-muted">All {fmt.number(valid)} rows are valid.</p>
          ) : (
            <div className="scrollbar-quiet max-h-[52vh] overflow-auto border-t border-line">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-panel">
                  <tr className="border-b border-line text-left text-xs text-subtle">
                    <th className="h-9 pr-3 pl-6 font-medium sm:pl-7">Line</th>
                    <th className="px-3 font-medium">Serial</th>
                    <th className="px-3 font-medium">Model</th>
                    <th className="px-3 font-medium">IMEI</th>
                    <th className="px-3 font-medium">ICCID</th>
                    <th className="pr-6 pl-3 font-medium sm:pr-7">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.line} className={cn("border-b border-line last:border-0", r.errors.length && "bg-danger/[0.04]")}>
                      <td className="py-2 pr-3 pl-6 text-subtle tabular sm:pl-7">{r.line}</td>
                      <td className="px-3 font-mono">{r.draft.serial || "—"}</td>
                      <td className="px-3 font-mono text-muted">{r.draft.modelId || "—"}</td>
                      <td className="px-3 font-mono text-muted">{r.draft.imei ?? ""}</td>
                      <td className="px-3 font-mono text-muted">{r.draft.iccid ?? ""}</td>
                      <td className="py-2 pr-6 pl-3 sm:pr-7">
                        {r.errors.length ? (
                          <span className="flex items-start gap-1.5 text-danger">
                            <XCircle className="mt-0.5 size-3.5 shrink-0" />
                            {r.errors.join("; ")}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1.5 text-ion">
                            <CheckCircle2 className="size-3.5" />
                            Ready
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      ) : null}
    </div>
  );
}

// ── Step 2c: factory batch ───────────────────────────────────────────────────
function BatchForm({
  value,
  onChange,
  models,
  loading,
  firmware,
  preview,
}: {
  value: BatchSpec;
  onChange: (b: BatchSpec) => void;
  models: DeviceModel[];
  loading: boolean;
  firmware: Firmware[];
  preview: string[];
}) {
  const set = <K extends keyof BatchSpec>(k: K, v: BatchSpec[K]) => onChange({ ...value, [k]: v });
  const fw = firmware.filter((f) => f.modelId === value.modelId);
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <Panel>
        <PanelHeader>
          <PanelTitle>Model</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <ModelPicker models={models} loading={loading} value={value.modelId} onChange={(id) => onChange({ ...value, modelId: id, firmwareId: "" })} name="batch-model" />
        </PanelBody>
      </Panel>
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Production run</PanelTitle>
            <PanelDescription>Serials are generated as prefix plus a zero-padded counter</PanelDescription>
          </div>
        </PanelHeader>
        <PanelBody className="flex flex-col gap-4">
          <Field>
            <Label htmlFor="b-fw">Firmware flashed at the factory</Label>
            <NativeSelect id="b-fw" value={value.firmwareId} onChange={(e) => set("firmwareId", e.target.value)} disabled={!value.modelId}>
              <option value="">{!value.modelId ? "Pick a model first" : fw.length ? "None recorded" : "No firmware for this model"}</option>
              {fw.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.version}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <Label htmlFor="b-name">Batch name</Label>
            <Input id="b-name" value={value.name} onChange={(e) => set("name", e.target.value)} placeholder="Line 3, November run" />
          </Field>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field className="col-span-2 sm:col-span-1">
              <Label htmlFor="b-qty">Quantity</Label>
              <Input id="b-qty" type="number" min={1} max={1000} value={value.quantity} onChange={(e) => set("quantity", Math.max(0, Number(e.target.value)))} />
            </Field>
            <Field>
              <Label htmlFor="b-prefix">Prefix</Label>
              <Input id="b-prefix" value={value.prefix} onChange={(e) => set("prefix", e.target.value)} className="font-mono" />
            </Field>
            <Field>
              <Label htmlFor="b-start">Start at</Label>
              <Input id="b-start" type="number" min={0} value={value.start} onChange={(e) => set("start", Math.max(0, Number(e.target.value)))} />
            </Field>
            <Field>
              <Label htmlFor="b-pad">Digits</Label>
              <Input id="b-pad" type="number" min={1} max={12} value={value.pad} onChange={(e) => set("pad", Math.min(12, Math.max(1, Number(e.target.value))))} />
            </Field>
          </div>
          {value.quantity > 1000 ? <Callout tone="ember">Up to 1,000 devices per batch.</Callout> : null}
          {preview.length ? (
            <div className="rounded-control bg-sunken/60 px-4 py-3 ring-1 ring-line ring-inset">
              <p className="text-xs text-subtle">Serials</p>
              <p className="mt-1 font-mono text-[13px]">
                {preview[0]}
                {preview.length > 1 ? <span className="text-subtle"> through </span> : null}
                {preview.length > 1 ? preview[preview.length - 1] : null}
              </p>
            </div>
          ) : null}
        </PanelBody>
      </Panel>
    </div>
  );
}

// ── Step 3: review ───────────────────────────────────────────────────────────
function ReviewStep({
  drafts,
  models,
  options,
  setOptions,
  method,
}: {
  drafts: DraftDevice[];
  models: DeviceModel[];
  options: Options;
  setOptions: (o: Options) => void;
  method: Method;
}) {
  const assets = useAssets();
  const index = useCodecIndex();
  const byModel = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const d of drafts) m.set(d.modelId, (m.get(d.modelId) ?? 0) + 1);
    return [...m.entries()];
  }, [drafts]);
  const modelOf = new Map(models.map((m) => [m.id, m]));
  const noCodec = byModel.filter(([id]) => !modelOf.get(id)?.codecId);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>
              {fmt.number(drafts.length)} {drafts.length === 1 ? "device" : "devices"} to register
            </PanelTitle>
            <PanelDescription>{method === "batch" ? "As one factory batch" : method === "csv" ? "From your spreadsheet" : "Entered by hand"}</PanelDescription>
          </div>
        </PanelHeader>
        <PanelBody className="flex flex-col gap-4">
          <ul className="flex flex-col gap-2">
            {byModel.map(([id, n]) => {
              const m = modelOf.get(id);
              return (
                <li key={id} className="flex flex-wrap items-center gap-3 rounded-card border border-line px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{m ? `${m.vendor} ${m.name}` : id}</span>
                    <span className="block text-xs text-subtle">Decoded by</span>
                  </span>
                  <CodecBadge codecId={m?.codecId} index={index} />
                  <span className="w-16 text-right text-xl font-semibold tracking-[-0.02em] tabular">{fmt.number(n)}</span>
                </li>
              );
            })}
          </ul>
          {noCodec.length ? (
            <Callout tone="ember" title="Some models have no codec">
              Their messages will land in Unknown payloads until a codec is published. Import the OEM spec in Spec imports.
            </Callout>
          ) : null}
          <div className="scrollbar-quiet max-h-56 overflow-y-auto rounded-control bg-sunken/60 p-3 font-mono text-xs text-muted ring-1 ring-line ring-inset">
            {drafts.slice(0, 200).map((d) => (
              <div key={d.serial} className="flex justify-between gap-4 py-0.5">
                <span className="text-fg">{d.serial}</span>
                <span className="truncate">{[d.imei, d.iccid].filter(Boolean).join("  ")}</span>
              </div>
            ))}
            {drafts.length > 200 ? <p className="pt-1 text-subtle">and {fmt.number(drafts.length - 200)} more</p> : null}
          </div>
        </PanelBody>
      </Panel>
      <Panel className="h-fit">
        <PanelHeader>
          <div>
            <PanelTitle>Options</PanelTitle>
            <PanelDescription>Applied to every device after it’s registered</PanelDescription>
          </div>
        </PanelHeader>
        <PanelBody className="flex flex-col gap-5">
          <label className="flex items-start justify-between gap-4">
            <span>
              <span className="block text-sm font-medium">Issue credentials now</span>
              <span className="block text-xs text-subtle">An X.509 certificate from the tenant’s device CA</span>
            </span>
            <Switch checked={options.issueCredentials} onCheckedChange={(v) => setOptions({ ...options, issueCredentials: v })} />
          </label>
          <Field>
            <Label htmlFor="rv-asset">Assign to asset</Label>
            <NativeSelect id="rv-asset" value={options.assetId} onChange={(e) => setOptions({ ...options, assetId: e.target.value, lifecycle: e.target.value ? "assigned" : options.lifecycle })}>
              <option value="">No asset</option>
              {(assets.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.type})
                </option>
              ))}
            </NativeSelect>
            {options.assetId ? (
              <NativeSelect aria-label="Role on asset" value={options.role} onChange={(e) => setOptions({ ...options, role: e.target.value as Options["role"] })}>
                <option value="primary">Primary device</option>
                <option value="secondary">Secondary device</option>
              </NativeSelect>
            ) : null}
          </Field>
          <Field>
            <Label>Initial lifecycle</Label>
            <Segmented
              label="Initial lifecycle"
              value={options.lifecycle}
              onValueChange={(v) => setOptions({ ...options, lifecycle: v })}
              options={[
                { value: "registered", label: "Registered" },
                { value: "assigned", label: "Assigned" },
              ]}
            />
            <FieldHint>{options.lifecycle === "registered" ? "In inventory, available to deploy." : "Linked to a deployment, ready for installation."}</FieldHint>
          </Field>
        </PanelBody>
      </Panel>
    </div>
  );
}

// ── Step 4: done ─────────────────────────────────────────────────────────────
function DoneStep({
  outcomes,
  progress,
  models,
  onRestart,
}: {
  outcomes: Outcome[];
  progress: { done: number; total: number; phase: string } | null;
  models: DeviceModel[];
  onRestart: () => void;
}) {
  const index = useCodecIndex();
  const modelOf = new Map(models.map((m) => [m.id, m]));
  const ok = outcomes.filter((o) => o.ok);
  const failed = outcomes.filter((o) => !o.ok);
  const [open, setOpen] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!progress && ok.length && open === null) setOpen(ok[0]!.serial);
  }, [progress, ok, open]);

  const report = () => {
    const rows = [["serial", "status", "deviceId", "udi", "detail"], ...outcomes.map((o) => [o.serial, o.ok ? "registered" : "failed", o.device?.id ?? "", o.device?.udi ?? "", o.ok ? o.notes.join("; ") : (o.error ?? "")])];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "onboarding-report.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  if (progress) {
    const pct = progress.total ? progress.done / progress.total : 0;
    return (
      <Panel>
        <PanelBody className="flex flex-col items-center gap-5 py-16 text-center">
          <span className="relative flex size-12 items-center justify-center">
            <span className="absolute inset-0 animate-pulse-ring rounded-full bg-signature opacity-50" />
            <span className="size-3 rounded-full bg-signature" />
          </span>
          <div>
            <p className="text-lg font-semibold tracking-[-0.02em]">{progress.phase}…</p>
            <p className="mt-1 text-sm text-muted tabular">
              {fmt.number(progress.done)} of {fmt.number(progress.total)}
            </p>
          </div>
          <div className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-hover" role="progressbar" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-signature transition-[width] duration-300" style={{ width: `${pct * 100}%` }} />
          </div>
        </PanelBody>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Panel>
        <PanelBody className="flex flex-col gap-5 pt-7 sm:flex-row sm:items-center">
          <span className={cn("flex size-14 shrink-0 items-center justify-center rounded-2xl ring-1 ring-inset", failed.length && !ok.length ? "bg-danger/10 ring-danger/25" : "bg-ion/10 ring-ion/25")}>
            {failed.length && !ok.length ? <XCircle className="size-6 text-danger" /> : <CheckCircle2 className="size-6 text-ion" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xl font-semibold tracking-[-0.02em]">
              {ok.length ? `${fmt.number(ok.length)} ${ok.length === 1 ? "device" : "devices"} registered` : "Nothing was registered"}
            </p>
            <p className="text-sm text-muted">
              {failed.length ? `${fmt.number(failed.length)} failed, see the reasons below.` : "Connect them with the details below, or send a test payload to see the first decode."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={report}>
              <Download />
              Report
            </Button>
            <Button variant="secondary" onClick={onRestart}>
              Add more
            </Button>
            <Button variant="primary" asChild>
              <Link href="/inventory?sort=installedAt">
                <Rocket />
                Go to Inventory
              </Link>
            </Button>
          </div>
        </PanelBody>
      </Panel>

      <Panel className="overflow-hidden">
        <ul className="flex flex-col">
          {outcomes.slice(0, 500).map((o) => {
            const m = modelOf.get(o.modelId);
            const codec = m?.codecId ? index.get(m.codecId) : undefined;
            const expanded = open === o.serial && o.ok;
            return (
              <li key={o.serial} className="border-b border-line last:border-0">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 py-3.5 sm:px-7">
                  {o.ok ? <CheckCircle2 className="size-4 shrink-0 text-ion" aria-label="Registered" /> : <XCircle className="size-4 shrink-0 text-danger" aria-label="Failed" />}
                  <div className="min-w-0 flex-1">
                    {o.device ? (
                      <Link href={`/devices/${o.device.id}`} className="focus-ring rounded font-mono text-[13px] font-medium hover:underline">
                        {o.device.udi ?? o.serial}
                      </Link>
                    ) : (
                      <span className="font-mono text-[13px] font-medium">{o.serial}</span>
                    )}
                    <p className={cn("truncate text-xs", o.ok ? "text-subtle" : "text-danger")}>
                      {o.ok ? [o.device?.udi && o.device.udi !== o.serial ? `Serial ${o.serial}` : null, ...o.notes].filter(Boolean).join(", ") || (m ? `${m.vendor} ${m.name}` : "") : o.error}
                    </p>
                  </div>
                  {o.ok ? (
                    <Button size="sm" variant={expanded ? "secondary" : "ghost"} onClick={() => setOpen(expanded ? null : o.serial)} aria-expanded={expanded}>
                      Connect
                      <ChevronDown className={cn("transition-transform", expanded && "rotate-180")} />
                    </Button>
                  ) : null}
                </div>
                {expanded ? (
                  <div className="animate-enter border-t border-line bg-sunken/30 px-6 py-5 sm:px-7">
                    <ConnectPanel serial={o.serial} codecId={m?.codecId} codecVersion={codec?.version} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}
