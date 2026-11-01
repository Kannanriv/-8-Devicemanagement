"use client";

import * as React from "react";
import { PlugZap, RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorMessage, isOffline } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Elegant offline / error state for any failed query. */
export function ApiError({
  error,
  onRetry,
  className,
  compact,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
}) {
  const offline = isOffline(error);
  if (compact) {
    return (
      <div className={cn("flex items-center gap-2 text-sm text-muted", className)}>
        {offline ? <PlugZap className="size-4 text-ember" /> : <TriangleAlert className="size-4 text-danger" />}
        <span className="truncate">{offline ? "API offline" : errorMessage(error)}</span>
        {onRetry ? (
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center gap-3 px-6 py-14 text-center", className)}>
      <div
        className={cn(
          "mb-1 flex size-12 items-center justify-center rounded-2xl ring-1 ring-inset",
          offline ? "bg-ember/10 ring-ember/25" : "bg-danger/10 ring-danger/25",
        )}
      >
        {offline ? <PlugZap className="size-5 text-ember" /> : <TriangleAlert className="size-5 text-danger" />}
      </div>
      <p className="text-[15px] font-semibold tracking-[-0.015em]">
        {offline ? "API offline" : "Couldn’t load this"}
      </p>
      <div className="max-w-sm text-sm text-muted">
        {offline ? (
          <>
            Start it with{" "}
            <code className="rounded-md bg-hover px-1.5 py-0.5 font-mono text-[12.5px] text-fg ring-1 ring-line ring-inset">
              npm run dev:api
            </code>{" "}
            from the repo root. This view reconnects automatically.
          </>
        ) : (
          errorMessage(error)
        )}
      </div>
      {onRetry ? (
        <Button size="sm" variant="secondary" onClick={onRetry} className="mt-2">
          <RotateCw />
          Try again
        </Button>
      ) : null}
    </div>
  );
}

type QueryLike<T> = {
  data: T | undefined;
  error: unknown;
  isPending: boolean;
  refetch: () => unknown;
};

/**
 * Renders loading → error → empty → content for a React Query result.
 * `isEmpty` decides whether to show `empty` instead of children.
 */
export function QueryView<T>({
  query,
  loading,
  empty,
  isEmpty,
  children,
  errorClassName,
}: {
  query: QueryLike<T>;
  loading: React.ReactNode;
  empty?: React.ReactNode;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => React.ReactNode;
  errorClassName?: string;
}) {
  if (query.isPending) return <>{loading}</>;
  if (query.error || query.data === undefined)
    return <ApiError error={query.error} onRetry={() => void query.refetch()} className={errorClassName} />;
  if (empty && isEmpty?.(query.data)) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
