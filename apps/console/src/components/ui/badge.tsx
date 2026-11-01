import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium leading-5 tracking-[-0.005em] [&_svg]:size-3",
  {
    variants: {
      tone: {
        neutral: "bg-hover text-muted ring-1 ring-line ring-inset",
        signal: "bg-signal/12 text-signal ring-1 ring-signal/25 ring-inset",
        ion: "bg-ion/12 text-ion ring-1 ring-ion/25 ring-inset",
        ember: "bg-ember/12 text-ember ring-1 ring-ember/25 ring-inset",
        danger: "bg-danger/12 text-danger ring-1 ring-danger/25 ring-inset",
        solid: "bg-inverse text-inverse-fg",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

export function Badge({ className, tone, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />;
}

const dotColor: Record<BadgeTone, string> = {
  neutral: "bg-subtle",
  signal: "bg-signal",
  ion: "bg-ion",
  ember: "bg-ember",
  danger: "bg-danger",
  solid: "bg-fg",
};

/** A small status dot, optionally pulsing (live). */
export function Dot({ tone = "neutral", live, className }: { tone?: BadgeTone; live?: boolean; className?: string }) {
  const color = dotColor[tone];
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} aria-hidden>
      {live ? <span className={cn("absolute inset-0 animate-pulse-ring rounded-full", color)} /> : null}
      <span className={cn("relative inline-flex size-2 rounded-full", color)} />
    </span>
  );
}
