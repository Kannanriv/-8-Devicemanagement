import * as React from "react";
import { cn } from "@/lib/utils";

const field =
  "focus-ring w-full min-w-0 rounded-control border border-line bg-sunken/60 px-3.5 text-sm text-fg placeholder:text-subtle transition-colors duration-200 hover:border-line-strong disabled:opacity-50 aria-invalid:border-danger/60";

export function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" type={type} className={cn(field, "h-10", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(field, "min-h-24 py-2.5 leading-relaxed", className)} {...props} />;
}

/** Native select styled to match — keyboard/a11y friendly; ideal in dense filter bars and forms. */
export function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div className={cn("relative", className)}>
      <select data-slot="select" className={cn(field, "h-10 cursor-pointer appearance-none pr-9")} {...props}>
        {children}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-subtle"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      >
        <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn("text-[13px] font-medium text-muted", className)} {...props} />;
}

export function Field({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field" className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

export function FieldHint({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-xs text-subtle", className)} {...props} />;
}

export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-line bg-hover px-1.5 font-sans text-[11px] font-medium text-muted",
        className,
      )}
      {...props}
    />
  );
}
