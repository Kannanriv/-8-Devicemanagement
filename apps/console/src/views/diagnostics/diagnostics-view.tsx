"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Play, Send, Stethoscope, Unplug, XCircle } from "lucide-react";
import type { BulkJob } from "@hash8/sdk-ts";
import type { DecodeResult } from "@hash8/dcs-schema";
import { HexInspector } from "@/components/hex-inspector";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Callout, Empty } from "@/components/ui/empty";
import { Field, Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCodecs, useCodecSpec, useDecode, useDevices } from "@/lib/api";
import { useBulkJobs } from "@/lib/api-v11";
import { findMessage, messageLayout } from "@/lib/dcs";
import { fmt, hexBytes, isValidHex } from "@/lib/utils";
import { groupCodecs } from "@/views/codecs/codecs-view";

export function DiagnosticsView() {
  return (
    <>
      <PageHeader
        title="Diagnostics & commands"
        description="Decode any payload, reach any device, and follow the results of fleet-wide diagnostic runs."
        actions={
          <Button variant="secondary" asChild>
            <Link href="/payloads/unknown">
              <Unplug />
              Unknown payloads
            </Link>
          </Button>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <DecodeBench />
        <div className="flex min-w-0 flex-col gap-6">
          <CommandJump />
          <DiagnosticJobs />
        </div>
      </div>
    </>
  );
}

function DecodeBench() {
  const codecs = useCodecs();
  const groups = React.useMemo(() => groupCodecs(codecs.data ?? []), [codecs.data]);
  const [codecId, setCodecId] = React.useState("");
  const g = groups.find((x) => x.id === codecId);
  const version = g?.published?.version ?? g?.latest.version;
  const spec = useCodecSpec(codecId || undefined, version);
  const [hex, setHex] = React.useState("");
  const [port, setPort] = React.useState("");
  const decode = useDecode();
  const result: DecodeResult | undefined = decode.data;
  React.useEffect(() => {
    if (!codecId && groups[0]) setCodecId(groups[0].id);
  }, [codecId, groups]);
  React.useEffect(() => {
    const v = spec.data?.vectors.find((x) => x.direction !== "downlink");
    if (v && !hex) {
      setHex(v.hex);
      setPort(v.port != null ? String(v.port) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.data]);
  const layout = React.useMemo(() => {
    if (!result?.ok || !spec.data) return undefined;
    const def = findMessage(spec.data, result.message);
    return def ? messageLayout(def, hexBytes(hex).length).ranges : undefined;
  }, [result, spec.data, hex]);
  const valid = isValidHex(hex);

  return (
    <Panel className="min-w-0">
      <PanelHeader>
        <div>
          <PanelTitle>Decode bench</PanelTitle>
          <PanelDescription>Run any hex payload through a codec and see each field’s bytes</PanelDescription>
        </div>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-5">
        {codecs.error ? <ApiError error={codecs.error} compact /> : null}
        <form
          className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && codecId) decode.mutate({ codecId, version, hex: hex.replace(/\s/g, ""), port: port ? Number(port) : undefined });
          }}
        >
          <Field className="sm:col-span-2">
            <Label htmlFor="db-codec">Codec</Label>
            <NativeSelect id="db-codec" value={codecId} onChange={(e) => setCodecId(e.target.value)}>
              <option value="">{codecs.isPending ? "Loading…" : "Choose a codec…"}</option>
              {groups.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.latest.vendor} {x.latest.model} ({x.id}@{x.published?.version ?? x.latest.version})
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <Label htmlFor="db-hex">Payload (hex)</Label>
            <Textarea id="db-hex" rows={2} value={hex} onChange={(e) => setHex(e.target.value)} className="min-h-12 font-mono text-[13px] uppercase" aria-invalid={hex.length > 0 && !valid} spellCheck={false} />
          </Field>
          <Field>
            <Label htmlFor="db-port">Port</Label>
            <Input id="db-port" type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="any" />
          </Field>
          <Button type="submit" variant="primary" className="justify-self-start sm:col-span-2" disabled={!valid || !codecId || decode.isPending}>
            {decode.isPending ? <Spinner /> : <Play />}
            Decode
          </Button>
        </form>
        {decode.error ? <ApiError error={decode.error} compact /> : null}
        {result ? (
          result.ok ? (
            <div className="flex flex-col gap-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle2 className="size-4 text-ion" />
                <span className="font-mono">{result.message}</span>
              </p>
              <HexInspector hex={hex} data={result.data} ranges={layout} />
              {result.warnings.length ? <Callout tone="ember" title="Warnings">{result.warnings.join(". ")}</Callout> : null}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="flex items-center gap-2 text-sm font-medium">
                <XCircle className="size-4 text-danger" /> Couldn’t decode
              </p>
              {result.errors.map((e, i) => (
                <Callout key={i} tone="danger" title={e.code}>
                  {e.message}
                  {e.path ? ` (${e.path})` : ""}
                </Callout>
              ))}
            </div>
          )
        ) : null}
      </PanelBody>
    </Panel>
  );
}

