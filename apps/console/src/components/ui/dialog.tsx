"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

function Overlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn("fixed inset-0 z-50 bg-overlay backdrop-blur-[6px] data-[state=open]:animate-enter", className)}
      {...props}
    />
  );
}

export function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      <DialogPrimitive.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[min(88vh,820px)] w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-panel border border-line-strong bg-panel shadow-float outline-none",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="focus-ring absolute top-4 right-4 inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg">
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1 px-7 pt-6 pr-14 pb-2", className)} {...props} />;
}
export function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("scrollbar-quiet flex flex-col gap-4 overflow-y-auto px-7 py-4", className)} {...props} />;
}
export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-wrap items-center justify-end gap-2 border-t border-line px-7 py-4", className)} {...props} />;
}
export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-lg font-semibold tracking-[-0.02em]", className)} {...props} />;
}
export function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-sm text-muted", className)} {...props} />;
}

/** Right-hand sheet (Copilot, detail drawers). */
export function SheetContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <Overlay className="backdrop-blur-[2px]" />
      <DialogPrimitive.Content
        className={cn(
          "fixed inset-y-2 right-2 z-50 flex w-[calc(100vw-16px)] max-w-[540px] flex-col overflow-hidden rounded-panel border border-line-strong bg-panel shadow-float outline-none data-[state=open]:animate-sheet-in",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
