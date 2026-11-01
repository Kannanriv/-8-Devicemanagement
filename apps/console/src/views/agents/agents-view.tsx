"use client";

import * as React from "react";
import { Bot, Play } from "lucide-react";
import { toast } from "sonner";
import type { AgentName, AgentRun } from "@hash8/sdk-ts";
import { PageHeader } from "@/components/page-header";
import { ApiError } from "@/components/query-state";
import { RunView } from "@/components/shell/copilot";
import { useShell } from "@/components/shell/shell-context";
import { Badge, Dot, type BadgeTone } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Panel, PanelBody, PanelDescription, PanelHeader, PanelTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, useAgents, useRunAgent } from "@/lib/api";
import { useAgentRuns } from "@/lib/api-v11";
import { AGENT_META, AGENT_NAMES, agentMeta, runText } from "@/lib/agents";
import { cn, fmt } from "@/lib/utils";

const RUN_TONE: Record<AgentRun["status"], BadgeTone> = { running: "signal", awaiting_approval: "ember", completed: "ion", failed: "danger" };

export function AgentsView() {
  const agents = useAgents();
  const runs = useAgentRuns();
  const run = useRunAgent();
  const { actions } = useShell();
  const [selected, setSelected] = React.useState<string>();

  const allRuns = React.useMemo(() => {
    const m = new Map<string, AgentRun>();
    for (const r of [...(runs.data ?? []), ...(agents.data?.runs ?? [])]) m.set(r.id, r);
    return [...m.values()].toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [runs.data, agents.data]);
  const pending = allRuns.filter((r) => r.status === "awaiting_approval");
  const sel = selected ?? pending[0]?.id ?? allRuns[0]?.id;

  const info = new Map((agents.data?.agents ?? []).map((a) => [a.name, a]));
  const names = AGENT_NAMES.filter((n) => !agents.data?.agents.length || info.has(n) || true);

  const start = (name: AgentName) => {
    if (name === "fleet-copilot") {
      actions.askCopilot();
      return;
    }
    run.mutate(
      { agent: name, input: { trigger: "console" } },
      {
        onSuccess: (r) => {
          setSelected(r.id);
          toast.success(`${agentMeta(name).title} started`);
        },
        onError: (e) => toast.error(`${agentMeta(name).title} didn’t start`, { description: errorMessage(e) }),
      },
    );
  };

  return (
    <>
      <PageHeader
        title="AI agents"
        description="Seven specialists that read specs, verify codecs, triage payloads and guard rollouts. They hand work to each other, and anything that changes devices waits for your approval."
        meta={pending.length ? <Badge tone="ember">{pending.length} waiting for approval</Badge> : null}
      />
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {names.map((n) => {
          const meta = AGENT_META[n];
          const Icon = meta.icon;
          const last = allRuns.find((r) => r.agent === n);
          const busy = run.isPending && run.variables?.agent === n;
          return (
            <li key={n} className="flex flex-col gap-3 rounded-card border border-line bg-panel p-5">
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-[13px] bg-raised ring-1 ring-line ring-inset">
                  <Icon className="size-[18px]" strokeWidth={1.6} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{info.get(n)?.title ?? meta.title}</p>
                  <p className="truncate text-xs text-subtle">{last ? `Last run ${fmt.ago(last.createdAt)}` : "No runs yet"}</p>
                </div>
              </div>
              <p className="text-[13px] leading-relaxed text-muted">{info.get(n)?.description ?? meta.description}</p>
              <Button size="sm" variant="secondary" className="mt-auto self-start" disabled={busy} onClick={() => start(n)}>
                {busy ? <Spinner /> : <Play />}
                {n === "fleet-copilot" ? "Open Copilot" : "Run"}
              </Button>
            </li>
          );
        })}
      </ul>

      <div className="mt-6 grid gap-6 xl:grid-cols-[400px_minmax(0,1fr)]">
        <Panel className="flex max-h-[70vh] flex-col overflow-hidden">
          <PanelHeader className="pb-2">
            <div>
              <PanelTitle>Runs</PanelTitle>
              <PanelDescription>Newest first, approvals on top</PanelDescription>
            </div>
          </PanelHeader>
          <div className="scrollbar-quiet min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {runs.isPending && agents.isPending ? (
              <div className="flex flex-col gap-2 p-3">
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="h-14" />
                ))}
              </div>
            ) : runs.error && agents.error ? (
              <ApiError error={runs.error} onRetry={() => void runs.refetch()} />
            ) : allRuns.length === 0 ? (
              <Empty icon={Bot} title="No runs yet">
                Start an agent above, or ask Copilot with ⌘J.
              </Empty>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {[...pending, ...allRuns.filter((r) => r.status !== "awaiting_approval")].map((r) => {
                  const meta = agentMeta(r.agent);
                  const collaborators = [...new Set(r.steps.map((s) => s.agent))].filter((a) => a !== r.agent);
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(r.id)}
                        className={cn(
                          "focus-ring flex w-full cursor-pointer flex-col gap-1 rounded-[14px] px-3 py-2.5 text-left transition-colors",
                          sel === r.id ? "bg-raised ring-1 ring-line ring-inset" : "hover:bg-hover",
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{meta.title}</span>
                          <Badge tone={RUN_TONE[r.status]} className="ml-auto">
                            {r.status === "running" ? <Dot tone="signal" live className="size-1.5 [&>span]:size-1.5" /> : null}
                            {r.status === "awaiting_approval" ? "Needs approval" : fmt.label(r.status)}
                          </Badge>
                        </span>
                        <span className="truncate text-xs text-subtle">
                          {fmt.ago(r.createdAt)}, {r.steps.length} steps
                          {collaborators.length ? `, with ${collaborators.map((c) => agentMeta(c).title).join(", ")}` : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Panel>
        <Panel className="min-w-0">
          {sel ? (
            <>
              <PanelHeader>
                <div className="min-w-0">
                  <PanelTitle>{agentMeta(allRuns.find((r) => r.id === sel)?.agent ?? "").title} run</PanelTitle>
                  <PanelDescription className="font-mono">{sel}</PanelDescription>
                </div>
              </PanelHeader>
              <PanelBody className="flex flex-col gap-5">
                <RunInput run={allRuns.find((r) => r.id === sel)} />
                <RunView runId={sel} />
              </PanelBody>
            </>
          ) : (
            <Empty icon={Bot} title="Select a run" className="py-20">
              The step trace shows which agents collaborated and what each one did.
            </Empty>
          )}
        </Panel>
      </div>
    </>
  );
}

function RunInput({ run }: { run?: AgentRun }) {
  if (!run || !Object.keys(run.input ?? {}).length) return null;
  const text = runText(run.input);
  return (
    <div className="rounded-control bg-sunken/60 px-4 py-3 text-[13px] ring-1 ring-line ring-inset">
      <p className="mb-1 text-xs text-subtle">Asked</p>
      {text ?? (
        <span className="font-mono text-xs text-muted">
          {Object.entries(run.input)
            .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
            .join(", ")}
        </span>
      )}
    </div>
  );
}
