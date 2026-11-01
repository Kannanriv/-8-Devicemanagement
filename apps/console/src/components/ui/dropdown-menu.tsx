"use client";

import * as React from "react";
import { DropdownMenu as Menu } from "radix-ui";
import { cn } from "@/lib/utils";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;
export const DropdownMenuRadioGroup = Menu.RadioGroup;

export function DropdownMenuContent({ className, sideOffset = 8, ...props }: React.ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-48 overflow-hidden rounded-[18px] border border-line-strong bg-raised p-1.5 shadow-float data-[state=open]:animate-enter",
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

const item =
  "relative flex cursor-pointer select-none items-center gap-2.5 rounded-[12px] px-2.5 py-2 text-sm text-fg outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-hover [&_svg]:size-4 [&_svg]:text-muted";

export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof Menu.Item>) {
  return <Menu.Item className={cn(item, className)} {...props} />;
}
export function DropdownMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof Menu.RadioItem>) {
  return (
    <Menu.RadioItem className={cn(item, "pr-8", className)} {...props}>
      {children}
      <Menu.ItemIndicator className="absolute right-3 size-1.5 rounded-full bg-signal" />
    </Menu.RadioItem>
  );
}
export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof Menu.Label>) {
  return <Menu.Label className={cn("px-2.5 pt-2 pb-1 text-xs text-subtle", className)} {...props} />;
}
export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn("-mx-1.5 my-1.5 h-px bg-line", className)} {...props} />;
}
