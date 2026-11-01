"use client";

import * as React from "react";
import { Switch as S, Checkbox as C } from "radix-ui";
import { Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: React.ComponentProps<typeof S.Root>) {
  return (
    <S.Root
      className={cn(
        "focus-ring inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full bg-press p-0.5 ring-1 ring-line ring-inset transition-colors data-[state=checked]:bg-ion disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <S.Thumb className="block size-5 rounded-full bg-fg shadow transition-transform duration-200 ease-out-soft data-[state=checked]:translate-x-4 data-[state=checked]:bg-white" />
    </S.Root>
  );
}

export function Checkbox({ className, ...props }: React.ComponentProps<typeof C.Root>) {
  return (
    <C.Root
      className={cn(
        "focus-ring peer inline-flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded-[6px] border border-line-strong bg-sunken/60 transition-colors data-[state=checked]:border-signal data-[state=checked]:bg-signal data-[state=indeterminate]:border-signal data-[state=indeterminate]:bg-signal",
        className,
      )}
      {...props}
    >
      <C.Indicator className="text-white">
        {props.checked === "indeterminate" ? (
          <Minus className="size-3" strokeWidth={3} />
        ) : (
          <Check className="size-3" strokeWidth={3} />
        )}
      </C.Indicator>
    </C.Root>
  );
}
