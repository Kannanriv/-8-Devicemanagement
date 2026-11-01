import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-shimmer rounded-control bg-[linear-gradient(90deg,var(--hover)_0%,var(--press)_40%,var(--hover)_80%)] bg-[length:200%_100%]",
        className,
      )}
    />
  );
}
