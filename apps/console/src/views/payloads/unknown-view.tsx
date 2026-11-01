"use client";

import * as React from "react";
import { CheckCircle2, RefreshCcw, Unplug } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { RunView } from "@/components/shell/copilot";
import { Badge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, useRedecode, useRunAgent, useUnknownPayloads, type UnknownCluster } from "@/lib/api";
import { cn, fmt, hexBytes } from "@/lib/utils";

export function UnknownView() {
  const q = useUnknownPayloads();
  const redecode = useRedecode();
  const runAgent = useRunAgent();
  const [selected, setSelected] = React.useState<string>();
  const [runs, setRuns] = React.useState<Record<string, string>>({});
  const list = q.data ?? [];
  const sel = list.find((c) => c.id === selected) ?? list[0];
  const total = list.reduce((a, c) => a + c.count, 0);

  const triage = (c?: UnknownCluster) =>
    runAgent.mutate(
      {
        agent: "payload-triage",
        input: c ? { clusterId: c.id, signature: c.signature, sampleHex: c.sampleHex, port: c.port, deviceIds: c.deviceIds.slice(0, 20) } : { scope: "all" },
      },
      {
        onSuccess: (r) => setRuns((m) => ({ ...m, [c?.id ?? "__all"]: r.id })),
        onError: (e) => toast.error("Payload Triage didn’t start", { description: errorMessage(e) }),
      },
    );

  return (
    <>
      <PageHeader
        title="Unknown payloads"
        description="Uplinks no codec could decode, clustered by shape. Triage proposes the message layout; re-decode once a codec covers it."
        meta={q.data ? <Badge tone={total ? "ember" : "ion"}>{total ? `${fmt.number(total)} payloads in ${list.length} clusters` : "Everything decodes"}</Badge> : null}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={redecode.isPending}
              onClick={() =>
                redecode.mutate(
                  {},
                  {
                    onSuccess: (r) => toast.success("Re-decode finished", { description: summarize(r) }),
                    onError: (e) => toast.error("Re-decode failed", { description: errorMessage(e) }),
                  },
                )
              }
            >
              {redecode.isPending ? <Spinner /> : <RefreshCcw />}
              Re-decode all
            </Button>
            <Button variant="primary" disabled={runAgent.isPending || !list.length} onClick={() => triage()}>
              Ask Payload Triage
            </Button>
          </>
        }
      />
      {runs.__all ? (
        <Panel className="mb-6">
          <PanelHeader>
            <PanelTitle>Payload Triage</PanelTitle>
          </PanelHeader>
          <PanelBody>
            <RunView runId={runs.__all} />
          </PanelBody>
        </Panel>
      ) : null}
      {q.isPending ? (
        <div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
          <Skeleton className="h-96 rounded-panel" />
          <Skeleton className="h-96 rounded-panel" />
        </div>
      ) : q.error ? (
        <Panel>
          <ApiError error={q.error} onRetry={() => void q.refetch()} />
        </Panel>
      ) : list.length === 0 ? (
        <Panel>
          <Empty icon={CheckCircle2} title="No unknown payloads">
            Every uplink matched a published codec.
          </Empty>
        </Panel>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
          <Panel className="overflow-hidden">
            <PanelHeader className="pb-2">
              <PanelTitle>Clusters</PanelTitle>
            </PanelHeader>
            <ul className="flex flex-col gap-0.5 px-3 pb-3">
              {list.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(c.id)}
                    className={cn(
                      "focus-ring flex w-full cursor-pointer flex-col gap-1.5 rounded-[14px] px-3 py-3 text-left transition-colors",
                      sel?.id === c.id ? "bg-raised ring-1 ring-line ring-inset" : "hover:bg-hover",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Unplug className="size-3.5 text-ember" />
                      <span className="text-sm font-medium tabular">{fmt.number(c.count)} payloads</span>
                      <span className="text-xs text-subtle">from {fmt.number(c.devices)} devices</span>
                      <span className="ml-auto text-xs text-subtle">{fmt.ago(c.lastSeenAt)}</span>
                    </span>
                    <span className="truncate font-mono text-xs text-muted">{c.sampleHex}</span>
                    <span className="flex gap-1.5">
                      {c.port != null ? <Badge>port {c.port}</Badge> : null}
                      {c.length != null ? <Badge>{c.length} bytes</Badge> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
          {sel ? (
            <Panel className="min-w-0">
              <PanelHeader>
                <div className="min-w-0">
                  <PanelTitle className="font-mono">{sel.signature}</PanelTitle>
                  <PanelDescription>
                    First seen {fmt.ago(sel.firstSeenAt)}, last {fmt.ago(sel.lastSeenAt)}
                  </PanelDescription>
                </div>
                <Button size="sm" variant="primary" disabled={runAgent.isPending} onClick={() => triage(sel)}>
                  {runAgent.isPending ? <Spinner /> : null}
                  Ask Payload Triage
                </Button>
              </PanelHeader>
              <PanelBody className="flex flex-col gap-5">
                <div className="rounded-card bg-sunken/60 p-4 ring-1 ring-line ring-inset">
                  <p className="mb-3 text-xs text-subtle">Sample, byte by byte</p>
                  <div className="flex flex-wrap gap-1 font-mono text-[13px]">
                    {hexBytes(sel.sampleHex).map((b, i) => (
                      <span key={i} title={`byte ${i}`} className="inline-flex h-7 w-8 items-center justify-center rounded-[8px] bg-hover tabular">
                        {b}
                      </span>
                    ))}
                  </div>
                </div>
                {sel.deviceIds.length ? (
                  <div>
                    <p className="mb-2 text-xs text-subtle">Devices sending this shape</p>
                    <div className="flex flex-wrap gap-1.5">
                      {sel.deviceIds.slice(0, 24).map((d) => (
                        <a key={d} href={`/devices/${d}#messages`} className="focus-ring rounded-full">
                          <Badge className="font-mono hover:text-fg">{d}</Badge>
                        </a>
                      ))}
                    </div>
                  </div>
                ) : null}
                {runs[sel.id] ? (
                  <div className="rounded-card border border-line bg-sunken/50 p-4">
                    <RunView runId={runs[sel.id]!} />
                  </div>
                ) : null}
              </PanelBody>
            </Panel>
          ) : null}
        </div>
      )}
    </>
  );
}

function summarize(r: unknown) {
  if (r && typeof r === "object") {
    const o = r as Record<string, unknown>;
    const parts = ["decoded", "remaining", "failed", "processed"].filter((k) => typeof o[k] === "number").map((k) => `${o[k]} ${k}`);
    if (parts.length) return parts.join(", ");
  }
  return undefined;
}
