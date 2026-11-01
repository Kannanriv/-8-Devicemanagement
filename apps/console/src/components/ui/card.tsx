import * as React from "react";
import { cn } from "@/lib/utils";

/** Primary surface. 28px radius for page-level panels; `Card` (20px) for nested items. */
export function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return <section data-slot="panel" className={cn("rounded-panel border border-line bg-panel", className)} {...props} />;
}

export function PanelHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      data-slot="panel-header"
      className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-6 pt-5 pb-4 sm:px-7", className)}
      {...props}
    />
  );
}

export function PanelTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 className={cn("text-[15px] font-semibold tracking-[-0.015em] text-fg", className)} {...props} />;
}

export function PanelDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("mt-0.5 text-[13px] text-muted", className)} {...props} />;
}

export function PanelBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-6 pb-6 sm:px-7", className)} {...props} />;
}

export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card" className={cn("rounded-card border border-line bg-raised/60", className)} {...props} />;
}