function CommandJump() {
  const [q, setQ] = React.useState("");
  const devices = useDevices({ q: q || undefined, limit: 6 }, { enabled: q.length >= 2 });
  const router = useRouter();
  return (
    <Panel>
      <PanelHeader>
        <div>
          <PanelTitle>Send a command</PanelTitle>
          <PanelDescription>Forms are generated from the device’s codec</PanelDescription>
        </div>
      </PanelHeader>
      <PanelBody className="flex flex-col gap-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a device by UDI, serial or IMEI" aria-label="Find device" />
        {q.length >= 2 ? (
          devices.isPending ? (
            <Skeleton className="h-20" />
          ) : (devices.data?.items ?? []).length === 0 ? (
            <p className="text-sm text-subtle">No match.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {devices.data!.items.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => router.push(`/devices/${d.id}#commands`)}
                    className="focus-ring flex w-full cursor-pointer items-center gap-3 rounded-[12px] px-3 py-2 text-left hover:bg-hover"
                  >
                    <span className="font-mono text-[13px]">{d.udi ?? d.serial}</span>
                    <span className="truncate text-xs text-subtle">{d.model}</span>
                    <Send className="ml-auto size-3.5 text-muted" />
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="text-xs text-subtle">For many devices at once, select them in Inventory and choose Send command or Diagnostics.</p>
        )}
      </PanelBody>
    </Panel>
  );
}

function DiagnosticJobs() {
  const jobs = useBulkJobs();
  const list = (jobs.data ?? []).filter((j) => j.op === "diagnostics" || j.op === "command").toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <div>
          <PanelTitle>Recent runs</PanelTitle>
          <PanelDescription>Diagnostics and bulk commands</PanelDescription>
        </div>
      </PanelHeader>
      {jobs.isPending ? (
        <div className="px-7 pb-7">
          <Skeleton className="h-24" />
        </div>
      ) : jobs.error ? (
        <ApiError error={jobs.error} compact className="px-7 pb-6" />
      ) : list.length === 0 ? (
        <Empty icon={Stethoscope} title="No runs yet" className="py-10">
          Run diagnostics on a cohort from Inventory.
        </Empty>
      ) : (
        <ul className="flex flex-col border-t border-line">
          {list.slice(0, 8).map((j) => (
            <JobRow key={j.id} j={j} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function JobRow({ j }: { j: BulkJob }) {
  return (
    <li className="flex items-center gap-4 border-b border-line px-6 py-3.5 last:border-0 sm:px-7">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{fmt.label(j.op)}</p>
        <p className="text-xs text-subtle">{fmt.ago(j.createdAt)}</p>
      </div>
      <span className="text-xs text-muted tabular">
        {j.succeeded}/{j.total}
      </span>
      <Badge tone={j.status === "completed" ? "ion" : j.status === "running" ? "signal" : j.status === "failed" ? "danger" : "ember"}>{fmt.label(j.status)}</Badge>
    </li>
  );
}
