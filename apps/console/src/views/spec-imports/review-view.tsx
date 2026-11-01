"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Send, ShieldCheck, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { JsonView } from "@/components/hex-inspector";
import { LOW_CONFIDENCE, SpecFieldsTable } from "@/components/spec-fields";
import { RunView } from "@/components/shell/copilot";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Callout, Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, usePublishCodec, useRunAgent, useSpecImport } from "@/lib/api";
import { fieldRows } from "@/lib/dcs";
import { fmt } from "@/lib/utils";
import { PluginMenu } from "@/views/codecs/spec-studio";
import { JobStatus } from "./spec-imports-view";

export function ReviewView({ id }: { id: string }) {
  const job = useSpecImport(id);
  const publish = usePublishCodec();
  const runAgent = useRunAgent();
  const [runId, setRunId] = React.useState<string>();

  const stats = React.useMemo(() => {
    const spec = job.data?.spec;
    if (!spec) return null;
    let total = 0;
    let low = 0;
    for (const m of [...spec.uplink, ...(spec.downlink ?? [])]) {
      for (const r of fieldRows(m.fields)) {
        if (r.kind === "group" || r.kind === "repeat" || r.kind === "switch") continue;
        total++;
        if (r.source?.confidence != null && r.source.confidence < LOW_CONFIDENCE) low++;
      }
    }
    return { total, low };
  }, [job.data?.spec]);

  if (job.isPending)
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-24 w-96" />
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Skeleton className="h-[60vh] rounded-panel" />
          <Skeleton className="h-[60vh] rounded-panel" />
        </div>
      </div>
    );
  if (job.error || !job.data)
    return (
      <>
        <PageHeader title="Spec review" back={{ href: "/spec-imports", label: "Spec imports" }} />
        <Panel>
          <ApiError error={job.error} onRetry={() => void job.refetch()} />
        </Panel>
      </>
    );

  const j = job.data;
  const spec = j.spec;
  const busy = j.status === "parsing" || j.status === "extracting";
  const canPublish = !!j.codecId && !!j.draftVersion && j.status === "review";
  const messages = spec ? [...spec.uplink.map((m) => ({ m, dir: "Uplink" })), ...(spec.downlink ?? []).map((m) => ({ m, dir: "Downlink" }))] : [];

  return (
    <>
      <PageHeader
        back={{ href: "/spec-imports", label: "Spec imports" }}
        title={spec ? `${spec.device.vendor} ${spec.device.model}` : j.fileName}
        description={`From ${j.fileName}, uploaded ${fmt.ago(j.createdAt)}`}
        meta={
          <>
            <JobStatus status={j.status} />
            {j.confidence != null ? (
              <Badge tone={j.confidence < LOW_CONFIDENCE ? "ember" : "ion"}>{fmt.pct(j.confidence)} mean confidence</Badge>
            ) : null}
            {stats ? (
              <Badge tone={stats.low ? "ember" : "neutral"}>
                {stats.low} of {stats.total} fields need a look
              </Badge>
            ) : null}
          </>
        }
        actions={
          <>
            {j.codecId && j.draftVersion ? <PluginMenu id={j.codecId} version={j.draftVersion} /> : null}
            {j.codecId ? (
              <Button variant="secondary" asChild>
                <Link href={`/codecs/${encodeURIComponent(j.codecId)}`}>
                  Open in Spec Studio
                  <ArrowUpRight />
                </Link>
              </Button>
            ) : null}
            <Button
              variant="accent"
              disabled={!canPublish || publish.isPending}
              onClick={() =>
                publish.mutate(
                  { id: j.codecId!, version: j.draftVersion! },
                  {
                    onSuccess: () => {
                      toast.success("Codec published", { description: "Devices on this model now decode with it." });
                      void job.refetch();
                    },
                    onError: (e) => toast.error("Publish blocked", { description: errorMessage(e) }),
                  },
                )
              }
            >
              {publish.isPending ? <Spinner /> : <Send />}
              Publish
            </Button>
          </>
        }
      />

      {busy ? (
        <Callout tone="signal" icon={ShieldCheck} title={j.status === "parsing" ? "Reading the workbook…" : "Extracting messages and fields…"} className="mb-6">
          This page updates on its own when the draft is ready.
        </Callout>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {messages.length === 0 ? (
            <Panel>
              <Empty icon={ShieldCheck} title={busy ? "Draft in progress" : "No draft produced"}>
                {busy ? "Fields will appear here grouped by message." : "Check the issues list for what went wrong."}
              </Empty>
            </Panel>
          ) : (
            messages.map(({ m, dir }) => (
              <Panel key={`${dir}-${m.name}`} className="overflow-hidden">
                <PanelHeader>
                  <div>
                    <PanelTitle className="flex items-center gap-2">
                      <span className="font-mono">{m.name}</span>
                      <Badge>{dir}</Badge>
                    </PanelTitle>
                    {m.description ? <PanelDescription>{m.description}</PanelDescription> : null}
                  </div>
                </PanelHeader>
                <div className="pb-3">
                  <SpecFieldsTable msg={m} highlightLow />
                </div>
              </Panel>
            ))
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6 xl:sticky xl:top-24 xl:self-start">
          <Panel>
            <PanelHeader>
              <div>
                <PanelTitle>Issues</PanelTitle>
                <PanelDescription>{j.issues.length ? "Resolve or accept before publishing" : "Nothing flagged"}</PanelDescription>
              </div>
              <Button
                size="sm"
                variant="primary"
                disabled={runAgent.isPending}
                onClick={() =>
                  runAgent.mutate(
                    { agent: "codec-verifier", input: { specImportId: j.id, codecId: j.codecId, version: j.draftVersion } },
                    {
                      onSuccess: (r) => setRunId(r.id),
                      onError: (e) => toast.error("Codec Verifier didn’t start", { description: errorMessage(e) }),
                    },
                  )
                }
              >
                {runAgent.isPending ? <Spinner /> : <ShieldCheck />}
                Ask Codec Verifier
              </Button>
            </PanelHeader>
            <PanelBody className="flex flex-col gap-3">
              {j.issues.length ? (
                <ul className="scrollbar-quiet flex max-h-72 flex-col gap-2 overflow-y-auto">
                  {j.issues.map((i) => (
                    <li key={i} className="flex gap-2.5 rounded-control bg-ember/[0.07] px-3.5 py-2.5 text-[13px] ring-1 ring-ember/20 ring-inset">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-ember" />
                      {i}
                    </li>
                  ))}
                </ul>
              ) : null}
              {runId ? (
                <div className="rounded-card border border-line bg-sunken/50 p-4">
                  <RunView runId={runId} />
                </div>
              ) : null}
            </PanelBody>
          </Panel>
          <Panel>
            <PanelHeader>
              <div>
                <PanelTitle>Draft DCS</PanelTitle>
                <PanelDescription>{j.codecId ? `${j.codecId}@${j.draftVersion ?? "draft"}` : "Device Codec Spec JSON"}</PanelDescription>
              </div>
            </PanelHeader>
            <PanelBody>{spec ? <JsonView value={spec} className="max-h-[52vh]" /> : <Skeleton className="h-64" />}</PanelBody>
          </Panel>
        </div>
      </div>
    </>
  );
}
