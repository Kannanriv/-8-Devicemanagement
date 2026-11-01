"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ArrowUp, Check, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import type { AgentRun } from "@hash8/sdk-ts";
import { AgentTrace } from "@/components/agent-trace";
import { ApiError } from "@/components/query-state";
import { Button, Spinner } from "@/components/ui/button";
import { SheetContent } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/input";
import { errorMessage, useAgentRun, useApproveRun, useRunAgent } from "@/lib/api";
import { runText } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { useShell } from "./shell-context";

interface Turn {
  id: string;
  prompt: string;
  runId?: string;
  error?: unknown;
}

const SUGGESTIONS = [
  "Which devices went offline in the last 24 hours?",
  "Why is the current OTA rollout failing?",
  "Summarise unknown payloads and propose a fix",
  "Which cohort has the most config drift?",
];

export function CopilotDrawer() {
  const { state, actions } = useShell();
  const pathname = usePathname();
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [draft, setDraft] = React.useState("");
  const run = useRunAgent();
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const send = React.useCallback(
    (prompt: string) => {
      const p = prompt.trim();
      if (!p) return;
      const id = `${Date.now()}`;
      setTurns((t) => [...t, { id, prompt: p }]);
      setDraft("");
      run.mutate(
        { agent: "fleet-copilot", input: { prompt: p, question: p, context: { route: pathname } } },
        {
          onSuccess: (r) => setTurns((t) => t.map((x) => (x.id === id ? { ...x, runId: r.id } : x))),
          onError: (e) => setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: e } : x))),
        },
      );
    },
    [pathname, run],
  );

  // Prompt handed over from the palette / an Ops card.
  React.useEffect(() => {
    if (!state.copilotOpen || !state.copilotDraft) return;
    const d = actions.consumeDraft();
    if (d) send(d);
  }, [state.copilotOpen, state.copilotDraft, actions, send]);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns.length]);

  return (
    <DialogPrimitive.Root open={state.copilotOpen} onOpenChange={actions.setCopilotOpen}>
      <SheetContent aria-describedby={undefined}>
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          <span className="relative flex size-9 items-center justify-center rounded-full bg-raised ring-1 ring-line ring-inset">
            <Sparkles className="size-4 text-signal" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogPrimitive.Title className="text-[15px] font-semibold tracking-[-0.015em]">Fleet Copilot</DialogPrimitive.Title>
            <p className="text-xs text-muted">Coordinates the other agents. Actions that change devices wait for your approval.</p>
          </div>
          <DialogPrimitive.Close asChild>
            <Button variant="ghost" size="icon" aria-label="Close Copilot">
              <X />
            </Button>
          </DialogPrimitive.Close>
        </div>

        <div ref={scrollRef} className="scrollbar-quiet flex-1 overflow-y-auto px-6 py-6" aria-live="polite">
          {turns.length === 0 ? (
            <div className="flex h-full flex-col justify-end gap-6">
              <div>
                <p className="text-[22px] leading-tight font-semibold tracking-[-0.025em]">What needs doing?</p>
                <p className="mt-1.5 text-sm text-muted">Ask about devices, rollouts, codecs or alerts.</p>
              </div>
              <div className="flex flex-col gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    className="focus-ring cursor-pointer rounded-control px-4 py-3 text-left text-sm text-muted ring-1 ring-line ring-inset transition-colors hover:bg-hover hover:text-fg"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-8">
              {turns.map((t) => (
                <div key={t.id} className="flex flex-col gap-4">
                  <div className="ml-auto max-w-[85%] rounded-[20px] rounded-br-md bg-inverse px-4 py-2.5 text-sm text-inverse-fg">
                    {t.prompt}
                  </div>
                  {t.error ? (
                    <ApiError error={t.error} compact />
                  ) : t.runId ? (
                    <RunView runId={t.runId} />
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-muted">
                      <Spinner /> Starting…
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <form
          className="border-t border-line p-4"
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
        >
          <div className="flex items-end gap-2 rounded-[22px] bg-sunken/60 p-1.5 pl-4 ring-1 ring-line ring-inset focus-within:ring-signal/50">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              rows={1}
              placeholder="Ask Fleet Copilot…"
              aria-label="Message Fleet Copilot"
              className="max-h-40 min-h-9 flex-1 resize-none bg-transparent py-2 text-sm text-fg outline-none placeholder:text-subtle"
            />
            <Button type="submit" variant="primary" size="icon" disabled={!draft.trim() || run.isPending} aria-label="Send">
              {run.isPending ? <Spinner /> : <ArrowUp />}
            </Button>
          </div>
          <p className="mt-2 px-1 text-xs text-subtle">
            <Kbd>Enter</Kbd> to send, <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> for a new line
          </p>
        </form>
      </SheetContent>
    </DialogPrimitive.Root>
  );
}

export function RunView({ runId, className }: { runId: string; className?: string }) {
  const q = useAgentRun(runId);
  const approve = useApproveRun();
  const run: AgentRun | undefined = q.data;
  if (q.error) return <ApiError error={q.error} compact />;
  if (!run)
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner /> Thinking…
      </div>
    );
  const text = runText(run.output);
  const running = run.status === "running";
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <AgentTrace steps={run.steps} running={running} />
      {text ? <p className="text-[14.5px] leading-relaxed whitespace-pre-wrap text-fg">{text}</p> : null}
      {!text && run.output && !running ? (
        <pre className="scrollbar-quiet overflow-x-auto rounded-control bg-sunken/60 p-3 font-mono text-xs text-muted ring-1 ring-line ring-inset">
          {JSON.stringify(run.output, null, 2)}
        </pre>
      ) : null}
      {run.status === "failed" ? <p className="text-sm text-danger">This run failed. Try rephrasing, or check the agent log.</p> : null}
      {run.status === "awaiting_approval" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-control bg-ember/[0.07] px-4 py-3 ring-1 ring-ember/25 ring-inset">
          <p className="flex-1 text-sm">This run wants to make changes. Review the steps above, then approve.</p>
          <Button
            size="sm"
            variant="primary"
            disabled={approve.isPending}
            onClick={() =>
              approve.mutate(run.id, {
                onSuccess: () => toast.success("Approved"),
                onError: (e) => toast.error("Approval failed", { description: errorMessage(e) }),
              })
            }
          >
            {approve.isPending ? <Spinner /> : <Check />}
            Approve
          </Button>
        </div>
      ) : null}
    </div>
  );
}
