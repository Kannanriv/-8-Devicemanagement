"use client";

import * as React from "react";
import { CheckCircle2, Download, FlaskConical, Play, Send, XCircle } from "lucide-react";
import { toast } from "sonner";
import type { PluginTarget } from "@hash8/sdk-ts";
import type { DecodeResult, DeviceCodecSpec, VectorResult } from "@hash8/dcs-schema";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { CodecStatusBadge } from "@/components/status";
import { HexInspector, JsonView } from "@/components/hex-inspector";
import { SpecFieldsTable } from "@/components/spec-fields";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/empty";
import { Field, Input, Label, NativeSelect, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger, Segmented } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  downloadFile,
  errorMessage,
  pluginPath,
  useCodecs,
  useCodecSpec,
  useDecode,
  usePublishCodec,
  useTestCodec,
} from "@/lib/api";
import { findMessage, messageLayout } from "@/lib/dcs";
import { cn, fmt, hexBytes, isValidHex } from "@/lib/utils";
import { groupCodecs } from "./codecs-view";

export const PLUGIN_TARGETS: { value: PluginTarget | "all"; label: string; hint: string }[] = [
  { value: "ts", label: "TypeScript", hint: "Node and browsers" },
  { value: "ts013", label: "TTN / ChirpStack", hint: "LoRaWAN Codec API (TS013)" },
  { value: "python", label: "Python", hint: "3.9+" },
  { value: "go", label: "Go", hint: "Module" },
  { value: "java", label: "Java", hint: "JDK 17+" },
  { value: "c", label: "C", hint: "Embedded, no malloc" },
  { value: "all", label: "Everything", hint: "All targets in one zip" },
];

export function SpecStudio({ id }: { id: string }) {
  const codecs = useCodecs();
  const group = React.useMemo(() => groupCodecs(codecs.data ?? []).find((g) => g.id === id), [codecs.data, id]);
  const [version, setVersion] = React.useState<string>();
  const v = version ?? group?.published?.version ?? group?.latest.version;
  const summary = group?.versions.find((x) => x.version === v);
  const spec = useCodecSpec(id, v);
  const publish = usePublishCodec();

  if (codecs.isPending || (v && spec.isPending)) return <StudioSkeleton />;
  if (codecs.error || spec.error)
    return (
      <>
        <PageHeader title={id} back={{ href: "/codecs", label: "Codec catalog" }} />
        <Panel>
          <ApiError error={codecs.error ?? spec.error} onRetry={() => void (codecs.error ? codecs.refetch() : spec.refetch())} />
        </Panel>
      </>
    );
  if (!group || !v || !spec.data)
    return (
      <>
        <PageHeader title={id} back={{ href: "/codecs", label: "Codec catalog" }} />
        <Panel>
          <Callout tone="ember" title="Codec not found" className="m-6">
            There’s no codec with id {id} in this tenant.
          </Callout>
        </Panel>
      </>
    );
  const s = spec.data;

  return (
    <>
      <PageHeader
        back={{ href: "/codecs", label: "Codec catalog" }}
        title={`${s.device.vendor} ${s.device.model}`}
        description={s.device.description ?? "Device Codec Spec"}
        meta={
          <>
            {summary ? <CodecStatusBadge status={summary.status} /> : null}
            <Badge className="font-mono">{s.id}</Badge>
            {s.device.protocols?.map((p) => (
              <Badge key={p}>{p.toUpperCase()}</Badge>
            ))}
            {s.device.firmware ? <Badge>Firmware {s.device.firmware}</Badge> : null}
          </>
        }
        actions={
          <>
            <NativeSelect aria-label="Version" value={v} onChange={(e) => setVersion(e.target.value)} className="w-40">
              {group.versions.map((x) => (
                <option key={x.version} value={x.version}>
                  v{x.version} {x.status === "published" ? "" : `(${x.status.replace("_", " ")})`}
                </option>
              ))}
            </NativeSelect>
            <PluginMenu id={id} version={v} />
            {summary && summary.status !== "published" ? (
              <Button
                variant="accent"
                disabled={publish.isPending}
                onClick={() =>
                  publish.mutate(
                    { id, version: v },
                    {
                      onSuccess: () => toast.success(`Published ${id}@${v}`, { description: "Devices on this model now decode with it." }),
                      onError: (e) => toast.error("Publish blocked", { description: errorMessage(e) }),
                    },
                  )
                }
              >
                {publish.isPending ? <Spinner /> : <Send />}
                Publish
              </Button>
            ) : null}
          </>
        }
      />
      <Tabs defaultValue="messages">
        <TabsList aria-label="Spec sections">
          <TabsTrigger value="messages">Messages and fields</TabsTrigger>
          <TabsTrigger value="vectors">Test vectors</TabsTrigger>
          <TabsTrigger value="playground">Decode playground</TabsTrigger>
          <TabsTrigger value="json">DCS JSON</TabsTrigger>
        </TabsList>
        <TabsContent value="messages">
          <MessagesSection spec={s} />
        </TabsContent>
        <TabsContent value="vectors">
          <VectorsSection spec={s} id={id} version={v} />
        </TabsContent>
        <TabsContent value="playground">
          <Playground spec={s} id={id} version={v} />
        </TabsContent>
        <TabsContent value="json">
          <JsonView value={s} className="max-h-[70vh]" />
        </TabsContent>
      </Tabs>
    </>
  );
}

