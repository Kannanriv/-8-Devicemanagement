import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "focus-ring relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium tracking-[-0.01em] transition-[background-color,color,box-shadow,transform,opacity] duration-200 ease-out-soft active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-inverse text-inverse-fg hover:opacity-90",
        accent: "bg-signal text-white hover:bg-signal/90 shadow-[0_8px_24px_-10px_var(--signal)]",
        secondary: "bg-raised text-fg ring-1 ring-line ring-inset hover:bg-press",
        ghost: "text-muted hover:bg-hover hover:text-fg",
        outline: "text-fg ring-1 ring-line-strong ring-inset hover:bg-hover",
        danger: "bg-danger/12 text-danger ring-1 ring-danger/30 ring-inset hover:bg-danger/18",
      },
      size: {
        sm: "h-8 px-3.5 text-[13px] [&_svg]:size-3.5",
        md: "h-10 px-4.5 text-sm [&_svg]:size-4",
        lg: "h-12 px-6 text-[15px] [&_svg]:size-4.5",
        icon: "size-9 [&_svg]:size-4",
        "icon-sm": "size-7 [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends React.ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      type={asChild ? undefined : (type ?? "button")}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn("inline-block size-3.5 animate-spin rounded-full border-[1.5px] border-current border-r-transparent", className)}
    />
  );
}
