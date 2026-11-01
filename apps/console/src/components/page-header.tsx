import * as React from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  back,
  meta,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-5 pb-8 md:flex-row md:items-end md:justify-between", className)}>
      <div className="min-w-0">
        {back ? (
          <Link
            href={back.href}
            className="focus-ring -ml-1.5 mb-3 inline-flex items-center gap-1 rounded-full py-1 pr-2.5 pl-1.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <ChevronLeft className="size-3.5" />
            {back.label}
          </Link>
        ) : null}
        <h1 className="text-[28px] leading-[1.1] font-semibold tracking-[-0.03em] sm:text-[34px]">{title}</h1>
        {description ? <p className="mt-2 max-w-2xl text-[15px] text-muted">{description}</p> : null}
        {meta ? <div className="mt-4 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Large KPI value with label and optional delta / hint. */
export function Stat({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "ion" | "ember" | "danger" | "signal";
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-[13px] text-muted">{label}</span>
      <span
        className={cn(
          "text-[26px] leading-none font-semibold tracking-[-0.03em] tabular",
          tone === "ion" && "text-ion",
          tone === "ember" && "text-ember",
          tone === "danger" && "text-danger",
          tone === "signal" && "text-signal",
        )}
      >
        {value}
      </span>
      {hint ? <span className="truncate text-xs text-subtle">{hint}</span> : null}
    </div>
  );
}