export function PluginMenu({ id, version }: { id: string; version: string }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary">
          {busy ? <Spinner /> : <Download />}
          Plugins
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Download generated decoder</DropdownMenuLabel>
        {PLUGIN_TARGETS.map((t, i) => (
          <React.Fragment key={t.value}>
            {i === PLUGIN_TARGETS.length - 1 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              onSelect={() => {
                setBusy(t.value);
                downloadFile(pluginPath(id, version, t.value), `${id}-${version}-${t.value}.zip`)
                  .then(() => toast.success(`${t.label} plugin downloaded`))
                  .catch((e: unknown) => toast.error("Download failed", { description: errorMessage(e) }))
                  .finally(() => setBusy(null));
              }}
            >
              <Download />
              <span className="flex flex-col">
                <span>{t.label}</span>
                <span className="text-xs text-subtle">{t.hint}</span>
              </span>
            </DropdownMenuItem>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MessagesSection({ spec }: { spec: DeviceCodecSpec }) {
  const [dir, setDir] = React.useState<"uplink" | "downlink">("uplink");
  const list = dir === "uplink" ? spec.uplink : (spec.downlink ?? []);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Segmented
          label="Direction"
          value={dir}
          onValueChange={setDir}
          options={[
            { value: "uplink", label: `Uplink (${spec.uplink.length})` },
            { value: "downlink", label: `Downlink (${spec.downlink?.length ?? 0})` },
          ]}
        />
        <span className="text-xs text-subtle">Default byte order: {spec.defaults?.endian ?? "big"} endian</span>
      </div>
      {list.length === 0 ? <p className="py-10 text-center text-sm text-muted">No {dir} messages.</p> : null}
      {list.map((m) => (
        <Panel key={m.name} className="overflow-hidden">
          <PanelHeader>
            <div>
              <PanelTitle className="font-mono">{m.name}</PanelTitle>
              <PanelDescription>
                {[
                  m.description,
                  m.when?.port != null ? `port ${Array.isArray(m.when.port) ? m.when.port.join(", ") : m.when.port}` : null,
                  m.when?.topic ? `topic ${m.when.topic}` : null,
                ]
                  .filter(Boolean)
                  .join(". ") || "Selected by leading constant fields"}
              </PanelDescription>
            </div>
          </PanelHeader>
          <div className="pb-3">
            <SpecFieldsTable msg={m} />
          </div>
        </Panel>
      ))}
    </div>
  );
}

function VectorsSection({ spec, id, version }: { spec: DeviceCodecSpec; id: string; version: string }) {
  const test = useTestCodec(id, version);
  const results = new Map<string, VectorResult>((test.data ?? []).map((r) => [r.name, r]));
  const passed = test.data?.filter((r) => r.pass).length ?? 0;
  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <div>
          <PanelTitle>Test vectors</PanelTitle>
          <PanelDescription>
            {test.data ? `${passed} of ${test.data.length} passing` : `${spec.vectors.length} vectors prove this codec decodes and encodes correctly`}
          </PanelDescription>
        </div>
        <Button
          variant="primary"
          disabled={test.isPending}
          onClick={() => test.mutate(undefined, { onError: (e) => toast.error("Vector run failed", { description: errorMessage(e) }) })}
        >
          {test.isPending ? <Spinner /> : <FlaskConical />}
          Run vectors
        </Button>
      </PanelHeader>
      {test.data ? (
        <div className="mx-6 mb-4 flex h-1.5 overflow-hidden rounded-full bg-hover sm:mx-7">
          <div className="bg-ion" style={{ width: `${(passed / Math.max(1, test.data.length)) * 100}%` }} />
          <div className="bg-danger" style={{ width: `${((test.data.length - passed) / Math.max(1, test.data.length)) * 100}%` }} />
        </div>
      ) : null}
      <ul className="flex flex-col border-t border-line">
        {(spec.vectors.length ? spec.vectors.map((v) => v.name) : (test.data ?? []).map((r) => r.name)).map((name) => {
          const vec = spec.vectors.find((x) => x.name === name);
          const r = results.get(name);
          return (
            <li key={name} className="border-b border-line px-6 py-3.5 last:border-0 sm:px-7">
              <div className="flex items-center gap-3">
                {r ? (
                  r.pass ? (
                    <CheckCircle2 className="size-4 text-ion" aria-label="Pass" />
                  ) : (
                    <XCircle className="size-4 text-danger" aria-label="Fail" />
                  )
                ) : (
                  <span className="size-4 rounded-full ring-1 ring-line-strong ring-inset" aria-label="Not run" />
                )}
                <span className="text-sm font-medium">{name}</span>
                {vec ? <Badge>{vec.direction}</Badge> : null}
                {vec?.port != null ? <span className="text-xs text-subtle">port {vec.port}</span> : null}
                <span className="ml-auto max-w-[40%] truncate font-mono text-xs text-subtle">{vec?.hex}</span>
              </div>
              {r && !r.pass ? (
                <div className="mt-3 grid gap-3 pl-7 md:grid-cols-2">
                  {r.diff?.length ? (
                    <ul className="text-[13px] text-danger md:col-span-2">
                      {r.diff.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  ) : null}
                  <div>
                    <p className="mb-1 text-xs text-subtle">Expected</p>
                    <JsonView value={r.expected} className="max-h-48" />
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-subtle">Actual</p>
                    <JsonView value={r.actual} className="max-h-48" />
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function Playground({ spec, id, version }: { spec: DeviceCodecSpec; id: string; version: string }) {
  const first = spec.vectors.find((v) => v.direction !== "downlink");
  const [hex, setHex] = React.useState(first?.hex ?? "");
  const [port, setPort] = React.useState(first?.port != null ? String(first.port) : "");
  const decode = useDecode();
  const result: DecodeResult | undefined = decode.data;
  const valid = isValidHex(hex);
  const layout = React.useMemo(() => {
    if (!result?.ok) return undefined;
    const def = findMessage(spec, result.message);
    return def ? messageLayout(def, hexBytes(hex).length).ranges : undefined;
  }, [result, spec, hex]);

  const run = () =>
    decode.mutate({ codecId: id, version, hex: hex.replace(/\s/g, ""), port: port ? Number(port) : undefined });

  return (
    <div className="flex flex-col gap-6">
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Decode a payload</PanelTitle>
            <PanelDescription>Paste hex from a device or log. Decoding runs on the server runtime.</PanelDescription>
          </div>
        </PanelHeader>
        <PanelBody>
          <form
            className="grid gap-4 md:grid-cols-[minmax(0,1fr)_140px_auto] md:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) run();
            }}
          >
            <Field>
              <Label htmlFor="pg-hex">Payload (hex)</Label>
              <Textarea
                id="pg-hex"
                value={hex}
                onChange={(e) => setHex(e.target.value)}
                className="min-h-12 font-mono text-[13px] uppercase"
                rows={2}
                spellCheck={false}
                aria-invalid={hex.length > 0 && !valid}
                placeholder="01 0A 3F 00 …"
              />
            </Field>
            <Field>
              <Label htmlFor="pg-port">Port</Label>
              <Input id="pg-port" type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="any" />
            </Field>
            <Button type="submit" variant="primary" size="lg" disabled={!valid || decode.isPending}>
              {decode.isPending ? <Spinner /> : <Play />}
              Decode
            </Button>
          </form>
          {spec.vectors.length ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-xs text-subtle">Try a vector:</span>
              {spec.vectors
                .filter((v) => v.direction !== "downlink")
                .slice(0, 6)
                .map((v) => (
                  <button
                    key={v.name}
                    type="button"
                    onClick={() => {
                      setHex(v.hex);
                      setPort(v.port != null ? String(v.port) : "");
                    }}
                    className="focus-ring cursor-pointer rounded-full px-2.5 py-1 text-xs text-muted ring-1 ring-line ring-inset hover:bg-hover hover:text-fg"
                  >
                    {v.name}
                  </button>
                ))}
            </div>
          ) : null}
        </PanelBody>
      </Panel>
      {decode.error ? (
        <Panel>
          <ApiError error={decode.error} />
        </Panel>
      ) : result ? (
        <Panel>
          <PanelHeader>
            <div>
              <PanelTitle className="flex items-center gap-2">
                {result.ok ? <CheckCircle2 className="size-4 text-ion" /> : <XCircle className="size-4 text-danger" />}
                {result.ok ? <span className="font-mono">{result.message}</span> : "Couldn’t decode"}
              </PanelTitle>
              <PanelDescription>{result.warnings.length ? `${result.warnings.length} warnings` : "No warnings"}</PanelDescription>
            </div>
          </PanelHeader>
          <PanelBody className="flex flex-col gap-4">
            {result.ok ? (
              <HexInspector hex={hex} data={result.data} ranges={layout} />
            ) : (
              <ul className="flex flex-col gap-2">
                {result.errors.map((e, i) => (
                  <li key={i} className={cn("rounded-control bg-danger/[0.07] px-4 py-3 text-sm ring-1 ring-danger/25 ring-inset")}>
                    <span className="font-mono text-xs text-danger">{e.code}</span>
                    {e.path ? <span className="ml-2 font-mono text-xs text-muted">{e.path}</span> : null}
                    <p className="mt-0.5">{e.message}</p>
                  </li>
                ))}
              </ul>
            )}
            {result.warnings.length ? (
              <Callout tone="ember" title="Warnings">
                <ul className="list-disc pl-4">
                  {result.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Callout>
            ) : null}
          </PanelBody>
        </Panel>
      ) : null}
      <p className="text-xs text-subtle">Codec {id}@{version}, {fmt.number(spec.uplink.length)} uplink messages.</p>
    </div>
  );
}

function StudioSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-80" />
        <Skeleton className="h-4 w-56" />
      </div>
      <Skeleton className="h-11" />
      <Skeleton className="h-96 rounded-panel" />
    </div>
  );
}
