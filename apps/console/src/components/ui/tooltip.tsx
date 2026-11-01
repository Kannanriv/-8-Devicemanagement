"use client";

import * as React from "react";
import { Tooltip as T } from "radix-ui";

export const TooltipProvider = T.Provider;

export function Tooltip({
  content,
  children,
  side = "top",
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={8}
          className="z-50 max-w-xs rounded-[10px] bg-inverse px-2.5 py-1.5 text-xs font-medium text-inverse-fg shadow-float data-[state=delayed-open]:animate-enter"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
