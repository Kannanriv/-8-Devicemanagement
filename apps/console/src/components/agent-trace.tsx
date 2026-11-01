import type { AgentRun } from "@hash8/sdk-ts";
import { agentMeta } from "@/lib/agents";
import { cn, fmt } from "@/lib/utils";

/** Vertical step trace showing which agents collaborated on a run. */
export function AgentTrace({ steps, running, className }: { steps: AgentRun["steps"]; running?: boolean; className?: string }) {
  if (!steps.length && !running) return null;
  return (
    <ol className={cn("relative flex flex-col gap-3", className)} aria-label="Agent steps">
      {steps.map((s, i) => {
        const meta = agentMeta(s.agent);
        const Icon = meta.icon;
        const last = i === steps.length - 1 && !running;
        return (
          <li key={`${s.at}-${i}`} className="relative flex gap-3">
            {!last ? <span aria-hidden className="absolute top-7 bottom-[-12px] left-[13px] w-px bg-line" /> : null}
            <span className="relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full bg-raised ring-1 ring-line ring-inset">
              <Icon className="size-3.5 text-muted" />
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="text-[13px]">
                <span className="font-medium text-fg">{meta.title}</span>
                <span className="ml-2 text-xs text-subtle tabular">{fmt.time(s.at)}</span>
              </p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{s.note}</p>
            </div>
          </li>
        );
      })}
      {running ? (
        <li className="flex items-center gap-3">
          <span className="relative flex size-7 items-center justify-center">
            <span className="absolute inset-1 animate-pulse-ring rounded-full bg-signature opacity-60" />
            <span className="size-2 rounded-full bg-signature" />
          </span>
          <span className="text-[13px] text-muted">Working…</span>
        </li>
      ) : null}
    </ol>
  );
}
