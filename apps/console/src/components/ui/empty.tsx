import * as React from "react";
import { cn } from "@/lib/utils";

type IconType = React.ComponentType<{ className?: string; strokeWidth?: number }>;

/** Empty / zero-state: an invitation to act. */
export function Empty({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon?: IconType;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 px-6 py-14 text-center", className)}>
      {Icon ? (
        <div className="mb-1 flex size-12 items-center justify-center rounded-2xl bg-hover ring-1 ring-line ring-inset">
          <Icon className="size-5 text-muted" strokeWidth={1.6} />
        </div>
      ) : null}
      <p className="text-[15px] font-semibold tracking-[-0.015em]">{title}</p>
      {children ? <div className="max-w-sm text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

const calloutTones = {
  neutral: "bg-hover ring-line [&>svg]:text-muted",
  ember: "bg-ember/[0.07] ring-ember/25 [&>svg]:text-ember",
  danger: "bg-danger/[0.07] ring-danger/25 [&>svg]:text-danger",
  ion: "bg-ion/[0.07] ring-ion/25 [&>svg]:text-ion",
  signal: "bg-signal/[0.07] ring-signal/25 [&>svg]:text-signal",
};

/** Inline callout for contextual guidance / warnings. */
export function Callout({
  tone = "neutral",
  icon: Icon,
  title,
  children,
  className,
}: {
  tone?: keyof typeof calloutTones;
  icon?: IconType;
  title?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div role="note" className={cn("flex gap-3 rounded-control px-4 py-3 text-sm ring-1 ring-inset", calloutTones[tone], className)}>
      {Icon ? <Icon className="mt-0.5 size-4 shrink-0" /> : null}
      <div className="min-w-0">
        {title ? <p className="font-medium text-fg">{title}</p> : null}
        {children ? <div className="text-muted">{children}</div> : null}
      </div>
    </div>
  );
}
