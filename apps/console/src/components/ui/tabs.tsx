"use client";

import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn("scrollbar-quiet flex items-center gap-1 overflow-x-auto border-b border-line", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "focus-ring relative -mb-px inline-flex h-11 cursor-pointer items-center gap-2 whitespace-nowrap rounded-t-[10px] px-3.5 text-sm font-medium text-muted transition-colors hover:text-fg data-[state=active]:text-fg [&_svg]:size-4",
        "after:absolute after:inset-x-3 after:bottom-0 after:h-[2px] after:rounded-full after:bg-transparent after:transition-colors data-[state=active]:after:bg-fg",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("animate-enter pt-6 outline-none", className)} {...props} />;
}

/** Compact segmented control (2–6 options). */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  className,
  label,
}: {
  value: T;
  onValueChange: (v: T) => void;
  options: { value: T; label: React.ReactNode }[];
  className?: string;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex rounded-full bg-hover p-1 ring-1 ring-line ring-inset", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onValueChange(o.value)}
          className={cn(
            "focus-ring inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-muted transition-colors [&_svg]:size-3.5",
            value === o.value ? "bg-raised text-fg shadow-[0_1px_2px_rgb(0_0_0/0.2)] ring-1 ring-line ring-inset" : "hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
