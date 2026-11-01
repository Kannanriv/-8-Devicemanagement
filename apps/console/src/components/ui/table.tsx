import * as React from "react";
import { cn } from "@/lib/utils";

export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="scrollbar-quiet w-full overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  );
}
export function THead({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead className={cn("[&_tr]:border-b [&_tr]:border-line [&_tr]:hover:bg-transparent", className)} {...props} />;
}
export function TBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}
export function TR({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      className={cn("border-b border-line transition-colors hover:bg-hover data-[state=selected]:bg-signal/[0.06]", className)}
      {...props}
    />
  );
}
export function TH({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-10 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-subtle first:pl-6 last:pr-6 sm:first:pl-7 sm:last:pr-7",
        className,
      )}
      {...props}
    />
  );
}
export function TD({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("h-13 px-3 align-middle first:pl-6 last:pr-6 sm:first:pl-7 sm:last:pr-7", className)} {...props} />;
}
